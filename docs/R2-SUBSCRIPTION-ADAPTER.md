# Locally tested subscription persistence

> Historical design notes. For the current implemented/gated status, read [EVENTS-IMPLEMENTATION.md](EVENTS-IMPLEMENTATION.md). Earlier statements that Events or the R2 adapter are unimplemented are superseded by that document. Live production verification remains required.

`support/subscription-store.js` is a small private R2/WebCrypto adapter prepared for
future Events integration. It is NOT wired to a public route or the Rust Worker,
and no R2 bucket/binding/key was provisioned. Event support stays disabled.

The existing pinned workers-rs 0.7.5 SDK does not expose conditional R2 puts in its
builder. A narrow JavaScript adapter using the official R2 API avoids pretending an
unconditional Rust put is atomic. Rust remains the application implementation; this
adapter can later be called through a reviewed WASM boundary once delivery is ready.

Verified in real local Miniflare R2 emulation:
- AES-256-GCM via platform WebCrypto with random 96-bit nonce; subscription object
  path is authenticated associated data. Wrong key and cross-ID ciphertext fail.
- Callback and signing secret do not appear in the stored JSON envelope.
- Concurrent create-if-absent has exactly one success.
- Concurrent refresh with the same ETag has exactly one success.
- Owner-bound revoke writes a secret-free tombstone. A stale refresh cannot restore
  it; a fresh read of the tombstone also cannot refresh or recreate it.
- Expired, revoked or wrong-owner records are not returned as active.

The owner parameter is an already-authenticated issuer+subject identity. The
createVerified/refreshVerified functions require successful callback verification
and current authorization as caller preconditions; they do not invent either.
readActive only checks local lifecycle state, not external Access policy.

Production gaps: audited Rust/JS binding; secret key provisioning/rotation; schema
validation at MCP boundary; callback verification/egress; Access authorization
revalidation; finite subscription policy; explicit reconnect semantics after revoke;
outbox/retries/recovery; live R2 confirmation. Existing in-flight HTTP cannot be
recalled by a tombstone. No claim of an operational Events system follows from these
tests. The tests use fake keys/records only and perform no external network calls.
