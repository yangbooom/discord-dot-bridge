# MCP Events: precise implementation blockers

> Historical design notes. For the current implemented/gated status, read [EVENTS-IMPLEMENTATION.md](EVENTS-IMPLEMENTATION.md). Earlier statements that Events or the R2 adapter are unimplemented are superseded by that document. Live production verification remains required.

Checked against official documentation on 2026-11-16. No event endpoint was enabled,
no subscription accepted, and no callback or credential transmitted. Existing MCP
tools remain operational only in local synthetic tests. This document does not
claim that Cloudflare or MCP Events is inherently incompatible.

## 1. Callback egress is not yet compliant

The OpenAI Events guide requires validation of resolved destination IPs at connection
time, connection to the validated address while preserving TLS hostname, rejection
of non-public destinations, and no redirects. Both verification and event delivery
must use this transport.

Options examined:

- Workers fetch: manual redirects work and are used for current fixed-origin calls.
  General connection-level address selection is not exposed by its documented API.
- cf.resolveOverride: documented to be ignored unless URL host and override host are
  in the same owned zone. It cannot pin an arbitrary supplied OpenAI callback IP.
- Workers node:http / node:https: wrappers around fetch; custom lookup and
  createConnection are explicitly unsupported, so importing a Node HTTP client is
  not a solution to the address-pinning requirement.
- cloudflare:sockets: raw sockets block Cloudflare IP ranges and recommend fetch for
  HTTP destinations. No live callback address has been supplied, so its routability
  is unknown. Do not claim this is a universal callback transport.
- Syntax validation, exact host allowlists or a separate DNS-over-HTTPS lookup do
  not remove the validation/connect race and must not be described as IP pinning.

A documented platform guarantee meeting the requirement, or a separate audited
HTTPS delivery component that can pin public addresses and preserve TLS identity,
is needed. Adding a helper changes deployment scope and must be discussed first.
No helper, tunnel, proxy, new account, or container has been provisioned.

## 2. Subscription storage is feasible, not sufficient

Private R2 direct binding reads and conditional writes can implement persistent
subscription state without D1, DO or Sheets. Use versioned compare-and-swap, encrypted
signing keys, finite expiry, owner-bound unsubscribe and no cache. Test stale refresh
vs unsubscribe races before activation. R2 is not a delivery queue by itself.

A message must be durable before acknowledging acceptance if loss after Worker
shutdown is unacceptable. waitUntil is not a durable job system. The R2 outbox +
scheduled drain option adds a scheduler and a lease/retry protocol; it has not been
implemented or silently added. No replay support should be claimed without that.

## 3. Access authorization must be rechecked during delivery

Managed OAuth correctly protects inbound MCP calls and delegates Google login.
An event delivery has no new authenticated client request. A previously valid JWT
is not evidence that Access policy still permits the owner indefinitely. Persisting
only its subject does not solve this. A defined revalidation source and revocation
window is required before sending later events. Subscriptions must not outlive their
granted authorization; expiry alone is not an instant policy-revocation mechanism.

The smallest next decision is the callback transport/runtime choice. After that,
implement R2 subscription/outbox semantics and the owner-revalidation mechanism as
one tested lifecycle, rather than publishing an apparently functioning subscribe
endpoint that cannot securely deliver.

## Sources

- OpenAI Events callback and lifecycle requirements:
  https://developers.openai.com/plugins/build/mcp-events
- Workers Request: resolveOverride restrictions and redirect modes:
  https://developers.cloudflare.com/workers/runtime-apis/request/
- Workers Node HTTP unsupported lookup/createConnection:
  https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/
- Workers TCP restrictions:
  https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
- R2 consistency and atomic conditional writes:
  https://developers.cloudflare.com/r2/reference/consistency/
- Managed OAuth opaque token/origin assertion contract:
  https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
