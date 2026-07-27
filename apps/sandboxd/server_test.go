package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeWorkspace struct {
	content string
}

func (workspace *fakeWorkspace) readFile(_ string, _, _ int64) ([]byte, int64, error) {
	return []byte(workspace.content), int64(len(workspace.content)), nil
}
func (workspace *fakeWorkspace) writeFile(_ string, data []byte, _ bool, _ int64) error {
	workspace.content = string(data)
	return nil
}
func (workspace *fakeWorkspace) editFile(_, oldText, newText string, _ bool, _ int64) (int, error) {
	workspace.content = strings.Replace(workspace.content, oldText, newText, 1)
	return 1, nil
}
func (workspace *fakeWorkspace) close() error { return nil }

type fakeCommands struct {
	cancelled     string
	cancelStarted chan struct{}
	cancelRelease chan struct{}
	cancelError   error
}

func (commands *fakeCommands) run(
	_ context.Context,
	request commandRequest,
	emit func(commandFrame) error,
) error {
	exit := 0
	if err := emit(commandFrame{Type: "start", CommandID: request.CommandID}); err != nil {
		return err
	}
	if err := emit(commandFrame{
		Type:      "output",
		CommandID: request.CommandID,
		Stream:    "stdout",
		Encoding:  "base64",
		Data:      "b2sK",
	}); err != nil {
		return err
	}
	return emit(commandFrame{Type: "exit", CommandID: request.CommandID, ExitCode: &exit})
}
func (commands *fakeCommands) cancel(ctx context.Context, commandID string) (bool, error) {
	commands.cancelled = commandID
	if commands.cancelStarted != nil {
		close(commands.cancelStarted)
	}
	if commands.cancelRelease != nil {
		select {
		case <-commands.cancelRelease:
		case <-ctx.Done():
			return true, ctx.Err()
		}
	}
	return true, commands.cancelError
}
func (commands *fakeCommands) close() {}

type serverFixture struct {
	server     *server
	privateKey ed25519.PrivateKey
}

func newServerFixture(t *testing.T) serverFixture {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	config := Config{
		SessionID:       "session-1",
		PodUID:          "pod-1",
		Issuer:          "combo-runtime",
		Audience:        "combo-sandboxd",
		PublicKey:       publicKey,
		CommandTimeout:  120 * time.Second,
		MaxCommandTime:  300 * time.Second,
		MaxRequestBody:  defaultMaxRequestBody,
		MaxFileBytes:    defaultMaxFileBytes,
		MaxReadBytes:    defaultMaxReadBytes,
		MaxOutputBytes:  defaultMaxOutputBytes,
		MaxOutputFrames: defaultMaxOutputFrames,
		MaxFrameBytes:   defaultMaxFrameBytes,
	}
	server := newServerWithDependencies(config, &fakeWorkspace{content: "hello"}, &fakeCommands{})
	server.logger = log.New(io.Discard, "", 0)
	return serverFixture{server: server, privateKey: privateKey}
}

func (fixture serverFixture) request(
	t *testing.T,
	operation string,
	path string,
	body []byte,
	target string,
) *http.Request {
	t.Helper()
	requestID := "request-" + operation
	now := time.Now().Unix()
	claims := map[string]any{
		"iss":        "combo-runtime",
		"aud":        "combo-sandboxd",
		"sid":        "session-1",
		"puid":       "pod-1",
		"op":         operation,
		"rid":        requestID,
		"iat":        now,
		"nbf":        now - 1,
		"exp":        now + 30,
		"bodySha256": bodyDigest(body),
	}
	if target != "" {
		claims["target"] = target
	}
	token := signCapabilityForTest(t, fixture.privateKey, claims)
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set(headerRequestID, requestID)
	request.Header.Set(headerSessionID, "session-1")
	request.Header.Set(headerPodUID, "pod-1")
	request.Header.Set("Content-Type", "application/json")
	return request
}

func TestHealthIsUnauthenticatedAndDescribeIsAuthenticated(t *testing.T) {
	fixture := newServerFixture(t)
	health := httptest.NewRecorder()
	fixture.server.handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/health", nil))
	if health.Code != http.StatusOK || !strings.Contains(health.Body.String(), `"status":"ok"`) {
		t.Fatalf("unexpected health response: %d %s", health.Code, health.Body.String())
	}

	unauthorized := httptest.NewRecorder()
	fixture.server.handler.ServeHTTP(
		unauthorized,
		httptest.NewRequest(http.MethodPost, "/v1/describe", strings.NewReader(`{}`)),
	)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("describe without capability returned %d", unauthorized.Code)
	}

	body := []byte(`{}`)
	describe := httptest.NewRecorder()
	fixture.server.handler.ServeHTTP(
		describe,
		fixture.request(t, "describe", "/v1/describe", body, ""),
	)
	if describe.Code != http.StatusOK {
		t.Fatalf("describe returned %d: %s", describe.Code, describe.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(describe.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response["sessionId"] != "session-1" || response["podUid"] != "pod-1" || response["commandOutputEncoding"] != "base64" {
		t.Fatalf("describe identity mismatch: %#v", response)
	}
}

func TestAuthenticatedFileAndCommandContract(t *testing.T) {
	fixture := newServerFixture(t)
	for _, test := range []struct {
		operation string
		path      string
		body      string
		contains  string
	}{
		{operation: "read", path: "/v1/files/read", body: `{"path":"a.txt"}`, contains: "hello"},
		{operation: "write", path: "/v1/files/write", body: `{"path":"a.txt","content":"new"}`, contains: "writtenBytes"},
		{operation: "edit", path: "/v1/files/edit", body: `{"path":"a.txt","oldText":"new","newText":"done"}`, contains: "replacements"},
		{operation: "command", path: "/v1/commands", body: `{"commandId":"command-1","command":"echo ok"}`, contains: `"type":"exit"`},
	} {
		recorder := httptest.NewRecorder()
		body := []byte(test.body)
		fixture.server.handler.ServeHTTP(
			recorder,
			fixture.request(t, test.operation, test.path, body, ""),
		)
		if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), test.contains) {
			t.Fatalf("%s returned %d: %s", test.operation, recorder.Code, recorder.Body.String())
		}
	}
}

func TestCancelBindsCapabilityAndBodyToTargetCommand(t *testing.T) {
	fixture := newServerFixture(t)
	body := []byte(`{"commandId":"command-1"}`)
	recorder := httptest.NewRecorder()
	fixture.server.handler.ServeHTTP(
		recorder,
		fixture.request(
			t,
			"cancel",
			"/v1/commands/command-1/cancel",
			body,
			"command-1",
		),
	)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"cancelled":true`) {
		t.Fatalf("cancel returned %d: %s", recorder.Code, recorder.Body.String())
	}

	wrongTarget := httptest.NewRecorder()
	fixture.server.handler.ServeHTTP(
		wrongTarget,
		fixture.request(t, "cancel", "/v1/commands/command-2/cancel", body, "command-1"),
	)
	if wrongTarget.Code != http.StatusUnauthorized {
		t.Fatalf("target mismatch returned %d", wrongTarget.Code)
	}
}

func TestUTF8ReadPagesStopAtCompleteRuneBoundaries(t *testing.T) {
	prefix, ok := utf8PrefixWithin([]byte("a界"), 2)
	if !ok || string(prefix) != "a" {
		t.Fatalf("UTF-8 prefix = %q ok=%t", prefix, ok)
	}
	if _, ok := utf8PrefixWithin([]byte{'a', 0xff, 'b'}, 3); ok {
		t.Fatal("invalid UTF-8 inside the page was accepted")
	}
}

func TestNDJSONWriterEnforcesTheAdvertisedWireFrameLimit(t *testing.T) {
	recorder := httptest.NewRecorder()
	stream, err := newNDJSONWriter(recorder, defaultMaxFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	chunk, err := outputChunkSize(defaultMaxFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.write(commandFrame{
		Type:      "output",
		CommandID: "command-1",
		Stream:    "stdout",
		Encoding:  "base64",
		Data:      base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("x"), chunk)),
	}); err != nil {
		t.Fatalf("bounded escaped frame was rejected: %v", err)
	}
	lines := bytes.Split(bytes.TrimSpace(recorder.Body.Bytes()), []byte("\n"))
	if got := len(lines[len(lines)-1]); got > defaultMaxFrameBytes {
		t.Fatalf("wire frame exceeded limit: %d", got)
	}
	if err := stream.write(commandFrame{
		Type:      "output",
		CommandID: "command-1",
		Stream:    "stdout",
		Data:      strings.Repeat("<", defaultMaxFrameBytes),
	}); !errors.Is(err, errCommandFrameTooLarge) {
		t.Fatalf("oversized wire frame error = %v", err)
	}
}

func TestCancelResponseWaitsForCommandCleanup(t *testing.T) {
	fixture := newServerFixture(t)
	commands := &fakeCommands{cancelStarted: make(chan struct{}), cancelRelease: make(chan struct{})}
	fixture.server.commands = commands
	body := []byte(`{"commandId":"command-1"}`)
	request := fixture.request(t, "cancel", "/v1/commands/command-1/cancel", body, "command-1")
	response := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		recorder := httptest.NewRecorder()
		fixture.server.handler.ServeHTTP(recorder, request)
		response <- recorder
	}()
	select {
	case <-commands.cancelStarted:
	case <-time.After(time.Second):
		t.Fatal("cancel handler did not reach command manager")
	}
	select {
	case <-response:
		t.Fatal("cancel response returned before cleanup completed")
	case <-time.After(20 * time.Millisecond):
	}
	close(commands.cancelRelease)
	select {
	case recorder := <-response:
		if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"cancelled":true`) {
			t.Fatalf("cancel returned %d: %s", recorder.Code, recorder.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("cancel response did not finish after cleanup")
	}
}

func TestUnauthenticatedLoopbackRequestDoesNotLogAttackerRequestID(t *testing.T) {
	fixture := newServerFixture(t)
	var logs bytes.Buffer
	fixture.server.logger = log.New(&logs, "", 0)
	for index, authorization := range []string{"", "Bearer forged-token"} {
		marker := fmt.Sprintf("workspace-secret-exfiltration-marker-%d", index)
		request := httptest.NewRequest(http.MethodPost, "/v1/files/read", strings.NewReader(`{"path":"secret.txt"}`))
		request.Header.Set(headerRequestID, marker)
		if authorization != "" {
			request.Header.Set("Authorization", authorization)
		}
		recorder := httptest.NewRecorder()
		fixture.server.handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("unauthenticated request returned %d", recorder.Code)
		}
		if strings.Contains(recorder.Body.String(), marker) {
			t.Fatalf("unauthenticated request ID reached response: %s", recorder.Body.String())
		}
	}
	fixture.server.config.MaxRequestBody = 8
	oversizedMarker := "workspace-secret-exfiltration-marker-oversized"
	oversized := httptest.NewRequest(http.MethodPost, "/v1/files/read", strings.NewReader(strings.Repeat("x", 32)))
	oversized.Header.Set(headerRequestID, oversizedMarker)
	oversized.Header.Set("Authorization", "Bearer forged-token")
	oversizedRecorder := httptest.NewRecorder()
	fixture.server.handler.ServeHTTP(oversizedRecorder, oversized)
	if oversizedRecorder.Code != http.StatusRequestEntityTooLarge || strings.Contains(oversizedRecorder.Body.String(), oversizedMarker) {
		t.Fatalf("oversized unauthenticated request leaked request ID: %d %s", oversizedRecorder.Code, oversizedRecorder.Body.String())
	}
	if strings.Contains(logs.String(), "workspace-secret-exfiltration-marker") {
		t.Fatalf("unauthenticated request ID reached daemon logs: %s", logs.String())
	}
}

func TestBodyTamperingReturnsOnlyRedactedAuthenticationError(t *testing.T) {
	fixture := newServerFixture(t)
	original := []byte(`{"path":"secret.txt"}`)
	request := fixture.request(t, "read", "/v1/files/read", original, "")
	request.Body = io.NopCloser(strings.NewReader(`{"path":"other.txt"}`))
	recorder := httptest.NewRecorder()
	fixture.server.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("tampered body returned %d", recorder.Code)
	}
	response := recorder.Body.String()
	if strings.Contains(response, "secret.txt") || strings.Contains(response, "other.txt") || strings.Contains(response, "Bearer") {
		t.Fatalf("authentication error leaked request data: %s", response)
	}
}
