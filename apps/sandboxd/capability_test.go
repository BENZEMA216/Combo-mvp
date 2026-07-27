package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func signCapabilityForTest(
	t *testing.T,
	privateKey ed25519.PrivateKey,
	claims map[string]any,
) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": "EdDSA", "typ": "JWT"})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	encodedHeader := base64.RawURLEncoding.EncodeToString(header)
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	message := encodedHeader + "." + encodedPayload
	signature := ed25519.Sign(privateKey, []byte(message))
	return message + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func capabilityFixture(t *testing.T) (*capabilityVerifier, ed25519.PrivateKey, time.Time) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	verifier := &capabilityVerifier{
		publicKey: publicKey,
		issuer:    "combo-runtime",
		audience:  "combo-sandboxd",
		sessionID: "session-1",
		podUID:    "pod-1",
		now:       func() time.Time { return now },
		replays:   newReplayCache(),
	}
	return verifier, privateKey, now
}

func validClaims(now time.Time, body []byte) map[string]any {
	return map[string]any{
		"iss":        "combo-runtime",
		"aud":        "combo-sandboxd",
		"sid":        "session-1",
		"puid":       "pod-1",
		"op":         "write",
		"rid":        "request-1",
		"iat":        now.Unix(),
		"nbf":        now.Unix() - 1,
		"exp":        now.Unix() + 30,
		"bodySha256": bodyDigest(body),
	}
}

func TestCapabilityVerifierBindsIdentityOperationAndBody(t *testing.T) {
	verifier, privateKey, now := capabilityFixture(t)
	body := []byte(`{"path":"a.txt","content":"safe"}`)
	token := signCapabilityForTest(t, privateKey, validClaims(now, body))
	if err := verifier.verify(token, "write", "request-1", "session-1", "pod-1", body, ""); err != nil {
		t.Fatalf("valid capability rejected: %v", err)
	}
}

func TestCapabilityVerifierRejectsTamperingReplayAndWrongPod(t *testing.T) {
	for _, test := range []struct {
		name      string
		mutate    func(map[string]any)
		body      []byte
		podHeader string
		requestID string
		operation string
		target    string
	}{
		{name: "body", body: []byte(`{"changed":true}`), podHeader: "pod-1", requestID: "request-1", operation: "write"},
		{name: "pod claim", mutate: func(claims map[string]any) { claims["puid"] = "pod-2" }, podHeader: "pod-1", requestID: "request-1", operation: "write"},
		{name: "operation", podHeader: "pod-1", requestID: "request-1", operation: "read"},
		{name: "request id", podHeader: "pod-1", requestID: "request-2", operation: "write"},
	} {
		t.Run(test.name, func(t *testing.T) {
			verifier, privateKey, now := capabilityFixture(t)
			original := []byte(`{"path":"a.txt","content":"safe"}`)
			claims := validClaims(now, original)
			if test.mutate != nil {
				test.mutate(claims)
			}
			token := signCapabilityForTest(t, privateKey, claims)
			body := original
			if test.body != nil {
				body = test.body
			}
			if err := verifier.verify(token, test.operation, test.requestID, "session-1", test.podHeader, body, test.target); err == nil {
				t.Fatal("tampered capability was accepted")
			}
		})
	}

	verifier, privateKey, now := capabilityFixture(t)
	body := []byte(`{}`)
	claims := validClaims(now, body)
	claims["op"] = "describe"
	token := signCapabilityForTest(t, privateKey, claims)
	if err := verifier.verify(token, "describe", "request-1", "session-1", "pod-1", body, ""); err != nil {
		t.Fatal(err)
	}
	if err := verifier.verify(token, "describe", "request-1", "session-1", "pod-1", body, ""); err == nil {
		t.Fatal("replayed capability was accepted")
	}
}

func TestCapabilityVerifierRejectsExpiredAndLongLivedTokens(t *testing.T) {
	for _, mutate := range []func(map[string]any){
		func(claims map[string]any) { claims["exp"] = int64(1_799_999_999) },
		func(claims map[string]any) { claims["exp"] = int64(1_800_000_120) },
		func(claims map[string]any) { claims["nbf"] = int64(1_800_000_031) },
	} {
		verifier, privateKey, now := capabilityFixture(t)
		body := []byte(`{}`)
		claims := validClaims(now, body)
		mutate(claims)
		token := signCapabilityForTest(t, privateKey, claims)
		if err := verifier.verify(token, "write", "request-1", "session-1", "pod-1", body, ""); err == nil {
			t.Fatal("invalid lifetime was accepted")
		}
	}
}
