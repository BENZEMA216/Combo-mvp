package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"
)

const streamWriteTimeout = 5 * time.Second

var errCommandFrameTooLarge = errors.New("command frame exceeds wire limit")

type ndjsonWriter struct {
	mu            sync.Mutex
	writer        http.ResponseWriter
	maxFrameBytes int
	closed        bool
}

func newNDJSONWriter(writer http.ResponseWriter, maxFrameBytes int) (*ndjsonWriter, error) {
	_, ok := writer.(http.Flusher)
	if !ok || maxFrameBytes <= 0 {
		return nil, errors.New("streaming unsupported")
	}
	writer.Header().Set("Content-Type", "application/x-ndjson")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	_ = http.NewResponseController(writer).SetWriteDeadline(time.Now().Add(streamWriteTimeout))
	writer.WriteHeader(http.StatusOK)
	if err := http.NewResponseController(writer).Flush(); err != nil {
		return nil, err
	}
	return &ndjsonWriter{writer: writer, maxFrameBytes: maxFrameBytes}, nil
}

func (stream *ndjsonWriter) write(frame commandFrame) error {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.closed {
		return errors.New("stream closed")
	}
	encoded, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	if len(encoded) > stream.maxFrameBytes {
		return errCommandFrameTooLarge
	}
	_ = http.NewResponseController(stream.writer).SetWriteDeadline(
		time.Now().Add(streamWriteTimeout),
	)
	if _, err := stream.writer.Write(encoded); err != nil {
		stream.closed = true
		return err
	}
	if err := http.NewResponseController(stream.writer).Flush(); err != nil {
		stream.closed = true
		return err
	}
	return nil
}
