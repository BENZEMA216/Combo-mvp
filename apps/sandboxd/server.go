package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

type workspace interface {
	readFile(path string, offset, limit int64) ([]byte, int64, error)
	writeFile(path string, data []byte, createParents bool, maximum int64) error
	editFile(path, oldText, newText string, replaceAll bool, maximum int64) (int, error)
	close() error
}

type commandRequest struct {
	CommandID string `json:"commandId"`
	Command   string `json:"command"`
	TimeoutMS int64  `json:"timeoutMs,omitempty"`
}

type commandFrame struct {
	Type       string `json:"type"`
	CommandID  string `json:"commandId,omitempty"`
	Stream     string `json:"stream,omitempty"`
	Data       string `json:"data,omitempty"`
	Encoding   string `json:"encoding,omitempty"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	Signal     string `json:"signal,omitempty"`
	TimedOut   bool   `json:"timedOut,omitempty"`
	Cancelled  bool   `json:"cancelled,omitempty"`
	Truncated  bool   `json:"truncated,omitempty"`
	DurationMS int64  `json:"durationMs,omitempty"`
	Error      string `json:"error,omitempty"`
}

var errCommandBusy = errors.New("another command is running")

type commands interface {
	run(context.Context, commandRequest, func(commandFrame) error) error
	cancel(context.Context, string) (bool, error)
	close()
}

type server struct {
	config   Config
	verifier *capabilityVerifier
	files    workspace
	commands commands
	logger   *log.Logger
	handler  http.Handler
}

type errorEnvelope struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"requestId,omitempty"`
	} `json:"error"`
}

func newServer(config Config) (*server, error) {
	files, err := newWorkspaceFS(config.Workspace)
	if err != nil {
		return nil, err
	}
	commands, err := newCommandManager(config)
	if err != nil {
		files.close()
		return nil, err
	}
	return newServerWithDependencies(config, files, commands), nil
}

func newServerWithDependencies(config Config, files workspace, commands commands) *server {
	instance := &server{
		config:   config,
		verifier: newCapabilityVerifier(config),
		files:    files,
		commands: commands,
		logger:   log.New(os.Stdout, "sandboxd ", log.LstdFlags|log.LUTC),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", instance.health)
	mux.HandleFunc("POST /v1/describe", instance.describe)
	mux.HandleFunc("POST /v1/files/read", instance.readFile)
	mux.HandleFunc("POST /v1/files/write", instance.writeFile)
	mux.HandleFunc("POST /v1/files/edit", instance.editFile)
	mux.HandleFunc("POST /v1/commands", instance.runCommand)
	mux.HandleFunc("POST /v1/commands/{commandId}/cancel", instance.cancelCommand)
	instance.handler = securityHeaders(limitConcurrentRequests(mux, 32))
	return instance
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(writer, request)
	})
}

func limitConcurrentRequests(next http.Handler, maximum int) http.Handler {
	semaphore := make(chan struct{}, maximum)
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		select {
		case semaphore <- struct{}{}:
			defer func() { <-semaphore }()
			next.ServeHTTP(writer, request)
		default:
			writeJSON(writer, http.StatusServiceUnavailable, map[string]any{
				"error": map[string]string{"code": "busy", "message": "request rejected"},
			})
		}
	})
}

func (instance *server) close() {
	instance.commands.close()
	_ = instance.files.close()
}

func (instance *server) health(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]string{
		"status":   "ok",
		"protocol": protocolVersion,
	})
}

func bearerToken(value string) (string, bool) {
	prefix := "Bearer "
	if !strings.HasPrefix(value, prefix) {
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(value, prefix))
	return token, token != ""
}

func validRequestID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if !((character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '-' || character == '_') {
			return false
		}
	}
	return true
}

func (instance *server) authenticatedBody(
	writer http.ResponseWriter,
	request *http.Request,
	operation string,
	target string,
) ([]byte, string, bool) {
	requestID := request.Header.Get(headerRequestID)
	if !validRequestID(requestID) {
		instance.writeError(writer, http.StatusUnauthorized, "unauthorized", "request rejected", "")
		return nil, "", false
	}
	token, ok := bearerToken(request.Header.Get("Authorization"))
	if !ok {
		// A model command can reach sandboxd over Pod loopback. Reject missing
		// credentials before reading its body and never log attacker-controlled IDs.
		instance.writeError(writer, http.StatusUnauthorized, "unauthorized", "request rejected", "")
		return nil, "", false
	}
	request.Body = http.MaxBytesReader(writer, request.Body, instance.config.MaxRequestBody)
	body, err := io.ReadAll(request.Body)
	if err != nil {
		// The body hash cannot be verified when the body exceeds the limit, so the
		// caller-controlled request id is still unauthenticated at this point.
		instance.writeError(writer, http.StatusRequestEntityTooLarge, "request_too_large", "request rejected", "")
		return nil, "", false
	}
	if instance.verifier.verify(
		token,
		operation,
		requestID,
		request.Header.Get(headerSessionID),
		request.Header.Get(headerPodUID),
		body,
		target,
	) != nil {
		instance.writeError(writer, http.StatusUnauthorized, "unauthorized", "request rejected", "")
		return nil, requestID, false
	}
	return body, requestID, true
}

func decodeStrict(body []byte, output any) error {
	if !utf8.Valid(body) {
		return errors.New("request body is not UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}

func (instance *server) describe(writer http.ResponseWriter, request *http.Request) {
	body, requestID, ok := instance.authenticatedBody(writer, request, "describe", "")
	if !ok {
		return
	}
	var input struct{}
	if decodeStrict(body, &input) != nil {
		instance.writeError(writer, http.StatusBadRequest, "invalid_request", "request rejected", requestID)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"protocolVersion":       protocolVersion,
		"sessionId":             instance.config.SessionID,
		"podUid":                instance.config.PodUID,
		"workspace":             "/workspace",
		"commandOutputEncoding": "base64",
		"operations":            []string{"describe", "read", "write", "edit", "command", "cancel"},
		"limits": map[string]any{
			"maxRequestBytes":  instance.config.MaxRequestBody,
			"maxReadBytes":     instance.config.MaxReadBytes,
			"maxFileBytes":     instance.config.MaxFileBytes,
			"maxOutputBytes":   instance.config.MaxOutputBytes,
			"maxOutputFrames":  instance.config.MaxOutputFrames,
			"maxFrameBytes":    instance.config.MaxFrameBytes,
			"commandTimeoutMs": instance.config.CommandTimeout.Milliseconds(),
			"maxCommandTimeMs": instance.config.MaxCommandTime.Milliseconds(),
		},
	})
	instance.logger.Printf("op=describe request_id=%s status=ok", requestID)
}

type readRequest struct {
	Path   string `json:"path"`
	Offset int64  `json:"offset,omitempty"`
	Limit  int64  `json:"limit,omitempty"`
}

func utf8PrefixWithin(data []byte, limit int64) ([]byte, bool) {
	position := 0
	for position < len(data) && int64(position) < limit {
		if !utf8.FullRune(data[position:]) {
			return nil, false
		}
		runeValue, size := utf8.DecodeRune(data[position:])
		if runeValue == utf8.RuneError && size == 1 {
			return nil, false
		}
		if int64(position+size) > limit {
			return data[:position], true
		}
		position += size
	}
	return data[:position], true
}

func (instance *server) readFile(writer http.ResponseWriter, request *http.Request) {
	body, requestID, ok := instance.authenticatedBody(writer, request, "read", "")
	if !ok {
		return
	}
	input := readRequest{Limit: instance.config.MaxReadBytes}
	if decodeStrict(body, &input) != nil || input.Offset < 0 || input.Limit < utf8.UTFMax || input.Limit > instance.config.MaxReadBytes {
		instance.writeError(writer, http.StatusBadRequest, "invalid_request", "request rejected", requestID)
		return
	}
	// Read up to three look-ahead bytes, then return the largest complete UTF-8
	// prefix within the requested byte budget. A normal page boundary therefore
	// never turns a valid multibyte text file into a false non_text_file error.
	data, size, err := instance.files.readFile(input.Path, input.Offset, input.Limit+utf8.UTFMax-1)
	if err != nil {
		instance.writeFileError(writer, requestID, err)
		return
	}
	data, valid := utf8PrefixWithin(data, input.Limit)
	if !valid {
		instance.writeError(writer, http.StatusUnprocessableEntity, "non_text_file", "file is not UTF-8 text", requestID)
		return
	}
	actualOffset := input.Offset
	if actualOffset > size {
		actualOffset = size
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"content":   string(data),
		"sizeBytes": size,
		"offset":    actualOffset,
		"truncated": actualOffset+int64(len(data)) < size,
	})
	instance.logger.Printf("op=read request_id=%s status=ok bytes=%d", requestID, len(data))
}

type writeRequest struct {
	Path          string `json:"path"`
	Content       string `json:"content"`
	CreateParents bool   `json:"createParents,omitempty"`
}

func (instance *server) writeFile(writer http.ResponseWriter, request *http.Request) {
	body, requestID, ok := instance.authenticatedBody(writer, request, "write", "")
	if !ok {
		return
	}
	var input writeRequest
	if decodeStrict(body, &input) != nil {
		instance.writeError(writer, http.StatusBadRequest, "invalid_request", "request rejected", requestID)
		return
	}
	data := []byte(input.Content)
	if err := instance.files.writeFile(input.Path, data, input.CreateParents, instance.config.MaxFileBytes); err != nil {
		instance.writeFileError(writer, requestID, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"writtenBytes": len(data)})
	instance.logger.Printf("op=write request_id=%s status=ok bytes=%d", requestID, len(data))
}

type editRequest struct {
	Path       string `json:"path"`
	OldText    string `json:"oldText"`
	NewText    string `json:"newText"`
	ReplaceAll bool   `json:"replaceAll,omitempty"`
}

func (instance *server) editFile(writer http.ResponseWriter, request *http.Request) {
	body, requestID, ok := instance.authenticatedBody(writer, request, "edit", "")
	if !ok {
		return
	}
	var input editRequest
	if decodeStrict(body, &input) != nil {
		instance.writeError(writer, http.StatusBadRequest, "invalid_request", "request rejected", requestID)
		return
	}
	replacements, err := instance.files.editFile(
		input.Path,
		input.OldText,
		input.NewText,
		input.ReplaceAll,
		instance.config.MaxFileBytes,
	)
	if err != nil {
		instance.writeFileError(writer, requestID, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"replacements": replacements})
	instance.logger.Printf("op=edit request_id=%s status=ok replacements=%d", requestID, replacements)
}

func validCommandID(value string) bool { return validRequestID(value) }

func (instance *server) runCommand(writer http.ResponseWriter, request *http.Request) {
	body, requestID, ok := instance.authenticatedBody(writer, request, "command", "")
	if !ok {
		return
	}
	var input commandRequest
	if decodeStrict(body, &input) != nil || !validCommandID(input.CommandID) || strings.TrimSpace(input.Command) == "" || len(input.Command) > 64<<10 {
		instance.writeError(writer, http.StatusBadRequest, "invalid_request", "request rejected", requestID)
		return
	}
	if input.TimeoutMS > instance.config.MaxCommandTime.Milliseconds() || input.TimeoutMS < 0 {
		instance.writeError(writer, http.StatusBadRequest, "invalid_timeout", "command timeout is invalid", requestID)
		return
	}
	stream, err := newNDJSONWriter(writer, instance.config.MaxFrameBytes)
	if err != nil {
		instance.writeError(writer, http.StatusInternalServerError, "stream_unavailable", "command stream unavailable", requestID)
		return
	}
	err = instance.commands.run(request.Context(), input, stream.write)
	if err != nil {
		code := "command_failed"
		if errors.Is(err, errCommandBusy) {
			code = "command_busy"
		} else if errors.Is(err, errProcessCleanup) {
			code = "process_cleanup_failed"
		}
		_ = stream.write(commandFrame{Type: "error", CommandID: input.CommandID, Error: code})
		instance.logger.Printf("op=command request_id=%s status=%s", requestID, code)
		return
	}
	instance.logger.Printf("op=command request_id=%s status=done", requestID)
}

type cancelRequest struct {
	CommandID string `json:"commandId"`
}

func (instance *server) cancelCommand(writer http.ResponseWriter, request *http.Request) {
	target := request.PathValue("commandId")
	body, requestID, ok := instance.authenticatedBody(writer, request, "cancel", target)
	if !ok {
		return
	}
	var input cancelRequest
	if decodeStrict(body, &input) != nil || !validCommandID(input.CommandID) || input.CommandID != target {
		instance.writeError(writer, http.StatusBadRequest, "invalid_request", "request rejected", requestID)
		return
	}
	cancelled, err := instance.commands.cancel(request.Context(), input.CommandID)
	if err != nil {
		code := "cancel_failed"
		if errors.Is(err, errProcessCleanup) {
			code = "process_cleanup_failed"
		}
		instance.writeError(writer, http.StatusServiceUnavailable, code, "command cleanup failed", requestID)
		instance.logger.Printf("op=cancel request_id=%s status=%s", requestID, code)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"cancelled": cancelled})
	instance.logger.Printf("op=cancel request_id=%s status=ok cancelled=%t", requestID, cancelled)
}

func (instance *server) writeFileError(writer http.ResponseWriter, requestID string, err error) {
	message := err.Error()
	switch {
	case errors.Is(err, errInvalidPath) || errors.Is(err, syscall.ELOOP):
		instance.writeError(writer, http.StatusBadRequest, "invalid_path", "workspace path is invalid", requestID)
	case errors.Is(err, os.ErrNotExist):
		instance.writeError(writer, http.StatusNotFound, "not_found", "workspace file was not found", requestID)
	case strings.Contains(message, "exceeds limit"):
		instance.writeError(writer, http.StatusRequestEntityTooLarge, "file_too_large", "file exceeds size limit", requestID)
	case strings.Contains(message, "not unique") || strings.Contains(message, "not found") || strings.Contains(message, "must not be empty"):
		instance.writeError(writer, http.StatusConflict, "edit_conflict", "edit precondition did not match", requestID)
	default:
		instance.writeError(writer, http.StatusUnprocessableEntity, "file_operation_failed", "file operation failed", requestID)
	}
	instance.logger.Printf("op=file request_id=%s status=failed", requestID)
}

func (instance *server) writeError(writer http.ResponseWriter, status int, code, message, requestID string) {
	body := errorEnvelope{}
	body.Error.Code = code
	body.Error.Message = message
	body.Error.RequestID = requestID
	writeJSON(writer, status, body)
}

func writeJSON(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(body)
}

func httpServer(config Config, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              config.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		// The command manager owns the semantic timeout. This larger transport bound
		// also prevents a peer that stops reading from pinning a handler forever.
		WriteTimeout:   config.MaxCommandTime + 30*time.Second,
		IdleTimeout:    30 * time.Second,
		MaxHeaderBytes: 16 << 10,
		ErrorLog:       log.New(io.Discard, "", 0),
	}
}

func shutdownServer(server *http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		_ = server.Close()
	}
}

func validateServerConfig(config Config) error {
	if config.MaxRequestBody <= 0 || config.MaxFileBytes <= 0 || config.MaxReadBytes <= 0 || config.MaxOutputBytes <= 0 || config.MaxOutputFrames <= 0 || config.MaxFrameBytes <= 0 {
		return fmt.Errorf("sandbox limits must be positive")
	}
	return nil
}
