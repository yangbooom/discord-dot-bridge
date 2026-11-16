# Discord-only storage design (implemented, local-runtime validated)

> Historical HTTP-only baseline. See EVENTS-IMPLEMENTATION.md for the current selected MCP/optional R2 design.

No Durable Object, D1, Sheets, Apps Script or external database is required for a deliberately single-consumer personal assistant bridge. Discord itself can retain requests and replies.

## Flow

1. User invokes a guild-only `/dot task:...` command.
2. Stateless Rust Worker verifies Ed25519 raw body/timestamp, application and owner/guild/channel allowlists.
3. Worker responds with type 4, non-ephemeral content carrying a compact task ID and text. Discord stores this application response as the task message. No external persistence is needed before acknowledgement.
4. A protected inbox endpoint queries only the configured channel, authenticates messages by bot author/application and original slash-command interaction metadata, and returns bounded pending tasks to an approved consumer.
5. The consumer validates the original requester's identity, handles the request with its existing confirmation rules, then calls a protected reply endpoint.
6. The reply endpoint rereads the original task to verify its channel/application/requester, then uses a normal bot message reply. The 15-minute interaction token is not used for final delivery.
7. Discord retains the final reply. A recognizable job ID and message reference allow later scans to identify handled tasks.

No endpoint accepts arbitrary Discord URLs or channel IDs. Results have mentions disabled. The bot can access only the configured channel for this bridge. No chat-wide scraping is necessary for initial `/dot` support.

## Limits that must be explicit

- This is a mailbox, not an exactly-once transactional queue.
- Only one task consumer may run. Discord reactions or marker messages are not atomic locks.
- Concurrent consumers, an ambiguous send timeout, or a crash between an external action and its status update can duplicate work. For consequential operations the consumer must retain its normal approval and action verification safeguards.
- Discord nonce/enforce_nonce helps recently repeated outbound sends, but is not a permanent uniqueness guarantee.
- Pagination/cursor recovery must not silently skip requests outside the most recent 100 messages. Either scan a bounded retention window with an explicit overflow warning or keep a durable consumer cursor in an already supported consumer store.
- Deleting/editing task or result messages affects available history. There is no independent audit record.
- A task's final answer is visible to channel members. Do not import unrelated private dot-chat information into it.
- Normal Discord API rate limits apply; 403/authorization failures stop the operation and do not trigger alternative routing.

## Unresolved connection gate

The Worker cannot directly wake or call this persistent dot through an unverified API. The consumer must be an actual supported dot integration:

- Preferred if available: an authenticated, user-installed custom MCP/connector exposing only inbox/reply operations. Availability for this dot has not been verified.
- Potential fallback requiring explicit validation: an operator-authenticated Worker UI inspected through a persistent supported browser session on a schedule. This is polling, may require session renewal, and is not immediate wake-up.
- A standalone LLM API bot is not the same dot and does not meet the stated requirement.

Do not enable intake or claim the bridge connected until a real authorized request reaches the existing dot and its reply reaches the correct Discord channel through the selected supported route.

## Sources

- https://docs.discord.com/developers/interactions/receiving-and-responding
- https://docs.discord.com/developers/resources/message
- https://docs.discord.com/developers/topics/rate-limits
- https://docs.discord.com/developers/tutorials/hosting-on-cloudflare-workers
- https://developers.cloudflare.com/workers/languages/rust/
