// Mint a Gnomon embed token. Go 1.21+, ZERO dependencies (stdlib only).
//
// This is the code your portal's backend runs to tell Gnomon who is looking
// at the calendar. Gnomon has no accounts and issues nothing (ADR-0004); it
// verifies what you sign here and inherits your identity model.
//
// Copy this file. It needs no go.mod and no JWT library -- crypto/ed25519 is
// in the standard library, and a JWT is three base64url segments joined by
// dots.
//
//	go run mint.go --key private.pem --kid portal-2026-08 \
//	  --tenant acme --subject resident-42 \
//	  --calendars cal-maintenance,cal-community --scopes events:read
//
// Prints the token to stdout. Hand it to the embed; never to the browser
// before the user is authenticated on your side.
package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"
)

// How long a token is valid. Keep this SHORT.
//
// Gnomon has no revocation list: a leaked token is valid until it expires and
// nothing can call it back. Five minutes bounds the damage, and the embed
// refreshes silently, so users never notice. Gnomon rejects anything over 15
// minutes outright.
const defaultTTLSeconds = 300

type header struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
	// Tells Gnomon WHICH of your registered keys signed this. Required.
	// It is also what makes key rotation possible without downtime: register
	// the new key, start sending the new kid, then retire the old one.
	Kid string `json:"kid"`
}

type payload struct {
	Aud string `json:"aud"`
	// Opaque to Gnomon. It never learns a name or an email from this -- use
	// your own internal user id, not something personally identifying.
	Sub string `json:"sub"`
	Tid string `json:"tid"`
	// The calendars this user may see. An empty list grants NOTHING, so be
	// explicit; Gnomon will not infer access from the tenant alone.
	Cal []string `json:"cal"`
	Scp []string `json:"scp"`
	Iat int64    `json:"iat"`
	Exp int64    `json:"exp"`
}

// MintOptions mirrors the Node reference implementation field for field, so
// the two can be compared side by side.
type MintOptions struct {
	PrivateKey  ed25519.PrivateKey
	Kid         string
	TenantID    string
	Subject     string
	CalendarIDs []string
	Scopes      []string
	TTLSeconds  int
	Audience    string
	Now         time.Time
}

// RFC 7515 base64url: no padding, URL-safe alphabet.
func b64(raw []byte) string {
	return base64.RawURLEncoding.EncodeToString(raw)
}

// MintToken builds and signs the token.
func MintToken(opts MintOptions) (string, error) {
	issuedAt := opts.Now.Unix()

	// Marshal to JSON rather than string-building: escaping a title or a
	// tenant id by hand is exactly the kind of thing that works until someone
	// has a quote mark in their name.
	headerJSON, err := json.Marshal(header{Alg: "EdDSA", Typ: "JWT", Kid: opts.Kid})
	if err != nil {
		return "", fmt.Errorf("encoding header: %w", err)
	}

	// Non-nil slices, so an empty list marshals as [] rather than null.
	// Gnomon treats both as granting nothing, but [] is what the contract says.
	calendars := opts.CalendarIDs
	if calendars == nil {
		calendars = []string{}
	}
	scopes := opts.Scopes
	if scopes == nil {
		scopes = []string{}
	}

	payloadJSON, err := json.Marshal(payload{
		Aud: opts.Audience,
		Sub: opts.Subject,
		Tid: opts.TenantID,
		Cal: calendars,
		Scp: scopes,
		Iat: issuedAt,
		Exp: issuedAt + int64(opts.TTLSeconds),
	})
	if err != nil {
		return "", fmt.Errorf("encoding payload: %w", err)
	}

	signingInput := b64(headerJSON) + "." + b64(payloadJSON)

	// ed25519.Sign hashes internally; there is no digest to choose and no
	// nonce to get wrong. That determinism is why ADR-0009 picked it over
	// ECDSA.
	signature := ed25519.Sign(opts.PrivateKey, []byte(signingInput))

	return signingInput + "." + b64(signature), nil
}

// LoadPrivateKey reads a PKCS#8 PEM file, as written by keygen.mjs or by
// `openssl genpkey -algorithm ed25519`.
func LoadPrivateKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("%s is not PEM", path)
	}

	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}

	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		// A friendlier failure than signing with the wrong algorithm and
		// having Gnomon reject every token for reasons you cannot see.
		return nil, fmt.Errorf("%s holds a %T, not an Ed25519 key", path, parsed)
	}
	return key, nil
}

func splitList(value string) []string {
	if value == "" {
		return []string{}
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func main() {
	keyPath := flag.String("key", "", "path to the Ed25519 private key (PKCS#8 PEM)")
	kid := flag.String("kid", "", "key id registered with Gnomon")
	tenant := flag.String("tenant", "", "tenant id")
	subject := flag.String("subject", "", "opaque subject id (your own user id)")
	calendars := flag.String("calendars", "", "comma-separated calendar ids")
	scopes := flag.String("scopes", "events:read", "comma-separated scopes")
	ttl := flag.Int("ttl", defaultTTLSeconds, "token lifetime in seconds")
	audience := flag.String("audience", "gnomon", "expected audience")
	flag.Parse()

	if *keyPath == "" || *kid == "" || *tenant == "" || *subject == "" {
		fmt.Fprintln(os.Stderr, "Missing required argument(s): --key, --kid, --tenant, --subject")
		flag.Usage()
		os.Exit(2)
	}

	privateKey, err := LoadPrivateKey(*keyPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	token, err := MintToken(MintOptions{
		PrivateKey:  privateKey,
		Kid:         *kid,
		TenantID:    *tenant,
		Subject:     *subject,
		CalendarIDs: splitList(*calendars),
		Scopes:      splitList(*scopes),
		TTLSeconds:  *ttl,
		Audience:    *audience,
		Now:         time.Now(),
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	fmt.Print(token)
}
