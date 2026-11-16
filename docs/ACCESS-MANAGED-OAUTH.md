# Cloudflare Access Managed OAuth deployment design

> Historical design notes. For the current implemented/gated status, read [EVENTS-IMPLEMENTATION.md](EVENTS-IMPLEMENTATION.md). Earlier statements that Events or the R2 adapter are unimplemented are superseded by that document. Live production verification remains required.

Status: Rust MCP tools and Access assertion validation implemented and tested locally
against synthetic signed tokens and mocked Discord/JWKS. The real Google sign-in,
Cloudflare Access configuration and ChatGPT custom-plugin connection are unverified.
MCP Events delivery is NOT implemented or advertised. No deployment has been made.

## Authentication boundary

Managed OAuth gives the client an opaque access token. Cloudflare resolves it and
forwards a signed `Cf-Access-Jwt-Assertion` to the Worker. The Worker does not parse
the opaque bearer or implement its own authorization-code/token/refresh endpoints.
Access supplies its own OAuth discovery and login endpoints. Do not overwrite these
with guessed metadata in this Worker.

The Rust validator permits only RS256 with an unambiguous configured-team JWKS key,
requires exact issuer, Access application audience, configured owner subject,
application token type, expiration and issued-at, and checks optional not-before.
It rejects token-directed key URLs and unsupported critical headers. Public JWKS
is retrieved only from the configured team.cloudflareaccess.com origin, with no
redirects, a five-second total response/read bound and 16 KiB maximum. Unknown keys
or upstream failure deny access. RSA verification uses the maintained RustCrypto
RSA implementation; this server does not perform RSA encryption/decryption.

This is a single-owner deployment. Map ACCESS_SUBJECT to that owner's Access UUID,
not their display name. Google login selection and email allowlisting happen in
Access policy. The configured Discord IDs separately restrict slash-command senders.
They are not automatically equated with Google or Access IDs.

## Routes and deployment settings

- Set `workers_dev=false` and `preview_urls=false` (already in wrangler.jsonc).
- Configure an actual custom hostname and exact `MCP_HOST`; alternate hosts fail.
- Put `/mcp` behind an Access application in the same Cloudflare account with
  Managed OAuth enabled and a narrowly scoped owner policy and Google login.
- `/interactions` must remain reachable by Discord without an interactive Access
  login. Protect it using its existing Ed25519 signature and channel/user checks.
  Use path-separated Access policies or a separate ingress hostname. Do not add a
  blanket Access bypass that includes `/mcp`.
- Protect canonical MCP metadata/discovery paths according to Access's Managed
  OAuth configuration. Verify the client's unauthenticated request receives the
  correct discovery challenge and PKCE S256 metadata, not a generic HTML login.
- Set MCP_HOST, ACCESS_ISSUER, ACCESS_AUD, ACCESS_SUBJECT, then MCP_ENABLED=true only
  after the Access application is configured. Intake remains disabled until the
  intended dot is connected and can process tasks.
- Legacy `/v1/*` bearer routes now default disabled via LEGACY_HTTP_ENABLED=false.
  Leave them disabled in the MCP deployment.
- No wildcard owner policy, service-token policy or bypass policy should authorize
  MCP writes. Never rely only on an unverified forwarded identity header.

A valid signed assertion is not proof that Access is currently in front of every
route. Signed tokens may remain valid until expiration. Test alternate hostnames,
preview URLs, policy removal and session revocation on the actual deployment.
No code can honestly claim instant revocation of every already-in-flight request.

## Implemented MCP subset

Stateless Streamable HTTP on POST /mcp, version 2025-03-26: initialize,
notifications (202), ping, tools/list and tools/call. GET streaming is not offered.
Only discord_get_task and discord_reply are exposed. They reuse fixed-channel
Discord validation and bounded reply deduplication. MCP writes are not advertised
as globally idempotent. No events capability is advertised; event methods return
Method not found rather than pretending a subscription was saved.

## Event-specific work still required

Access manages user login; it does not store our event subscriptions or send their
callbacks. The R2 proposal and callback transport requirements remain in
MCP-EVENTS-DESIGN.md. In particular, server-originated delivery must recheck owner
access and stop after revocation; the last valid inbound JWT cannot prove current
access forever. Choose an explicit policy/revocation source or limit subscriptions
to short finite authorized lifetimes and disclose its revocation window. This is a
blocking design requirement before enabling events.

## Live acceptance checklist

1. Google owner can connect; another Google user cannot.
2. OAuth discovery, PKCE S256, resource parameter, refresh and reconnect work in the
   intended dot, not merely an unrelated MCP test client.
3. Correct Access assertion verifies; wrong issuer/audience/subject/expired/tampered
   assertions fail. Alternate hostname/preview/default URL access fails.
4. Read a synthetic Discord task and send an approved synthetic reply in the intended
   channel; confirm mention suppression and duplicate/conflict behavior.
5. Enable events only after durable subscriptions, callback verification/SSRF-safe
   egress, retries, expiry, unsubscribe and revocation have been tested end to end.

Sources:
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/build/mcp-events
