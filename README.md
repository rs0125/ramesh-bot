# WareOnGo WhatsApp worker

Standalone TypeScript service for the sales team's WhatsApp bot. With an OpenAI key configured, a two-node LangGraph flow produces conversational replies to text DMs and real group @mentions: **converser → formatter**, using `gpt-5.6-terra`. Without a key, the original `hello` behavior remains available. Supabase stores the encrypted inbox, recent conversational context, message state, and separate `ramesh-inbound-queue` and `ramesh-outbound-queue` tables. Prisma/SQLite retains encrypted WhatsApp auth and admin state. Operators can read conversations and send messages as Ramesh to existing chats from the admin.

The Next.js admin lives in the **separate [ramesh-bot-admin repository](https://github.com/rs0125/ramesh-bot-admin)**, with its own dependencies, lockfile and Vercel workflow. These local checkouts are named `baileys-ramesh` and `baileys-ramesh-admin`; cloned directories can use any names. It talks to this worker through the authenticated `/v1` HTTP API. Neither project imports or builds the other.

Documentation reviewed on **1 October 2026**, including the employee identity and OAuth adapters. The conversational flow and queue split are deployed. The MCP services and credential lifecycle are implemented but disconnected from the chat graph; planner, worker, verifier, reminders, and business writes are deferred. The [architecture plan](docs/assistant-architecture-plan.md) contains the supplied system diagram, organisational context, decisions, research, and next milestones.

The inbox addition requires migration `202610010003_inbox.sql` before deploying this worker, followed by the matching admin update. Editing this checkout does not roll it out. See [inbox, context, and operator sends](docs/supabase-message-queue.md#inbox-context-and-operator-sends).

## Safe local chat playground

Set `OPENAI_API_KEY` in the gitignored worker `.env`, then run:

```sh
npm run dev:chat
```

Open **http://127.0.0.1:3012**. The playground uses real OpenAI calls and the actual mapper, SQLite claim service, and LangGraph flow. It captures replies in the browser. It never starts the worker application, creates a WhatsApp socket, reads pairing credentials, or connects to Supabase. Its database is `.local/playground.db`, independently migrated on startup; existing `DATABASE_URL` and `MESSAGE_DATABASE_URL` settings are ignored by this command.

Switch between test identities and DM/group contexts to check isolation. Participants share their group's context; DMs and other groups remain separate. **New conversation** clears that context's short-term memory. This isolated playground uses bounded in-process memory: at most 12 messages per context, 16,000 characters, 200 contexts, and a 30-minute idle lifetime. It resets on restart. The Supabase-enabled worker instead reads recent history from its persistent inbox.

The assistant currently chats and drafts text. CRM, supply, HRMS, reminder tools, and writes remain disconnected. Prompts explicitly prohibit claiming those capabilities. The formatter preserves the draft's facts and uncertainty, removes stock AI phrasing, and a final code guard removes em dashes. The playground's synthetic identities provide conversation separation; they do not enroll employees or authorize business reads.

`OPENAI_MODEL` defaults to `gpt-5.6-terra`. The whole two-stage run has a 45-second deadline, each model response is capped at 800 output tokens, and the SDK permits one bounded retry. Configuration is in [.env.example](.env.example). No API key, request body, or conversation content is included in normal worker logs; stage timings and token counts are logged. Responses use `store: false`.

## Context Engine MCP services

The repository now includes a reusable MCP client and thin CRM, supply, and knowledge services. They are scaffolded for the future worker and are **not connected to the current chat graph**. `createContextEngineServices` in `src/app/context-engine.ts` is the composition point; it requires endpoint configuration and an employee credential resolver. The default resolver grants no access.

Each read uses a fresh MCP connection, discovers permitted read tools, and checks `get_context.employee_id` against the verified employee before calling a business tool. Credentials are employee OAuth access tokens, never the REST key or a shared admin token. Results retain source IDs, cursors, freshness, access scope, and uncertainty for later verification. Requests have a total deadline, response-size limits, cancellation, and redacted errors. Tests exercise the real SDK with synthetic HTTP responses.

`createEmployeeContextAccess` now supplies the concrete resolver: trusted phone or reciprocal Baileys LID mapping → one active `VerifiedNumber` employee → that employee's encrypted OAuth grant. It implements PKCE enrollment, employee-ID verification, serialized refresh rotation, expiry, revocation, and live roster rechecks. Unknown users can chat but receive no business credential; group business reads remain denied.

See [employee identity, enrollment, and operations](docs/employee-identity-and-oauth.md) and [the MCP service contract](docs/assistant-architecture-plan.md#20-context-engine-mcp-service-scaffold). Operator commands are `npm run db:identity` and `npm run context:auth`. Live enrollment requires an owned, allowlisted callback and employee consent. The current chat graph and fake GUI do not invoke these adapters. Planner, worker, and verifier agents remain deferred.

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
  modules/context-engine/  Read-tool contract, credential port and domain services
  modules/identity/        Live employee roster resolution and canonical phone binding
  infrastructure/
    whatsapp/              SDK adapter, mapping, connection/retry management
    database/              SQLite auth/admin and PostgreSQL queue repositories
    http/                  Authenticated control/session API, bounded bodies
    openai/                Responses adapter, deadlines and redacted errors
    context-engine/        Employee-scoped MCP transport and evidence validation
  lib/                     Logging, abortable pacing, bounded admission queue
prisma/                    Local auth/admin/OAuth SQLite schema and migrations
supabase/migrations/       Prefixed PostgreSQL message-state/queue schema
scripts/                   Local setup and capture-only chat playground
playground/                Local chat interface assets
evals/                     Repeated live-model scenarios and structured quality judging
tests/                     Unit/integration tests and fake WhatsApp process
deploy/                    EC2/SSM templates, release helper and rollback tests
.github/workflows/         Independent worker CI and EC2 CD
```

Each module has an entry comment describing its responsibility. Imports do not open connections; `src/index.ts` owns startup. Add future features under `modules/` and keep transport/storage dependencies in adapters.

## Behavior and guarantees

- Saves incoming DMs and all ordinary group messages, including untagged text and media labels/captions. File contents are not downloaded or interpreted. Historical sync batches, own-message echoes, reactions, and protocol/system events are excluded.
- Automatic replies still require recent text and, in groups, a genuine mention. Change `GROUP_REPLIES_REQUIRE_MENTION` in `src/config/group-policy.ts` to `false` to reply to all group text messages; recording group context is always enabled.
- With `MESSAGE_DATABASE_URL` configured, persists the inbox in Supabase. Untagged messages use `OBSERVED` with no reply job. Eligible requests enter `ramesh-inbound-queue`, and finalized replies enter `ramesh-outbound-queue` atomically. Admin text goes directly to the same outbound queue. Duplicate requests and uncertain deliveries do not trigger another send attempt. The normal reply window is five minutes; terminal inbox content and metadata expire after 30 days. See the [queue contract](docs/supabase-message-queue.md).
- Uses one leased job per account, fenced ownership tokens, bounded recovery attempts, and a durable `SENDING` marker. Unsent work survives restarts. Interrupted/failed sends become `UNCERTAIN` rather than being resent. This is **at most one application send attempt**, not a guarantee of delivery.
- Adds a fresh random delay of 1.5–4 seconds before each eligible reply. Replies remain ordered across chats for the account; messages are not merged. `REPLY_DELAY_MIN_MS` and `REPLY_DELAY_MAX_MS` configure the inclusive range (0–60000 ms). Message age and lease ownership are checked before sending.
- Disconnect, lost connections and auth-storage failures cancel pending delay timers. Durable work that has not been sent returns to the queue and can resume if still recent. Active sends are awaited subject to the send and process deadlines. Transient reconnects use exponential backoff with jitter, capped at 30 seconds; revoked/forbidden/replaced sessions require operator action.
- Model generation shares the session cancellation signal. The durable lease includes the graph deadline, pacing, send timeout and database margin. Eligibility is checked again after generation and before sending. Short-term memory is updated only after the transport accepts the reply. This first version retains serial processing per account; long model runs can delay other chats.
- Persists Baileys credentials and Signal keys in Prisma using AES-256-GCM with authenticated row identities. Atomic key batches fail closed; a storage failure closes the socket.
- Bounds the message/control queues and HTTP bodies, caps send time, attempts to finish active sends within the shutdown deadline, and clears obsolete QR codes.
- Persists admin session hashes, logout revocation and login limits centrally, so Vercel instances share them. The admin password is an operational control; employee CRM authority comes from the separate roster/OAuth adapter when future tools are connected.

See [.env.example](.env.example) for settings. Back up `AUTH_ENCRYPTION_KEY` separately from both databases; losing it prevents reuse of the paired session and pending encrypted payloads. Keep one active worker per linked account. Apply the Prisma schema only to the bot's local SQLite database; the separate prefixed PostgreSQL migrations own the Supabase message tables without changing CRM business tables.

SQLite also stores encrypted employee OAuth grants and enrollment/revocation state. After restoring old credentials, revoke/re-enroll affected grants instead of replaying potentially consumed refresh tokens. The roster provisioner adds SELECT for only four `VerifiedNumber` columns; it performs no business-row writes.

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

## Documentation map

| Document                                                           | Use it for                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [Current implementation](docs/current-implementation.md)           | Running behavior, source map, limits, API contracts, and test evidence                   |
| [Architecture and API](docs/architecture.md)                       | Compact topology and application boundaries                                              |
| [Assistant architecture plan](docs/assistant-architecture-plan.md) | Consolidated system design, MCP service contract, deferred agents, reminders, and writes |
| [Supabase queues](docs/supabase-message-queue.md)                  | Exact table names, atomic handoff, recovery, migrations, and local PostgreSQL tests      |
| [Employee identity and OAuth](docs/employee-identity-and-oauth.md) | Trusted sender mapping, encrypted grants, enrollment commands, expiry, and revocation    |
| [EC2 operations](docs/ec2-operations.md)                           | Current private deployment, SSM tunnel, runtime configuration, and backups               |
| [Deployment guide](docs/deployment-vercel-ec2.md)                  | Independent release automation and the future public HTTPS/Vercel rollout                |
| [Product context](CONTEXT.md)                                      | Confirmed decisions, organisational sources, and earlier options                         |

The fake chat GUI uses local port **3012**; the documented SSM tunnel uses **3013**. The pairing admin at **3010** is an operations surface and is separate from the fake chat GUI.

Dependency note: the Prisma config dependency overrides `deepmerge-ts` to patched version 8 for [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). Schema generation, migration deployment and migration diff are covered by local checks; remove the override when the upstream Prisma dependency includes the fix.
