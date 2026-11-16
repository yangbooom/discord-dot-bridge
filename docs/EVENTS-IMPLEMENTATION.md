# Implemented MCP Events candidate

This is the current status, superseding earlier design-only/blocker notes.
The code is locally tested, not deployed and not certified for production.

## Implemented

The Rust Worker authenticates every MCP request with a verified Cloudflare Access
assertion. A narrow JavaScript adapter supplies native WebCrypto/R2 conditional
writes and outbound Events calls, invoked from Rust through wasm-bindgen.

- Conditional Events capability: disabled unless MCP_EVENTS_ENABLED and
  EVENTS_TRANSPORT_VERIFIED are both true, R2 is bound, a 32-byte encryption key is
  configured, and explicit callback hosts are configured.
- events/list exposes discord.task.created for the configured channel only.
- events/subscribe validates channel, webhook delivery, signing key and finite TTL;
  binds identity to issuer/subject/callback/event/filter; verifies a signed random
  callback challenge; persists encrypted callback/secret/authorization state in R2.
- events/unsubscribe accepts the original name/arguments/delivery URL as specified
  by the OpenAI protocol, checks owner and writes a secret-free revoked tombstone.
- Default lifetime five minutes, maximum fifteen minutes, and never beyond the
  verified inbound Access assertion's expiry. No unbounded subscription lifetime.
- Same-key callback verification is cached in encrypted state for sixty seconds.
  A signing-secret change is verified again; old/new signatures overlap sixty seconds.
- /dot emits a minimal event with channel, interaction and author IDs; no prompt text
  or unrelated dot conversation content is placed in the callback body.
- discord_find_task resolves interaction ID to the signed slash-command task held
  in Discord, within the latest 500 messages. Discord persistence may lag briefly.
- Event signatures use Standard Webhooks HMAC with a stable event ID, fresh attempt
  timestamp and exact serialized payload. Three bounded attempts on transient
  failures; no retry for 410/413. Redirects are not followed.
- Access token acceptance is rechecked before each attempt via the canonical app's
  Access-protected /event-authorization URL. Only that endpoint receives the stored
  opaque bearer; callbacks never receive it. The subscription is reread immediately
  before delivery to observe revocation/rotation.

## Required deployment verification gates

Do not set EVENTS_TRANSPORT_VERIFIED=true merely to make a test pass.

1. Public network enforcement. global_fetch_strictly_public is explicitly configured.
   Official documentation guarantees public-Internet routing, not a standalone
   statement of every prohibited-IP check. Local workerd source/test evidence uses
   network peer restrictions at the actual connection. This is evidence for a
   candidate runtime-enforced design, not proof of hosted internals. Test hosted
   loopback, IPv4/IPv6 private/link-local/reserved addresses, hostname resolution to
   them, redirect attacks and DNS-rebinding behavior using non-sensitive probes.
   If the hosted guarantee cannot be established, keep Events disabled or use an
   audited transport that provides it. Do not claim application-level IP pinning.
2. Managed OAuth bearer forwarding. The adapter needs the original opaque
   Authorization: Bearer oauth:... header to recheck Access later. If Access removes
   it, subscribe fails closed. Confirm actual forwarding and repeated front-door
   authorization, policy revocation, opaque-token expiry and refresh behavior.
   Never replace this with trusting a stored subject or expired JWT.
   Cloudflare documents policy reevaluation at token refresh. A successful round trip
   with an already-issued opaque token does not prove that a just-removed policy is
   already enforced. Configure a short token lifetime and measure the residual
   acceptance window; it is bounded by effective token rejection or subscription
   expiry, not an immediate-policy-revocation guarantee. Keep Events disabled if
   this window is unacceptable for the deployment.
3. Path coverage. Protect both /mcp and /event-authorization with the same owner-only
   Access application. /interactions remains signature-protected and publicly
   reachable by Discord. Default/preview Workers hosts stay disabled.
4. R2. Bind a private SUBSCRIPTIONS bucket and supply SUBSCRIPTION_ENCRYPTION_KEY
   as a Worker secret containing 64 lowercase hexadecimal characters. It encrypts
   signing secrets and opaque access credentials; do not print or commit it.
   Do not rotate it without a state migration: old records become unreadable.
5. Callback host allowlist. Configure exact observed/verified OpenAI callback host(s)
   in EVENT_CALLBACK_HOSTS, not wildcards or guessed hostnames. HTTPS only, port443,
   no credentials or fragments, explicit local/literal IP rejection, bounded bodies
   and five-second total request/read deadlines are additional defenses.
6. Connect the custom MCP plugin in the intended dot. Verify a synthetic task causes
   that dot to wake, retrieve the task, and send an approved answer in the channel.
   Local mocks do not demonstrate this account-level connection.

## Explicit limitations

- Delivery is best-effort waitUntil with no durable outbox/replay. A Worker shutdown
  or extended outage can lose an event even though Discord retains the task. cursor
  is null. Reconcile missed tasks manually; do not promise reliable unattended work.
- At most 16 stored subscription objects are scanned. Reaching the bound prevents
  new creation; excess state fails closed. Expired/revoked tombstones require operator
  lifecycle management. No background cleanup or scheduled service was added.
- Re-subscribing an explicitly revoked identity currently requires an explicit
  operator reset/reconnect design. A stale refresh never restores a tombstone.
  This conservative limitation must be addressed before general release.
- Refresh/revoke use ETag compare-and-swap. There is no global processing lease or
  exactly-once execution. Single consumer and action-level idempotency remain required.
- Unsubscribe cannot recall an already in-flight HTTPS request. Access recheck and
  callback send also have a finite race; no instantaneous revocation claim is made.
- Automated retry delivery still depends on the runtime's waitUntil lifetime.
  Serial fanout and several timeouts can exhaust it. No durable delivery guarantee.
- The bot's owner must approve the custom integration's ongoing secret storage and
  access during setup. This development task has not created credentials or grants.

## Tests

Rust unit tests, compiled WASM MCP tests and local R2 tests cover valid signed Access
assertions; wrong/expired identities; disabled/default endpoints; callback HMAC;
challenge mismatch; missing opaque bearer; Access denial; redirects; encrypted R2;
conditional-write races; unsubscribe; and a signed /dot event. All upstream HTTP uses
synthetic credentials and mocks. They do not assert hosted network-policy behavior.

Sources:
- https://developers.openai.com/plugins/build/mcp-events
- https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public
- https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp
- https://github.com/capnproto/capnproto/blob/master/c%2B%2B/src/kj/async-io-unix.c%2B%2B
- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
