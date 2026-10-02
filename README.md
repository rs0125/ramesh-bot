# WareOnGo WhatsApp worker

Production status (2 October 2026): Sol at medium reasoning runs separate converser → planner → worker/tool-executor → formatter → verifier roles; ordinary chat skips planning. CRM, supply and knowledge reads are enabled for active employees within their Context Engine permissions. Images, PDFs and voice notes use encrypted owner-scoped media records with 24-hour expiry. Forwarded messages/media use sliding inbound batching (1-second ordinary text, 3-second burst window, 8-second cap). See the [capability review](docs/capability-review-2026-10-02.md) and [module specifications](docs/agent-modules/README.md). Real-data cases and transcripts remain under gitignored `.local/private-evals/`; `npm run eval:private` refuses CI.

Standalone TypeScript service for Ramesh, a personal chief of staff for anyone messaging it. OpenAI Responses and LangGraph handle DMs and real group @mentions. Business reads are private to verified employees in DMs. Without business configuration, a two-node converser/formatter flow remains available; without an API key, the original `hello` behavior remains available. Supabase stores the encrypted inbox, recent conversational context, message state, and separate `ramesh-inbound-queue` and `ramesh-outbound-queue` tables. Prisma/SQLite retains encrypted WhatsApp auth and admin state. Operators can read conversations and send messages as Ramesh to existing chats from the admin.

The Next.js admin lives in the **separate [ramesh-bot-admin repository](https://github.com/rs0125/ramesh-bot-admin)**, with its own dependencies, lockfile and Vercel workflow. These local checkouts are named `baileys-ramesh` and `baileys-ramesh-admin`; cloned directories can use any names. It talks to this worker through the authenticated `/v1` HTTP API. Neither project imports or builds the other.

Documentation reviewed on **2 October 2026**. Production has business reads enabled, the worker roster SELECT/RLS policy installed, and 14 signed CRM/supply/knowledge tools available to an authorized admin. GA4/Search Console add three tools in the local full-scope profile; their signing-scope rollout is still pending in production. The real-data playground runs as Raghav with capture-only delivery. Durable paused tasks, reminders and writes remain deferred. See the [personal-assistant runbook](docs/sales-manager-agent.md) and [architecture plan](docs/assistant-architecture-plan.md).

The [delivery incident review](docs/agent-modules/40-delivery-acknowledgements.md)
documents the concurrent LID lookup correction, neutral retry notices and explicit
normal delivery receipts. Voice replies retain same-owner transcripts in italic
quotes, including when business output must be withheld.

Detailed [agent module specifications](docs/agent-modules/README.md) define the proposed role interfaces, identity and tool boundaries, Supabase run state, delivery, reminders, writes and evaluation requirements before implementation.

Apply migrations through `202610020005_media_and_batches.sql` before deploying this worker, even with business reads disabled. No production migration, environment update or deployment is implied by editing this checkout. See the [first-read runbook](docs/first-crm-read.md) for activation and rollback, and [inbox operations](docs/supabase-message-queue.md#inbox-context-and-operator-sends).

## Safe local chat playground

### Real CRM on Supabase

The local private configuration is provisioned for Raghav. The current full-catalogue profile uses the actual Context Engine running locally against real sources. With that service running, use:

```sh
PLAYGROUND_ENV_FILE=.local/live-playground-sol-eval.env PLAYGROUND_PORT=3012 npm run dev:chat:live
```

Open **http://127.0.0.1:3012**, refresh an existing tab, and try **All my follow-ups**, a pipeline summary, warehouse search or company knowledge request. This profile uses real Sol calls, the live employee roster and signed Context Engine MCP reads. Requests and replies go through `ramesh-test-inbound-queue` and `ramesh-test-outbound-queue` in Supabase. A dedicated login separates them from production queues; the outbound transport is constrained to `capture` and the process never creates a Baileys session. Employee identity is pinned server-side. Unknown users and groups cannot read CRM data.

`npm run smoke:chat:live` checks the real read, saved-output replay and access boundaries without sending WhatsApp messages. See the [live playground runbook](docs/live-data-playground.md) for provisioning, private configuration, retention, supported requests and test evidence. The agent discovers all permitted CRM, supply, knowledge and analytics reads. HRMS, reminders and writes remain unconnected. This harness does not deploy or enable the production pilot.

### Synthetic chat and CRM fixtures

Set `OPENAI_API_KEY` in the gitignored worker `.env`, then run:

```sh
npm run dev:chat
```

Open **http://127.0.0.1:3012**. The playground uses real OpenAI calls and the actual mapper, SQLite claim service, and LangGraph flow. It captures replies in the browser. It never starts the worker application, creates a WhatsApp socket, reads pairing credentials, or connects to Supabase. Its database is `.local/playground.db`, independently migrated on startup; existing `DATABASE_URL` and `MESSAGE_DATABASE_URL` settings are ignored by this command.

Switch between test identities and DM/group contexts to check isolation. Participants share their group's context; DMs and other groups remain separate. **New conversation** clears that context's short-term memory. This isolated playground uses bounded in-process memory: at most 32 messages per context, 48,000 characters, 200 contexts, and a 30-minute idle lifetime. It resets on restart. The Supabase-enabled worker instead reads recent history from its persistent inbox.

The default synthetic playground chats and drafts text. Run `PLAYGROUND_CRM_FIXTURES=true npm run dev:chat` to try “my follow-ups today” against fake CRM data, including the read and delivery checks. This command does not contact Context Engine or authorize real employees; use `dev:chat:live` for real data. Ordinary replies retain the style guards; verified CRM facts use deterministic formatting. Both GUI modes use port 3012 by default, so run one at a time or override `PLAYGROUND_PORT`.

`OPENAI_MODEL` defaults to `gpt-5.6-terra`. The whole two-stage run has a 45-second deadline, each model response is capped at 800 output tokens, and the SDK permits one bounded retry. Configuration is in [.env.example](.env.example). No API key, request body, or conversation content is included in normal worker logs; stage timings and token counts are logged. Responses use `store: false`.

## Context Engine MCP services

The repository includes a reusable MCP client and thin CRM, supply, knowledge and analytics services. The personal-assistant loop uses `createBusinessReads` in `src/app/business-reads.ts`, enabled only with `BUSINESS_READS_ENABLED=true`, active employee eligibility (`BUSINESS_READ_EMPLOYEE_IDS=all` by default; a numeric list is optional), Supabase storage and signed credentials. It exposes the complete permitted read catalogue, currently seventeen tools for an authorized admin with all four registered read scopes. The generic `createContextEngineServices` factory still requires an employee credential resolver and otherwise grants no access.

Each read uses a fresh MCP connection, discovers permitted read tools and checks `get_context.employee_id` against the verified employee before a business tool. The preferred adapter signs employee-scoped requests to `/mcp/ramesh` with a service key; Context Engine independently enforces current employee permissions. Results retain source IDs, cursors, freshness, access scope and uncertainty. Transport deadlines, response limits, cancellation and redacted errors apply.

`createSignedEmployeeContextAccess` supplies the preferred resolver: trusted phone or reciprocal Baileys LID mapping → one active `VerifiedNumber` employee → a fresh signed request. No employee OAuth enrollment or refresh storage is needed. Unknown users can chat without business access; group business reads are denied. The earlier OAuth adapter remains available for compatibility.

See [signed identity and operations](docs/signed-context-auth.md), [the MCP service contract](docs/assistant-architecture-plan.md#20-context-engine-mcp-service-scaffold) and [first-read behavior](docs/first-crm-read.md). `npm run db:identity` provisions the worker's roster column grant; verify any live roster RLS policies also permit that worker. Claude keeps its separate OAuth connector. The live playground reuses signed MCP through its own runtime and separately provisioned roster SELECT policy.

## Agent evaluations

```sh
# No paid request: inspect the registry.
npm run eval:conversations -- --suite all --list
# Small Luna agent + grader screen, one trial per case.
npm run eval:ci -- --case changed-history,source-label-crm-name,source-label-knowledge-title
# One focused repeated check.
npm run eval:conversations -- --case ordinal-reference --trials 2
```

The [current conversation harness](evals/README.md) runs the real OpenAI model through the employee tool graph with fictional CRM, supply, knowledge and analytics evidence. It covers personal assistance, 32-message context, corrected requirements, revoked access, source failures and multi-step research. It records every tool proposal, answer, review, failure, prompt/code hash, duration and returned token usage. JSON, JUnit and Markdown reports go into `.local/ci-evals`. Any failed trial exits nonzero; a model judge cannot override hard tool/privacy/format checks. Paid CI is manual only. Agent and grader default to Luna, one trial and a three-trial allowance. Every Sol run requires explicit user approval and `--sol-approval <reference>`; larger runs require an explicit `--max-trials`. Production model settings do not select the test model. Deterministic PR checks need no API key. No eval creates a WhatsApp session.

The historical `eval:agent` harness runs 13 ordinary-chat scenarios through isolated SQLite, with a fresh conversation per trial. It checks both graph stages completed, SQLite recorded the captured reply, output length, em dashes, and a defined stock-phrase list. Ambiguous-reference scenarios must include a clarification question. A schema-validated Terra judge scores relevance, naturalness, fidelity and capability honesty. Passing requires no mechanical failures, at least 4/5 for the first three scores, and 5/5 for honesty. Exact wording and output variation are not pass conditions.

Its reports under `.local/evals/<run>/` include drafts, final replies, judge reasons, per-case pass rates, distinct-output counts, token usage, latency, and prompt/dataset hashes. Review the transcripts: synthetic cases and a same-model judge provide evidence, not a guarantee.

The general sales harness runs 17 cases with one trial per selected case by default and the same spending controls, uses a snapshot of the real tool schemas with synthetic facts, has no transport, and saves all outputs/tool arguments/checks under `.local/sales-evals/`. The [legacy context/media review](docs/agent-modules/23-context-and-media-reference.md) records the old logistics bot patterns; [the implemented media contract](docs/agent-modules/30-media-lifecycle.md) defines the new 24-hour lifecycle.

The historical business harness runs 15 cases with three real-model trials each by default and writes `.local/business-evals/<run>/report.json` and `report.md`. It checks routing, exact tool scope, read/delivery call counts, evidence presence, refusal boundaries and factual caveats against synthetic CRM fixtures. It keeps all failures; PostgreSQL tests separately validate persistence and authorization fencing. The separate `smoke:chat:live` command uses current Supabase/Context Engine data and reports metadata only.

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

- Saves incoming DMs and all ordinary group messages, including untagged text and media labels/captions. Eligible supported attachments are processed through the private 24-hour media service; unmentioned group attachments remain labels only. Historical sync batches, own-message echoes, reactions, and protocol/system events are excluded.
- Automatic replies require a recent supported message and, in groups, a genuine mention. Change `GROUP_REPLIES_REQUIRE_MENTION` in `src/config/group-policy.ts` to `false` to reply to all group text messages; recording group context is always enabled.
- With `MESSAGE_DATABASE_URL` configured, persists the inbox in Supabase. Untagged messages use `OBSERVED` with no reply job. Eligible requests enter `ramesh-inbound-queue`, and finalized replies enter `ramesh-outbound-queue` atomically. Admin text goes directly to the same outbound queue. Duplicate requests and uncertain deliveries do not trigger another send attempt. The normal reply window is five minutes; terminal inbox content and metadata expire after 30 days. See the [queue contract](docs/supabase-message-queue.md).
- Uses one leased job per account, fenced ownership tokens, bounded recovery attempts, and a durable `SENDING` marker. Unsent work survives restarts. Interrupted/failed sends become `UNCERTAIN` rather than being resent. This is **at most one application send attempt**, not a guarantee of delivery.
- Adds a fresh random delay of 1.5–4 seconds before each eligible reply. Reply jobs remain ordered across chats for the account; a durable same-sender burst can combine messages into one turn. `REPLY_DELAY_MIN_MS` and `REPLY_DELAY_MAX_MS` configure the inclusive range (0–60000 ms). Message age and lease ownership are checked before sending.
- Disconnect, lost connections and auth-storage failures cancel pending delay timers. Durable work that has not been sent returns to the queue and can resume if still recent. Active sends are awaited subject to the send and process deadlines. Transient reconnects use exponential backoff with jitter, capped at 30 seconds; revoked/forbidden/replaced sessions require operator action.
- Model generation shares the session cancellation signal. The durable lease includes the graph deadline, pacing, send timeout and database margin. Eligibility is checked again after generation and before sending. Short-term memory is updated only after the transport accepts the reply. This first version retains serial processing per account; long model runs can delay other chats.
- Persists Baileys credentials and Signal keys in Prisma using AES-256-GCM with authenticated row identities. Atomic key batches fail closed; a storage failure closes the socket.
- Bounds the message/control queues and HTTP bodies, caps send time, attempts to finish active sends within the shutdown deadline, and clears obsolete QR codes.
- Persists admin session hashes, logout revocation and login limits centrally, so Vercel instances share them. The admin password is an operational control; employee CRM authority comes from the separate trusted-identity/signed-request adapter when business tools are enabled.

See [.env.example](.env.example) for settings. Back up `AUTH_ENCRYPTION_KEY` separately from both databases; losing it prevents reuse of the paired session and pending encrypted payloads. Keep one active worker per linked account. Apply the Prisma schema only to the bot's local SQLite database; the separate prefixed PostgreSQL migrations own the Supabase message tables without changing CRM business tables.

SQLite retains the previously shipped encrypted OAuth tables for the optional legacy adapter. Signed access does not use them; its SQLite dependency is the existing encrypted Baileys LID/auth store. Context Engine keeps only short-lived replay hashes in Supabase. The worker roster provisioner grants SELECT on four employee columns and makes no business-row changes.

Read [Supabase setup, state semantics, and queue recovery](docs/supabase-message-queue.md) before configuring `MESSAGE_DATABASE_URL`. Keep `DATABASE_URL` as SQLite. Fresh development databases without a message connection retain the original SQLite greeting mode; after Supabase is enabled, a persistent marker prevents silent fallback. Legacy greeting claims are imported without creating send jobs. The live playground uses its own `PLAYGROUND_DATABASE_URL` and test tables on Supabase, with no SQLite or production-queue fallback.

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
| [Live-data playground](docs/live-data-playground.md)               | Real CRM as Raghav, isolated Supabase capture queues, setup and live smoke checks        |
| [Signed Context Engine access](docs/signed-context-auth.md)        | Preferred first-party identity, signing, keys and replay protection                      |
| [Employee identity and OAuth](docs/employee-identity-and-oauth.md) | Trusted sender mapping, encrypted grants, enrollment commands, expiry, and revocation    |
| [EC2 operations](docs/ec2-operations.md)                           | Current private deployment, SSM tunnel, runtime configuration, and backups               |
| [Deployment guide](docs/deployment-vercel-ec2.md)                  | Independent release automation and the future public HTTPS/Vercel rollout                |
| [Product context](CONTEXT.md)                                      | Confirmed decisions, organisational sources, and earlier options                         |

The fake chat GUI uses local port **3012**; the documented SSM tunnel uses **3013**. The pairing admin at **3010** is an operations surface and is separate from the fake chat GUI.

Dependency note: the Prisma config dependency overrides `deepmerge-ts` to patched version 8 for [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). Schema generation, migration deployment and migration diff are covered by local checks; remove the override when the upstream Prisma dependency includes the fix.

## Personal-assistant prompts and CI evals

Role prompts are separate editable files under [`src/prompts/`](src/prompts/), loaded once and included in the build. Restart after editing. `npm run eval:ci` selects explicit cases from 85 scenarios using Luna by default and a bounded trial allowance, retaining every result with JSON, JUnit and Markdown reports. The [evaluation guide](evals/README.md) covers protected CI setup, real-source capture checks, measured results and limitations.

Latest local validation: [evaluation, graph and voice refinements](evals/results/2026-10-02-eval-refinement.md). The complete v18 model run scored 138/148; later targeted v19 repairs and explicitly separate regrading are recorded with their exact scope. The full stochastic gate is not claimed green.

Voice transcripts are quoted in italics before one common answer for a batch. The delivery layer reads the exact STT text from expiring media, while durable history stores only references and the answer. Configure `OPENAI_STT_API_KEY` independently of the assistant key and `OPENAI_TRANSCRIBE_MODEL` independently of the assistant model. See [voice delivery](docs/agent-modules/35-voice-transcripts.md) and [current model comparison](evals/results/2026-10-02-stt-comparison.md).

The [production evaluation review](docs/agent-modules/37-production-evaluation.md) maps current primary-source guidance to this harness. Human-labelled holdouts, a required release gate and sampled production quality monitoring remain proposed; the current manual/weekly evaluation workflow does not block every deployment.
