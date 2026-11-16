# MCP Events migration decision

> Historical design notes. For the current implemented/gated status, read [EVENTS-IMPLEMENTATION.md](EVENTS-IMPLEMENTATION.md). Earlier statements that Events or the R2 adapter are unimplemented are superseded by that document. Live production verification remains required.

Status: selected direction; MCP tools transport and Access JWT validation now implemented
and locally tested. Managed OAuth live setup, subscription store, event delivery and
actual dot connection remain unverified/unimplemented. See ACCESS-MANAGED-OAUTH.md.
The existing HTTP bridge remains a tested baseline, not the selected final integration.
No service was deployed and no credential or external subscription was created.

## User flow

1. User installs the custom authenticated MCP plugin in the existing dot.
2. User authorizes a specific Discord account/channel and asks the dot to respond to
   `discord.task.created`. OpenAI supplies the event callback and signing secret.
3. `/dot` verifies Discord signatures and the configured owner/guild/channel.
4. A matching active subscription triggers a signed minimal event containing the
   task message ID, channel ID, author ID and link. No unrelated dot history is sent.
5. The dot retrieves the task through `discord_get_task` and writes its answer
   through `discord_reply`. Use the existing validated Discord message/reference and
   deduplication rules. Tool writes remain subject to user approval and policy.

The MCP server does not choose which dot receives the callback. The subscription is
created from the intended dot conversation. Actual custom-plugin account access and
callback routing need a live test. Ordinary Discord chat monitoring would require a
Gateway consumer; slash commands alone do not receive every channel message.

## Storage choice

KV is not suitable as the authority for subscription revocation or secret rotation.
Its readers can observe old state for 60 seconds or longer, including negative
lookups. Tombstones and short TTLs do not make it strongly consistent.

Recommended under the no-D1/no-DO constraint: one private R2 bucket for subscription
records only. Discord continues to hold user tasks and results. R2 provides strong
object reads/deletes/listing and atomic conditional writes. Do not put subscriptions
behind a CDN or read-through cache. Use application encryption with a Worker secret
key, random nonce, authenticated metadata binding, and a maintained AEAD library.
No bucket or encryption key has been created by this implementation.

One object per deterministic subscription ID stores owner issuer+subject, allowed
channel, callback, encrypted signing keys, finite expiry, version and active status.
Refresh uses ETag compare-and-swap and rejects a stale write. Unsubscribe writes a
revoked tombstone using compare-and-swap rather than racing an unguarded delete.
A refresh that began before revocation must not reactivate the tombstone. New
subscriptions after an explicit reconnect require a new authorized operation.

Strong state is necessary but does not cancel HTTP already in flight. Define
unsubscribe as preventing new dispatch authorizations after the revocation commit;
an already-dispatched delivery may finish. Read the current record before every
attempt. Never claim zero in-flight delivery after unsubscribe. Keep event payloads
minimal and reauthorize task-read tools on every call.

A request waitUntil lifetime is not a durable delivery queue. Bounded best-effort
attempts can be an explicitly documented MVP, but downtime/loss must be visible.
For durable replay, persist event/outbox objects in the same R2 bucket and design a
bounded scheduled drain with conditional leases. That extra scheduler/storage is a
separate decision; do not advertise replay until implemented and tested.

## OAuth choice

Use an established OAuth 2.1 authorization provider that supports authorization
code + PKCE S256 and the MCP resource parameter. Resource-server metadata must
point to the actual provider. Validate signature, algorithm, issuer, audience,
expiry/not-before, scope and configured subject on every tool and subscription call.
Never accept a Discord OAuth token as if it were an MCP audience-bound access token.
Never substitute a shared API key or an unauthenticated endpoint for this flow.

Selected provider: Cloudflare Access Managed OAuth with Google login; actual account
configuration and client interoperability are still required. An existing suitable company
identity provider is preferable to adding one solely for this bot. If none exists,
a managed MCP-capable OAuth provider is the next choice. No accounts, grants,
credentials, or security settings were created. Dynamic registration and refresh
behavior must be verified with the selected provider, not inferred from OAuth branding.

## Callback transport boundary

The official event contract requires HTTPS, public destination validation at
connection time, connection to the validated address with original TLS hostname,
and no redirects. A URL regex, initial DNS lookup, `fetch`, or a hostname allowlist
alone does not satisfy that connection-time guarantee.

The pure Rust callback syntax validator is deliberately named and documented as
syntax-only. It is NOT used to send callbacks. Before enabling events, implement or
choose an audited egress transport with DNS rebinding protection and test redirects,
loopback/private/link-local/reserved IPv4 and IPv6, mixed DNS answers, DNS changes,
timeouts and response size limits. A narrowly approved callback host allowlist is
additional defense, not a substitute for the transport guarantee.

## Protocol implementation gates

- Authenticated Streamable HTTP endpoint: initialize, initialized notification,
  ping, tools/list, tools/call. Advertise only implemented capabilities.
- Tools: `discord_get_task`, `discord_reply`; fixed channel and caller-bound owner.
- events/list exposes `discord.task.created` with channel_id filter and minimal payload.
- events/subscribe validates name/filter, whsec base64 key length 24–64 bytes,
  authenticated owner, finite lifetime and callback verification. Challenge must be
  random, one-use and short-lived; constant-time equality after a bounded 2xx response.
- events/unsubscribe is owner-bound and idempotent; return only after state commit.
- Deterministic IDs bind issuer, subject, exact callback, event and canonical filter.
- Standard Webhooks signs event ID + timestamp + exact serialized body. Preserve
  event ID over retries; use fresh signing time. Do not retry 410 or 413.
- Never log secrets, callback URLs/query strings, OAuth tokens or user task bodies.
- Do not announce events in initialize before all preceding gates pass.

## Implemented and tested now

`src/mcp_events.rs` contains secret validation, Standard Webhooks HMAC signing,
canonical deterministic subscription identities, callback syntax checks, expiry /
revocation predicates and bounded retry status classification. Four unit tests cover
these primitives, including a Python hmac independently generated signature vector.
These functions neither authenticate callers nor persist/dispatch subscriptions.
They cannot be described as an operational MCP integration.

## Official sources

- https://developers.openai.com/plugins/build/mcp-events
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://developers.cloudflare.com/kv/concepts/how-kv-works/
- https://developers.cloudflare.com/r2/reference/consistency/

## Latest transport research

See [precise Events blockers](EVENTS-BLOCKERS.md). Node-compatible HTTPS does not
provide a hidden workaround: Workers explicitly omits custom lookup/createConnection.
Events remain absent from capabilities and subscribe is not falsely acknowledged.
