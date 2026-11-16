# Validation record

Date: 2026-11-16 UTC

## Selected architecture

Rust Worker only. Discord stores task messages and replies. No D1, Durable Objects, KV, Sheets, Apps Script, cron, LLM backend or hidden dot API.

Default task intake: off. Same-dot integration: unverified.

## Fixed toolchain

- Rust 1.100.0, wasm32-unknown-unknown
- workers-rs / worker-build 0.7.5
- wasm-bindgen 0.2.114; js-sys 0.3.91
- Wrangler 4.162.0; Miniflare 4.20260730.0
- Compatibility date 2026-08-06
- Node.js v24.22.1 locally; CI targets Node 22
- Cargo.lock and package-lock.json included
- Development transitive security overrides: undici 7.30.1, sharp 0.35.5

## Executed and verified

- `cargo test --locked`: 3/3 passed
  - ID validation and empty allowlist denial
  - Exact bearer authentication and invalid/short placeholder rejection
  - Real Ed25519 signatures, altered payload, stale timestamp, malformed key/signature rejection
- `cargo check --locked --target wasm32-unknown-unknown`: passed
- `cargo clippy --locked --target wasm32-unknown-unknown -- -D warnings`: passed
- Release Rust WASM generation with worker-build: passed
- Local workerd / compiled WASM integration: 6/6 passed
  - Signed PING, stale/unsigned rejection, body limit
  - Public task response contract, disabled intake and unauthorized owner denial
  - Authenticated inbox; fake user messages ignored; completed work excluded
  - Reply original validation, mention suppression, stable nonce, normal bot reply, duplicate/conflicting result handling
  - Discord 403 stops; 429 surfaced without retries or alternate routing
  - 500-message scan overflow warning and fail-closed reply when prior delivery cannot be checked
- Discord HTTP calls in these tests are intercepted with network disabled. No live bot token or Discord server used.
- `wrangler deploy --dry-run`: passed, 762.92 KiB total / gzip 237.94 KiB
- Python HTTP client configuration tests: 2/2 passed. These test origin/credential rejection, not a deployed endpoint or credential-store persistence.
- `npm audit`: zero reported vulnerabilities after tested development overrides. This is not a Rust dependency audit or independent security certification.

## Failures found and corrected

- Latest workers-rs/worker-build 0.9.0 bundle compiled but hung in the installed local workerd. Pinned the tested official 0.7.5 + wasm-bindgen 0.2.114 combination instead. No claim about the exact root cause or all 0.9.0 deployments.
- Default release binary download was unavailable in this workspace. Built wasm-bindgen CLI from its official Cargo registry package and used the supported WASM_BINDGEN_BIN override; used npm's esbuild via ESBUILD_BIN.
- An HTTP test mock attempted to parse a ReadableStream synchronously; fixed the test to read its body asynchronously. Production input checks were not weakened.
- Development dependencies reported known sharp/undici advisories. Pinned patched overrides, reran runtime tests and npm audit successfully.

The pinned worker SDK's Delay destructor prints a benign timeout-duration message when the losing timeout future is dropped. No request text or credentials are printed.

## Not executed / remaining gates

- Public GitHub repository publication and hosted CI. Repository lookup returned 404; CLI is unauthenticated and available connector has no repository-creation action.
- Hosted Cloudflare Builds / Deploy button and actual Worker deployment
- Live Discord endpoint verification, command registration, metadata format and permission checks, actual message delivery
- Existing dot's supported authenticated consumer, scheduling/wake, and full Discord→same dot→Discord flow
- Real Discord rate limiting, load/latency testing and recovery drills
- Independent security review, legal/data-residency review and cost controls

No real credentials were created, copied, stored or transmitted. No bot settings or existing infrastructure were changed.

This is a locally validated bridge candidate, not completed same-dot integration or an exactly-once job queue. A single consumer is required. Consequential external actions must retain their own approval and idempotency safeguards.

## MCP migration preparation (2026-11-16)

- Added offline MCP Events cryptographic/identity/syntax/lifecycle primitives: 4 new tests.
- Final Rust tests: 7/7; WASM clippy with warnings denied passed.
- Rebuilt release WASM and reran Miniflare tests: 6/6; Python tests: 2/2.
- Final Wrangler dry-run: 764.66 KiB / gzip 237.93 KiB. No deployment.
- Initial dry-run shell omitted the temporary Cargo PATH and failed trying a read-only
  default Cargo home; rerunning with the existing explicit toolchain environment passed.
- OAuth, MCP HTTP endpoint, subscription storage and callback transport not implemented.
  No claim of MCP end-to-end or event delivery success. See MCP-EVENTS-DESIGN.md.

## Cloudflare Access MCP tools (2026-11-16, current)

- Real POST /mcp tools endpoint added, default disabled; Events not advertised.
- Access origin assertion: RS256 signature, configured issuer/audience/owner subject,
  app type, exp/iat/nbf validation; bounded fixed-origin JWKS fetch without redirects.
- MCP host checks, workers.dev/preview disablement and legacy bearer default-off.
- Rust unit tests: 9/9. Synthetic fixtures contain public key + signed fake claims;
  no live credentials and no private signing keys persisted.
- Rebuilt WASM Miniflare tests: 8/8, including synthetic Access authorization and
  actual MCP initialize/tools/list/tools/call against mocked upstreams.
- Python legacy helper tests: 2/2. WASM clippy -D warnings passed.
- Wrangler dry-run passed: 883.02 KiB / gzip 273.33 KiB. No deployment.
- Initial local JWKS RequestRedirect::Error mode was rejected by workerd; changed
  to Manual and reject all non-200 statuses, then rebuilt/retested successfully.
- Live Access Managed OAuth/Google/dot connection, storage and events remain unverified.

## Subscription persistence preparation (2026-11-16)

- Added private, unconnected R2/WebCrypto adapter and 3 local R2 emulator tests.
- Verified encrypted records, ID-bound authentication, incorrect-key rejection,
  create/refresh conditional-write races, owner checks, expiry and revoke tombstones.
- Callback verification, live R2, Rust adapter integration and Events delivery remain
  unimplemented. No new bindings were provisioned and no event capability advertised.

## Gated MCP Events (2026-11-16, latest)

- Rust now invokes actual Events/R2/WebCrypto adapter via wasm-bindgen.
- Verified callback challenge + HMAC, encrypted subscription, /dot event emission,
  protocol-shaped unsubscribe, rejected challenge/redirect/missing bearer/Access denial.
- Default event capability remains off. Hosted public-network enforcement and opaque
  Managed OAuth token forwarding are explicit activation gates, not claimed tested.
- No durable outbox/replay, production deployment or real dot connection tested.

Final current checks: Rust 9/9; JS/WASM/R2 14/14; prior unchanged Python 2/2; WASM clippy passed; Wrangler dry-run 916.24 KiB / gzip 282.46 KiB. No deployment.

## Pre-publication review (2026-11-16, final)

An independent read-only review found and we corrected five lifecycle edge cases:
- fixed callback verification timestamp no longer slides on cached refresh;
- same-key refresh preserves a live dual-signature rotation window;
- terminal 410/413 statuses survive oversized/malformed response bodies;
- transient Access 429/5xx does not revoke a healthy subscription;
- unsubscribe racing first-time challenge writes a tombstone and prevents activation.
Regression tests cover each. Final tests: Rust 9/9, JS/WASM/R2 18/18, Python 2/2;
WASM clippy with denied warnings passed. Review found no publication-blocking issue
with defaults/gates intact, and no real secrets/private conversations in the source
artifact. This is not a production security certification. GitHub repository lookup
still returned 404, so no source was published.
