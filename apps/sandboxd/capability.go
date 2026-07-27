package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	headerSessionID = "X-Sandbox-Session-Id"
	headerPodUID    = "X-Sandbox-Pod-Uid"
	headerRequestID = "X-Request-Id"
)

type capabilityClaims struct {
	Issuer     string          `json:"iss"`
	Audience   json.RawMessage `json:"aud"`
	SessionID  string          `json:"sid"`
	PodUID     string          `json:"puid"`
	Operation  string          `json:"op"`
	RequestID  string          `json:"rid"`
	BodySHA256 string          `json:"bodySha256"`
	Target     string          `json:"target,omitempty"`
	IssuedAt   int64           `json:"iat"`
	NotBefore  int64           `json:"nbf"`
	ExpiresAt  int64           `json:"exp"`
}

type replayCache struct {
	mu      sync.Mutex
	entries map[string]time.Time
}

func newReplayCache() *replayCache {
	return &replayCache{entries: make(map[string]time.Time)}
}

func (cache *replayCache) use(requestID string, expiresAt time.Time, now time.Time) bool {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	for key, expiry := range cache.entries {
		if !expiry.After(now) {
			delete(cache.entries, key)
		}
	}
	if _, exists := cache.entries[requestID]; exists {
		return false
	}
	cache.entries[requestID] = expiresAt
	return true
}

type capabilityVerifier struct {
	publicKey ed25519.PublicKey
	issuer    string
	audience  string
	sessionID string
	podUID    string
	now       func() time.Time
	replays   *replayCache
}

func newCapabilityVerifier(config Config) *capabilityVerifier {
	return &capabilityVerifier{
		publicKey: config.PublicKey,
		issuer:    config.Issuer,
		audience:  config.Audience,
		sessionID: config.SessionID,
		podUID:    config.PodUID,
		now:       time.Now,
		replays:   newReplayCache(),
	}
}

func bodyDigest(body []byte) string {
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

func decodeSegment(segment string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(segment)
}

func audienceContains(raw json.RawMessage, expected string) bool {
	var single string
	if json.Unmarshal(raw, &single) == nil {
		return single == expected
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		for _, value := range many {
			if value == expected {
				return true
			}
		}
	}
	return false
}

func (verifier *capabilityVerifier) verify(
	token string,
	operation string,
	requestID string,
	sessionHeader string,
	podHeader string,
	body []byte,
	target string,
) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return errors.New("malformed capability")
	}
	headerBytes, err := decodeSegment(parts[0])
	if err != nil {
		return errors.New("malformed capability")
	}
	var header struct {
		Algorithm string `json:"alg"`
		Type      string `json:"typ"`
	}
	if json.Unmarshal(headerBytes, &header) != nil || header.Algorithm != "EdDSA" || header.Type != "JWT" {
		return errors.New("unsupported capability")
	}
	signature, err := decodeSegment(parts[2])
	if err != nil || !ed25519.Verify(verifier.publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		return errors.New("invalid capability")
	}
	claimsBytes, err := decodeSegment(parts[1])
	if err != nil {
		return errors.New("malformed capability")
	}
	var claims capabilityClaims
	if json.Unmarshal(claimsBytes, &claims) != nil {
		return errors.New("malformed capability")
	}
	now := verifier.now()
	nowUnix := now.Unix()
	if claims.Issuer != verifier.issuer || !audienceContains(claims.Audience, verifier.audience) {
		return errors.New("capability scope mismatch")
	}
	if claims.SessionID != verifier.sessionID || claims.PodUID != verifier.podUID {
		return errors.New("capability identity mismatch")
	}
	if sessionHeader != verifier.sessionID || podHeader != verifier.podUID {
		return errors.New("request identity mismatch")
	}
	if claims.Operation != operation || claims.RequestID == "" || claims.RequestID != requestID {
		return errors.New("capability operation mismatch")
	}
	if target != claims.Target || claims.BodySHA256 != bodyDigest(body) {
		return errors.New("capability request mismatch")
	}
	if claims.IssuedAt <= 0 || claims.NotBefore <= 0 || claims.ExpiresAt <= 0 {
		return errors.New("capability lifetime missing")
	}
	if claims.IssuedAt > nowUnix+5 || claims.NotBefore > nowUnix+5 || claims.ExpiresAt <= nowUnix {
		return errors.New("capability expired")
	}
	if claims.NotBefore > claims.ExpiresAt || claims.ExpiresAt < claims.IssuedAt || claims.ExpiresAt-claims.IssuedAt > 60 || claims.IssuedAt < nowUnix-60 {
		return errors.New("capability lifetime invalid")
	}
	if !verifier.replays.use(claims.RequestID, time.Unix(claims.ExpiresAt, 0), now) {
		return fmt.Errorf("capability replay")
	}
	return nil
}
