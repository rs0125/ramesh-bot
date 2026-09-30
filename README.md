# WareOnGo WhatsApp worker

Standalone TypeScript service for the sales team's WhatsApp bot. With an OpenAI key configured, a two-node LangGraph flow produces conversational replies to text DMs and real group @mentions: **converser → formatter**, using `gpt-5.6-terra`. Without a key, the original `hello` behavior remains available. Group replies stay in the triggering group; there is no arbitrary-send endpoint. Supabase stores durable message state and reply jobs; Prisma/SQLite retains encrypted WhatsApp auth and admin state.

The Next.js admin lives in the **separate [ramesh-bot-admin repository](https://github.com/rs0125/ramesh-bot-admin)**, with its own dependencies, lockfile and Vercel workflow. These local checkouts are named `baileys-ramesh` and `baileys-ramesh-admin`; cloned directories can use any names. It talks to this worker through the authenticated `/v1` HTTP API. Neither project imports or builds the other.

## Safe local chat playground

Set `OPENAI_API_KEY` in the gitignored worker `.env`, then run:

```sh
npm run dev:chat
```

Open **http://127.0.0.1:3012**. The playground uses real OpenAI calls and the actual mapper, SQLite claim service, and LangGraph flow. It captures replies in the browser. It never starts the worker application, creates a WhatsApp socket, reads pairing credentials, or connects to Supabase. Its database is `.local/playground.db`, independently migrated on startup; existing `DATABASE_URL` and `MESSAGE_DATABASE_URL` settings are ignored by this command.

Switch between test identities and DM/group contexts to check isolation. **New conversation** clears that context's short-term memory. Conversation memory is currently bounded in-process state: at most six turns per context, 16,000 characters, 200 contexts, and a 30-minute idle lifetime. It resets on restart. SQLite keeps duplicate claims and outcomes, not conversation transcripts or LangGraph checkpoints.

The assistant currently chats and drafts text. CRM, supply, HRMS, reminder tools, employee roster authentication, and writes remain future work. Prompts explicitly prohibit claiming those capabilities. The formatter preserves the draft's facts and uncertainty, removes stock AI phrasing, and a final code guard removes em dashes. Identity/audience isolation here is conversation separation, not employee authorisation.

`OPENAI_MODEL` defaults to `gpt-5.6-terra`. The whole two-stage run has a 45-second deadline, each model response is capped at 800 output tokens, and the SDK permits one bounded retry. Configuration is in [.env.example](.env.example). No API key, request body, or conversation content is included in normal worker logs; stage timings and token counts are logged. Responses use `store: false`.

## Agent evaluations

```sh
# Paid, nondeterministic model calls with synthetic inputs and fake delivery only.
npm run eval:agent -- --trials 3
# Smaller smoke test or separate held-out scenarios.
npm run eval:agent -- --case greeting --trials 2
npm run eval:agent -- --split holdout --trials 3
```

The harness runs 13 scenarios through the SQLite message path, with a fresh conversation per trial. It checks both graph stages completed, SQLite recorded the captured reply, output length, em dashes, and a defined stock-phrase list. Ambiguous-reference scenarios must include a clarification question. A schema-validated Terra judge scores relevance, naturalness, fidelity and capability honesty. Passing requires no mechanical failures, at least 4/5 for the first three scores, and 5/5 for honesty. Exact wording and output variation are not pass conditions.

Reports under `.local/evals/<run>/` include drafts, final replies, judge reasons, per-case pass rates, distinct-output counts, token usage, latency, and prompt/dataset hashes. Review the transcripts: synthetic cases and a same-model judge provide evidence, not a guarantee. Live evals are separate from CI; ordinary tests inject a model fake and require no API key. The harness always uses its own SQLite database and never creates a WhatsApp connection or uses the Supabase queue.

## Local setup

Use Node.js 22.16 or newer within the Node 22 release line:

```sh
npm ci
npm run setup:local
npm run prisma:generate
npm run db:migrate
npm run dev
```

The worker listens on `127.0.0.1:3011` and starts disconnected. `setup:local` fills missing secrets in `.env` without printing them or replacing existing values. Configure the admin separately; its `WORKER_API_TOKEN` must match this worker's token. The admin normally runs at `http://127.0.0.1:3010`.

When ready for a real-account test, use **Connect WhatsApp** in the admin and scan the QR in WhatsApp's Linked devices screen. Current automated checks use simulated events only. Disconnect retains the paired credentials and remains in effect across restarts; reconnect reuses those credentials. `WHATSAPP_AUTO_CONNECT` controls startup only until an operator preference is saved.

## Structure

```text
src/
  app/                     Composition and process lifecycle
  config/                  Validated environment
  contracts/               Worker-owned v1 API types
  modules/greetings/       Eligibility, durable claim, generated reply handoff
  modules/assistant/       LangGraph, prompts, bounded memory and style guard
  infrastructure/
    whatsapp/              SDK adapter, mapping, connection/retry management
    database/              Prisma repositories and encrypted auth storage
    http/                  Authenticated control/session API, bounded bodies
    openai/                Responses adapter, deadlines and redacted errors
  lib/                     Logging, abortable pacing, bounded admission queue
prisma/                    Local auth/admin SQLite schema and migrations
supabase/migrations/       Prefixed PostgreSQL message-state/queue schema
scripts/                   Local setup and capture-only chat playground
playground/                Local chat interface assets
evals/                     Repeated live-model scenarios and structured quality judging
tests/                    Unit/integration tests and fake WhatsApp process
deploy/                   EC2/SSM templates, release helper and rollback tests
.github/workflows/         Independent worker CI and EC2 CD
```

Each module has an entry comment describing its responsibility. Imports do not open connections; `src/index.ts` owns startup. Add future features under `modules/` and keep transport/storage dependencies in adapters.

## Behavior and guarantees

- Accepts recent DMs and genuine group mentions, including phone-number and LID addressing. Ignores history batches, own messages, reactions, non-text system traffic and stale messages.
- With `MESSAGE_DATABASE_URL` configured, persists eligible messages in Supabase. The agent consumes `ramesh-inbound-queue` and atomically saves finalized replies to `ramesh-outbound-queue`; the sender delivers those saved replies without regenerating them. `ramesh-messages`, `ramesh-message-events`, and `ramesh-schema-migrations` hold state, history, and migration versions. Duplicate events and uncertain deliveries do not trigger another send attempt. The normal eligibility window is five minutes; terminal metadata expires after 30 days. See the [queue contract](docs/supabase-message-queue.md).
- Uses one leased job per account, fenced ownership tokens, bounded recovery attempts, and a durable `SENDING` marker. Unsent work survives restarts. Interrupted/failed sends become `UNCERTAIN` rather than being resent. This is **at most one application send attempt**, not a guarantee of delivery.
- Adds a fresh random delay of 1.5–4 seconds before each eligible reply. Replies remain ordered across chats for the account; messages are not merged. `REPLY_DELAY_MIN_MS` and `REPLY_DELAY_MAX_MS` configure the inclusive range (0–60000 ms). Message age and lease ownership are checked before sending.
- Disconnect, lost connections and auth-storage failures cancel pending delay timers. Durable work that has not been sent returns to the queue and can resume if still recent. Active sends are awaited subject to the send and process deadlines. Transient reconnects use exponential backoff with jitter, capped at 30 seconds; revoked/forbidden/replaced sessions require operator action.
- Model generation shares the session cancellation signal. The durable lease includes the graph deadline, pacing, send timeout and database margin. Eligibility is checked again after generation and before sending. Short-term memory is updated only after the transport accepts the reply. This first version retains serial processing per account; long model runs can delay other chats.
- Persists Baileys credentials and Signal keys in Prisma using AES-256-GCM with authenticated row identities. Atomic key batches fail closed; a storage failure closes the socket.
- Bounds the message/control queues and HTTP bodies, caps send time, attempts to finish active sends within the shutdown deadline, and clears obsolete QR codes.
- Persists admin session hashes, logout revocation and login limits centrally, so Vercel instances share them. The admin password is an operational control; employee/CRM authorization remains a plan.

See [.env.example](.env.example) for settings. Back up `AUTH_ENCRYPTION_KEY` separately from the SQLite database; losing it prevents reuse of the paired session. Keep one active worker per linked account. This schema is owned by the bot and must not be applied to the CRM database.

Read [Supabase setup, state semantics, and queue recovery](docs/supabase-message-queue.md) before configuring `MESSAGE_DATABASE_URL`. Keep `DATABASE_URL` as SQLite. Fresh development databases without a message connection retain the original SQLite greeting mode; after Supabase is enabled, a persistent marker prevents silent fallback. Legacy greeting claims are imported without creating send jobs. The browser test fixture does not use the production Supabase connection.

Pacing is a traffic-smoothing control, not an anti-detection guarantee or a published Meta limit. Baileys is an unofficial client even for internal automation. WhatsApp messages arrive over its socket. Idle queue polling contacts PostgreSQL, and admin status polling contacts the worker; neither polls WhatsApp. Keep the SDK's heartbeat behavior intact.

## Checks and deployment

```sh
npm run check
```

This runs schema validation, TypeScript, SQLite/HTTP integration tests, deployment guard/rollback tests, the worker build and formatting. PostgreSQL integration tests additionally run when `TEST_MESSAGE_DATABASE_URL` points to the isolated local `ramesh_queue_test` database; CI configures it automatically. See the [Podman test instructions](docs/supabase-message-queue.md#verification). Tests use temporary databases and synthetic credentials. They never connect to WhatsApp.

The admin's browser suite can also test this real worker with a fake transport:

```sh
cd ../baileys-ramesh-admin
BOT_WORKER_DIR=../baileys-ramesh npm run test:e2e
```

Build the admin and install Playwright Chromium first, as described in its README. `BOT_WORKER_DIR` is an optional test setting, not a runtime dependency.

CI/CD follows the neighboring `warehouse-enricher` repository: successful main CI → GitHub OIDC → restricted SSM document → exact tested commit → stable health/authentication checks and rollback. CD is gated by `EC2_DEPLOY_ENABLED=true`. EC2 owns the live paired session; the earlier local pairing has been retired. A first Supabase cutover requires separately provisioning its tables/runtime configuration and pausing the sender while changing storage. Do not run the retired local pairing alongside EC2.

Read the [detailed current implementation and architecture](docs/current-implementation.md) for the complete message flow, admin/API contracts, persistence, pacing, deployment assumptions, tests, and extension boundaries. Additional references: [deployment and recovery](docs/deployment-vercel-ec2.md), [architecture/API overview](docs/architecture.md), and the preserved [product context and rough authorization plan](CONTEXT.md).

Dependency note: the Prisma config dependency overrides `deepmerge-ts` to patched version 8 for [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). Schema generation, migration deployment and migration diff are covered by local checks; remove the override when the upstream Prisma dependency includes the fix.
