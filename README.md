# Discord Dot Bridge · Rust Worker

Discord를 작업함과 답변 기록으로 쓰는 작은 Cloudflare Worker입니다. Durable Objects, D1, Sheets, Apps Script 없이 동작합니다. MCP Events 구독과 비밀정보는 별도 비공개 R2 bucket에 암호화해 보관하도록 구현했습니다.

**현재 상태: Rust 구현 및 로컬 WASM 검증 완료. Cloudflare 배포와 실제 Discord 송수신, 기존 dot 연결은 미검증입니다.**

## 현재 선택: MCP Events

Rust MCP 도구와 조건부 Events 경로까지 구현했습니다. [현재 구현과 활성화 조건](docs/EVENTS-IMPLEMENTATION.md)을 먼저 읽으세요. 로컬 테스트에서 Access 인증 → 구독 검증 → 암호화 R2 저장 → 서명된 Discord 이벤트 → 구독 해지를 확인했습니다. 실제 Google 로그인, 호스팅 환경의 네트워크 보호, opaque OAuth token 전달, 기존 dot 왕복은 아직 미검증입니다.

Events는 기본 비활성화입니다. 배포 버튼만 누르면 연결이 완성되는 상태가 아닙니다. 현재 이벤트 전달은 best-effort이며 재시작·장애 중 유실을 복구하는 outbox는 없습니다. Discord의 원 작업은 남아 있습니다.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yangbooom/discord-dot-bridge)

위 버튼은 이 공개 저장소를 대상으로 합니다. Cloudflare 공식 버튼은 소스 저장소를 복제하고 빌드·배포 과정을 안내합니다. Rust 설치/컴파일이 포함되어 첫 빌드에 시간이 걸릴 수 있습니다. Hosted Builds에서의 버튼 배포는 아직 실행하지 않았습니다.

## 기존 HTTP 기반 동작 (MCP 선택으로 기본 비활성화)

1. `/dot task:...`를 받은 Worker가 원문 서명과 사용자/서버/채널을 확인합니다.
2. 공개 Interaction 응답으로 작업 내용을 남깁니다. Discord가 이 메시지를 보관합니다.
3. 승인된 단일 소비자가 인증된 `/v1/inbox`로 할 일을 읽습니다.
4. 소비자가 작업을 처리한 후 `/v1/reply`를 호출합니다.
5. Bum Bot이 원 작업 메시지에 일반 bot reply를 보냅니다. 15분짜리 Interaction token에 의존하지 않습니다.

**기본 설정만으로 기존 ChatGPT dot을 깨우지는 않습니다.** 기존 dot의 실행 환경에서 인증된 HTTP client를 정기 실행하는 후보 경로가 있으며, 실제 배포·자격증명 보관·스케줄 재실행은 별도 검증해야 합니다. MCP Events는 명시적인 활성화 및 실제 환경 보안 검증이 끝나기 전까지 광고하거나 수신하지 않습니다. 별도 LLM API 봇을 동일 dot이라고 대체하지 않습니다. 실제 소비자 연결과 왕복 검증을 완료하기 전에는 기본 `ACCEPT_TASKS=false`를 유지하세요. 봇과 Worker만 배포해도 dot이 자동으로 일을 시작한다는 뜻이 아닙니다.

일반 채팅 전체, mention 감시, DM, 첨부파일 수집은 구현 범위가 아닙니다. 지정 채널에서 이 앱이 만든 `/dot` 응답만 작업으로 인정합니다. 사용자 입력에 포함된 명령은 원 요청자의 권한 범위 내에서만 처리해야 합니다.

## 사용자 설정 및 배포

현재 MCP 배포에는 custom hostname과 Cloudflare Access Managed OAuth 설정이 추가로 필요합니다. 기본 workers.dev / preview URL과 기존 HTTP bearer 경로는 꺼져 있습니다. 위 Access 설정안을 먼저 확인하세요.

1. 공개 저장소에는 코드와 가짜 설정 예시만 올립니다. 실제 토큰·대화 내용·사용자 ID를 커밋하지 마세요.
2. Deploy 버튼 또는 로컬 Wrangler로 배포 준비를 합니다. 비용은 Cloudflare 계정/플랜/사용량에 따릅니다.
3. `wrangler.jsonc` 또는 Cloudflare 설정에서 입력합니다.
   - `DISCORD_APPLICATION_ID`: 기존 앱 ID
   - `DISCORD_PUBLIC_KEY`: Developer Portal의 서명 검증용 공개키
   - `DISCORD_BOT_USER_ID`: 실제 bot 사용자의 ID
   - `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`: 허용할 서버/채널 1개
   - `ALLOWED_USER_IDS`: 허용할 소유자 Discord ID 목록, 쉼표 구분
   - `ACCEPT_TASKS`: 처음에는 `false`
4. Cloudflare의 Secrets 입력란에 직접 `DISCORD_BOT_TOKEN`을 저장합니다. Events 활성화에는 별도 `SUBSCRIPTION_ENCRYPTION_KEY`와 비공개 R2 binding이 필요합니다. `BRIDGE_API_TOKEN`은 기본 비활성화된 구형 HTTP 경로를 명시적으로 사용할 때만 필요합니다. 채팅이나 코드에 비밀값을 붙이지 마세요.
5. 기존 봇의 설치 범위/사용처를 확인합니다. 대상 채널의 View Channel, Read Message History, Send Messages 권한과 `applications.commands`가 필요합니다. Administrator는 필요하지 않습니다. 자체 application response와 reply만 취급하며 Message Content privileged intent에 의존하지 않습니다. 실제 환경에서 메시지 본문/metadata 제공 여부를 검증해야 합니다.
6. Developer Portal의 Interactions Endpoint URL을 `https://<worker>/interactions`로 설정합니다. 기존 endpoint가 있으면 교체 영향을 확인하세요. 서명된 PING 성공이 필요합니다.
7. 로컬 안전한 환경에 `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `DISCORD_BOT_TOKEN`을 설정하고 `npm run register`를 직접 실행합니다. 길드 명령 `/dot` 하나만 생성/갱신합니다. 동일한 이름의 기존 명령이 있다면 덮어쓰므로 먼저 확인하세요.
8. 동일 dot의 지원된 인증 연결을 확정하고 실제 왕복을 테스트합니다. 한 소비자만 실행하도록 보장하세요.
9. 승인된 사용자/채널 거부, 중복 결과, 403/429, 오래된 작업, timeout을 확인한 후에만 `ACCEPT_TASKS=true`로 전환합니다.

Worker의 `/health`는 생존 확인입니다. dot 연결 성공이나 봇 권한 정상 여부를 보장하지 않습니다.

## 소비자 API

HTTPS와 `Authorization: Bearer <BRIDGE_API_TOKEN>`을 사용합니다.

| API | 요청 | 응답 |
|---|---|---|
| GET `/v1/inbox` | 본문 없음 | `tasks`, `truncated`, `warning`, `singleConsumerRequired` |
| POST `/v1/reply` | `{ "messageId": "원 작업 메시지 ID", "text": "답변" }` | `sent`/`already_sent`, Discord `messageId` |

작업은 `messageId`, 원 slash `interactionId`, `userId`, `channelId`, `task`, `timestamp`, Discord URL을 포함합니다. 반환 순서는 오래된 작업 우선입니다. 소비자는 실제 사용자 식별과 작업별 승인을 유지해야 합니다. 이메일, 결제 등 승인 필요한 행동을 Discord 명령 하나로 무조건 허용해서는 안 됩니다.

- 요청 최대 16 KiB, 작업 최대 1700 UTF-16 units, 답변 최대 1800 UTF-16 units
- 원 작업과 최종 답변은 모두 채널 구성원에게 공개됩니다. 개인 dot 대화의 다른 자료를 자동으로 공개하지 마세요.
- 최신 100개씩 최대 5페이지를 조회합니다. 500개 이후에는 `truncated=true`로 누락 가능성을 알립니다. 전체 할 일 목록이라고 가정하지 마세요.
- reply는 원 작업을 다시 조회하고 앱/봇/원 요청자를 재검증합니다. 작업 이후 이력 500개 안에서 기존 결과를 확인할 수 없으면 409로 거절합니다.
- 같은 결과가 이미 있으면 기존 메시지 ID를 반환합니다. 다른 결과가 있으면 409로 멈춥니다.
- Discord nonce와 `enforce_nonce`를 사용하지만 이는 영구적인 exactly-once 보장이 아닙니다.
- 원자적 claim/lease는 없습니다. **단일 소비자만 사용하세요.** 동시 호출과 장애 시 중복 실행 가능성은 남습니다.
- 외부 행동을 끝낸 직후 소비자가 중단되면 Discord 결과가 없을 수 있습니다. 재실행 전 실제 행동 완료 여부를 확인해야 합니다.
- timeout/5xx는 전달 여부가 불명확할 수 있습니다. 자동 재시도하지 않으며, 채널을 확인한 뒤 같은 요청 재시도 여부를 판단해야 합니다.
- 403/권한 오류는 중단하며 다른 호스트/IP/프록시로 우회하지 않습니다. 429도 자동 재시도하지 않으며 `retryAfterSeconds`를 반환합니다. 소비자는 최소 그 시간만큼 기다려야 합니다.
- 모든 출력의 mention 파싱과 링크 미리보기를 비활성화합니다.

## 동일 dot의 HTTP polling 후보

`scripts/bridge-client.py`는 표준 Python만 사용하며 `inbox` 또는 `reply`를 호출합니다. 토큰은 명령 인자·automation prompt·저장소에 넣지 않고, 사용자가 승인한 자격증명 저장소에서 실행 환경 변수 `BUM_BRIDGE_API_TOKEN`으로 주입해야 합니다. `BUM_BRIDGE_URL`은 승인된 HTTPS Worker origin만 받습니다. Redirect를 따르지 않고 write 재시도도 하지 않습니다. reply JSON은 stdin으로 받습니다.

```sh
python3 scripts/bridge-client.py inbox
python3 scripts/bridge-client.py reply < reviewed-result.json
```

이 명령을 실제 dot의 예약 실행에서 쓰려면 해당 실행 환경/네트워크/자격증명이 다음 실행에도 유지되는지 검증해야 합니다. 이 저장소는 그 스케줄을 만들거나 비밀값을 저장하지 않습니다. 한 소비자만 실행하고, 작업 중 외부 행동의 완료 여부를 확인한 뒤 Discord에 결과를 남겨야 합니다. 설정만으로 항상 연결됐다고 가정하지 마세요.

## 보안 및 운영 한계

- Ed25519 원문 서명 및 타임스탬프 ±5분 검증, 잘못된 서명 401
- 정확한 application/guild/channel/user allowlist, 기본 intake off
- Bot API 목적지는 고정된 `discord.com/api/v10`, 사용자 임의 URL/채널은 받지 않음
- bearer token은 해시 후 constant-time 비교. 짧거나 예시 토큰은 거부
- 본문과 비밀값을 로그에 쓰지 않음, 기본 Workers observability off
- Events 활성화 시 구독·callback secret·opaque OAuth token을 비공개 R2에 암호화 저장. 원 작업/답변은 Discord에 보관되며 서버 보존 정책에 따름
- Discord의 작업/결과가 편집·삭제되면 기록과 중복 판정이 바뀜
- Cloudflare/Discord 처리에 한국 내 residency 보장은 없음. 개인정보/기밀 사용 전 별도 검토
- API 토큰 소유자는 작업을 읽고 채널에 답변을 보낼 수 있음. 신뢰한 소비자에만 전달
- 비용 상한, 외부 rate limiting, 경보, token rotation, 안전한 복구 절차는 운영자가 설정
- `sent`는 Discord가 메시지 ID를 반환했다는 뜻이며 사람이 읽었다는 의미가 아님

## 개발

Rust 버전은 `rust-toolchain.toml`, Rust/npm 의존성은 각각 lockfile로 고정합니다.

```sh
npm ci
npm run build
cargo test --locked
npm run test:worker
npx wrangler deploy --dry-run
```

빌드 스크립트는 Rust가 없으면 공식 rustup을 설치하고, 고정 worker-build를 Cargo 공식 registry에서 설치합니다. Rust release optimization을 적용하며 선택적인 Binaryen 후처리는 생략합니다. 첫 빌드는 네트워크 다운로드가 필요합니다. 로컬에서 GitHub release binary 다운로드가 차단된 경우 같은 공식 프로젝트의 CLI를 Cargo registry에서 빌드하여 `WASM_BINDGEN_BIN` 환경 변수로 지정할 수 있습니다. 실제 계정 접근 거부를 우회하는 절차가 아닙니다.

`npm run deploy`, `npm run register`는 외부 상태를 바꾸므로 운영자가 명시적으로 실행합니다. CI는 빌드·테스트·dry-run만 수행합니다. `VALIDATION.md`에 실제 실행 결과와 미검증 범위를 기록합니다.

## 공식 레퍼런스

- [Discord 공식 Cloudflare Workers 튜토리얼](https://docs.discord.com/developers/tutorials/hosting-on-cloudflare-workers)
- [Interactions: 서명, 초기 응답, token 제한](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Message API: history, metadata, replies, nonce](https://docs.discord.com/developers/resources/message)
- [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits)
- [Cloudflare Rust Workers](https://developers.cloudflare.com/workers/languages/rust/)
- [공식 workers-rs](https://github.com/cloudflare/workers-rs)
- [Deploy 버튼과 secret 설정](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cloudflare Builds 환경](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)

독립 구현이며 Discord/Cloudflare/OpenAI의 공식 dot 연동 제품이라고 주장하지 않습니다.

공식 확장 경로: [MCP Events](https://developers.openai.com/plugins/build/mcp-events), [OAuth 인증](https://developers.openai.com/plugins/build/auth). MCP tools는 구현되어 있으며, Events capability는 문서의 활성화 조건을 모두 충족했을 때만 광고됩니다.
