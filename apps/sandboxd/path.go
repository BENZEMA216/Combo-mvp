package main

import (
	"errors"
	"strings"
	"unicode/utf8"
)

const (
	maxPathBytes = 1024
	maxPathDepth = 32
)

var errInvalidPath = errors.New("invalid workspace path")

func validateWorkspacePath(value string) ([]string, error) {
	if value == "" || len(value) > maxPathBytes || !utf8.ValidString(value) {
		return nil, errInvalidPath
	}
	if strings.HasPrefix(value, "/") || strings.ContainsRune(value, '\x00') || strings.Contains(value, "\\") {
		return nil, errInvalidPath
	}
	parts := strings.Split(value, "/")
	if len(parts) > maxPathDepth {
		return nil, errInvalidPath
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, errInvalidPath
		}
	}
	return parts, nil
}
