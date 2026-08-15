# Token-minting cookbook

Gnomon has no accounts, no login, and no password reset. Your portal already
knows who its users are; Gnomon inherits that. Your backend signs a
short-lived token saying "this person may see these calendars," and Gnomon
verifies it.

This is what makes a free-to-embed calendar economically real, and it is the
one thing you have to implement. It is about twenty lines.

> **You need a backend.** Minting requires a private key, so a purely static
> site cannot embed Gnomon safely. There is no version of this where the
> browser holds the signing key — that would be a public write endpoint with
> extra steps.

---

## 1. Generate a key pair

```bash
node keygen.mjs --out ./keys --kid portal-2026-08
```

You get two files:

| File | What to do with it |
|---|---|
| `portal-2026-08.private.pem` | **Keep secret.** Never leaves your infrastructure. Written `0600`. |
| `portal-2026-08.public.pem` | Register with Gnomon. Safe to email, paste, or commit. |

No Node? `openssl genpkey -algorithm ed25519 -out private.pem` produces the
same thing, and `openssl pkey -in private.pem -pubout -out public.pem` gives
you the public half.

**Gnomon only ever stores your public key.** A full compromise of Gnomon's
database yields the ability to *verify* tokens, which anyone could already do,
and to mint exactly nothing. That asymmetry is why there is no shared-secret
option — with an HMAC scheme, our database would become a forgery capability
against every tenant we serve.

Name the `kid` for the period it covers — `portal-2026-08`, not `portal-key`.
You will rotate eventually, and a name that already implies a successor makes
that routine.

## 2. Register the public key

Send the public PEM and the `kid` to whoever runs your Gnomon instance. They
map it to your tenant. A `kid` belongs to exactly one tenant, and that
binding — not anything in the token — is what determines whose data you can
reach.

## 3. Mint a token per request

```bash
node mint.mjs --key keys/portal-2026-08.private.pem --kid portal-2026-08 \
  --tenant acme --subject resident-42 \
  --calendars cal-maintenance,cal-community --scopes events:read
```

```bash
go run mint.go --key keys/portal-2026-08.private.pem --kid portal-2026-08 \
  --tenant acme --subject resident-42 \
  --calendars cal-maintenance,cal-community --scopes events:read
```

Both are **zero-dependency** — Node's `crypto` and Go's `crypto/ed25519` are
built in, and a JWT is three base64url segments joined by dots. Copy the file;
you do not need a JWT library, and you should be able to read the whole thing
before trusting it.

In production you call the function, not the CLI. Serve the token from an
authenticated endpoint on your own domain, and let the embed fetch it there.

---

## The token

```
header   { "alg": "EdDSA", "typ": "JWT", "kid": "portal-2026-08" }

claims   { "aud": "gnomon",
           "sub": "resident-42",
           "tid": "acme",
           "cal": ["cal-maintenance", "cal-community"],
           "scp": ["events:read"],
           "iat": 1786694400,
           "exp": 1786694700 }
```

| Field | Meaning |
|---|---|
| `kid` (header) | Which of your registered keys signed this. Required. |
| `aud` | Always `gnomon`. |
| `sub` | **Opaque.** Your own internal user id. Gnomon never learns a name or an email — do not put one here. |
| `tid` | Your tenant id. Must match the tenant that owns `kid`, or the token is refused. |
| `cal` | Calendars this user may see. **An empty list grants nothing**, not everything. |
| `scp` | `events:read`, `events:write`. |
| `iat` / `exp` | Both required. See below. |

### Keep the lifetime short

The examples default to **5 minutes**, and Gnomon refuses anything over 15.

Gnomon has no revocation list. A leaked token is valid until it expires and
nothing can call it back — that is the accepted trade for having no accounts
to manage. A short lifetime is what bounds the damage, and the embed refreshes
silently, so users never see it happen.

If a long-lived token feels convenient, that is the feeling of a credential
sitting in a browser for a week.

### Only EdDSA is accepted

Gnomon accepts exactly one signing algorithm. This is a security property
rather than a limitation: supporting a second one means the verifier has to
map `alg` to a key type correctly forever, and the failure mode — an HMAC
verified against the bytes of a public key — is silent and total. With one
algorithm there is no mapping to get wrong.

---

## Rotating a key

You can have several active keys at once, which is what makes this safe to do
during business hours:

1. Generate a new pair with a new `kid`.
2. Register the new public key. Both are now accepted.
3. Deploy your change to sign with the new `kid`.
4. Ask for the old `kid` to be retired.

Retirement takes effect immediately — it is the only revocation lever
available, since tokens themselves expire rather than being recalled.

---

## Checklist

- [ ] The private key is not in your repository
- [ ] The token endpoint requires the user to be authenticated **on your side**
- [ ] `sub` is an opaque id, not an email or a name
- [ ] `cal` lists only calendars this user should see
- [ ] `scp` omits `events:write` unless this user should write
- [ ] TTL is minutes, not hours

---

## Adding another language

Both examples here are exercised against the real verifier in
`apps/server/test/reference-implementations.test.ts`, and a test asserts they
emit identical headers and claims. An example that has never been run against
the thing it talks to is a liability rather than documentation, so a new
language is welcome on the same terms: add it to that suite, or don't add it.
