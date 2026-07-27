package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	protocolVersion        = "1"
	defaultMaxRequestBody  = int64(8 << 20)
	defaultMaxFileBytes    = int64(512 << 10)
	defaultMaxReadBytes    = int64(256 << 10)
	defaultMaxOutputBytes  = int64(1 << 20)
	defaultMaxOutputFrames = 4096
	// MaxFrameBytes is a wire-level NDJSON frame limit. Process output is chunked
	// conservatively so JSON escaping can never grow a frame beyond this value.
	defaultMaxFrameBytes = 16 << 10
)

func outputChunkSize(maxWireFrameBytes int) (int, error) {
	// Output bytes use standard padded base64 on the wire. Keep fixed metadata
	// and the newline inside the frame cap, and choose a multiple of three so the
	// encoded length is exact.
	const frameOverhead = 512
	if maxWireFrameBytes <= frameOverhead+4 {
		return 0, errors.New("command frame limit is too small")
	}
	return ((maxWireFrameBytes - frameOverhead) / 4) * 3, nil
}

type Config struct {
	Addr            string
	Workspace       string
	CommandWrapper  string
	SessionID       string
	PodUID          string
	Issuer          string
	Audience        string
	PublicKey       ed25519.PublicKey
	CommandTimeout  time.Duration
	MaxCommandTime  time.Duration
	MaxRequestBody  int64
	MaxFileBytes    int64
	MaxReadBytes    int64
	MaxOutputBytes  int64
	MaxOutputFrames int
	MaxFrameBytes   int
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func positiveDurationMillis(name string, fallback, maximum time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	milliseconds, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || milliseconds <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	value := time.Duration(milliseconds) * time.Millisecond
	if maximum > 0 && value > maximum {
		return 0, fmt.Errorf("%s exceeds maximum", name)
	}
	return value, nil
}

func loadConfig() (Config, error) {
	sessionID := strings.TrimSpace(os.Getenv("SANDBOX_SESSION_ID"))
	podUID := strings.TrimSpace(os.Getenv("SANDBOX_POD_UID"))
	publicKeyRaw := strings.TrimSpace(os.Getenv("SANDBOX_CAPABILITY_PUBLIC_KEY"))
	if sessionID == "" || podUID == "" || publicKeyRaw == "" {
		return Config{}, errors.New("sandbox identity configuration is incomplete")
	}
	publicKey, err := parsePublicKey(publicKeyRaw)
	if err != nil {
		return Config{}, errors.New("sandbox capability public key is invalid")
	}
	maxCommandTime := 300 * time.Second
	commandTimeout, err := positiveDurationMillis(
		"SANDBOX_COMMAND_TIMEOUT_MS",
		120*time.Second,
		maxCommandTime,
	)
	if err != nil {
		return Config{}, err
	}
	return Config{
		Addr:            envOr("SANDBOX_LISTEN_ADDR", ":8080"),
		Workspace:       envOr("SANDBOX_WORKSPACE", "/workspace"),
		CommandWrapper:  "/usr/local/bin/sandbox-exec",
		SessionID:       sessionID,
		PodUID:          podUID,
		Issuer:          envOr("SANDBOX_CAPABILITY_ISSUER", "combo-runtime"),
		Audience:        envOr("SANDBOX_CAPABILITY_AUDIENCE", "combo-sandboxd"),
		PublicKey:       publicKey,
		CommandTimeout:  commandTimeout,
		MaxCommandTime:  maxCommandTime,
		MaxRequestBody:  defaultMaxRequestBody,
		MaxFileBytes:    defaultMaxFileBytes,
		MaxReadBytes:    defaultMaxReadBytes,
		MaxOutputBytes:  defaultMaxOutputBytes,
		MaxOutputFrames: defaultMaxOutputFrames,
		MaxFrameBytes:   defaultMaxFrameBytes,
	}, nil
}

func parsePublicKey(value string) (ed25519.PublicKey, error) {
	var der []byte
	if block, _ := pem.Decode([]byte(value)); block != nil {
		der = block.Bytes
	} else {
		decoded, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			decoded, err = base64.RawURLEncoding.DecodeString(value)
			if err != nil {
				return nil, err
			}
		}
		der = decoded
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err == nil {
		key, ok := parsed.(ed25519.PublicKey)
		if !ok || len(key) != ed25519.PublicKeySize {
			return nil, errors.New("not an Ed25519 key")
		}
		return key, nil
	}
	if len(der) == ed25519.PublicKeySize {
		return ed25519.PublicKey(der), nil
	}
	return nil, err
}
