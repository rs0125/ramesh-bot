# Supabase inbound and outbound queues

Production status (**3 October 2026**, release [e0b7232](https://github.com/rs0125/ramesh-bot/commit/e0b723290478da646809af1542a343d49b913b07)): up to three chats can progress together with ordered turns within each chat and one outbound delivery lease. Completed native model responses have encrypted, lease-fenced replay checkpoints. The separate converser → planner → worker/tool-executor → formatter → verifier roles remain; ordinary chat skips planning. Images, PDFs and voice notes use encrypted owner-scoped media records with 24-hour expiry. Forwarded messages and media use durable sliding inbound batching (1-second ordinary text, 3-second burst window, 8-second cap). The capture GUI accepts attachments and overlapping messages, with one response per batch. See [module specifications](agent-modules/README.md) for current contracts and deployment prerequisites. Real-data private outcome cases and transcripts remain only under gitignored `.local/private-evals/`; `npm run eval:private` refuses CI.

Reviewed **3 October 2026**. Split queues, per-chat concurrency and encrypted model-response replay are deployed. Production migrations `202610020006` (usage ledger), `202610030004` and `202610030005`, plus independent capture migrations `202610020003` (usage ledger) and `202610030005`, are applied. The [outbound automation API](agent-modules/48-outbound-automation-api.md) is implemented separately; its production migration `202610030006` is applied and restricted-role verification passed. Code is deployed in `3ad3408`; WhatsApp is connected and HTTPS authorization probes pass. The broader [architecture plan](assistant-architecture-plan.md) covers future reminder and tool workflows.

The worker persists incoming WhatsApp messages, finalized outgoing replies, state history and the agent journal in WareOnGo Supabase PostgreSQL. The deployed recovery implementation uses `ramesh-agent-checkpoints`. Application tables use the literal `ramesh-` prefix in `public`; SQL identifiers containing the hyphen must be double-quoted. The [personal-assistant integration](sales-manager-agent.md) uses the same inbound-to-outbound handoff.

The real-data playground uses separate `ramesh-test-inbound-queue`, `ramesh-test-outbound-queue`, `ramesh-test-agent-events` and `ramesh-test-schema-migrations` tables on this Supabase project. Capture migration `202610030005` adds `ramesh-test-agent-checkpoints` for the same replay contract. Those are independently provisioned through `db:playground`, use the `ramesh_playground` login and a capture-only sink, and are inaccessible to `ramesh_worker`. The playground cannot access the production queues below. Its setup does not apply pending production migrations. See [live-data capture operations](live-data-playground.md).

WhatsApp still pushes messages through the Baileys connection. The worker polls **its own PostgreSQL queue**, not WhatsApp. The admin browser's separate status polling is unchanged.

## Tables

Production scheduling release `2bf91be` uses migration `202610030007`, applied and verified on 3 October 2026, with personal tools and due processing enabled. It adds `ramesh-tasks`, `ramesh-reminders`, `ramesh-reminder-occurrences` and `ramesh-assistant-commands`, separating long-lived intent from short-lived delivery jobs. This release's readiness check requires **`202610030008`**, which adds the encrypted, 24-hour personal-context command kind and indexes. That migration was **applied and verified in production on 3 October 2026**, including checksum, restricted-worker schema health, role grants and RLS, with runtime credentials, TLS and flags preserved. Deploy the matching worker through CI/CD after pushing `main`, then verify the exact release and runtime health. Fresh installations must apply the ordered, checksum-verified migrations before starting this worker. See [activation and current behavior](personal-scheduling.md); the capture schema is unchanged.

Reminder jobs use `origin='reminder'`. Unsent reminders yield to pending human work in the same chat, preserving the ordering of non-reminder work. `SENDING` remains the irreversible boundary. Final delivery additionally checks current identity, schedule revision, occurrence generation, linked task state and fixed expiry.

| Table                               | Purpose                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `public."ramesh-messages"`          | One row per account/chat/WhatsApp-message ID: state, expiry, encrypted pending payload, completion time, and a short reason code |
| `public."ramesh-inbound-queue"`     | Incoming work for the agent: availability, lease token/deadline, attempts, and processing outcome                                |
| `public."ramesh-outbound-queue"`    | Finalized encrypted replies for the sender: availability, lease token/deadline, delivery attempts, and outcome                   |
| `public."ramesh-message-events"`    | Transactional history of message state transitions, written by a database trigger                                                |
| `public."ramesh-schema-migrations"` | Applied migration version, checksum, and time                                                                                    |
| `public."ramesh-agent-runs"`        | One fenced run per inbound message, attempt and finalization status                                                              |
| `public."ramesh-agent-events"`      | Append-only encrypted tool receipts and finalization events                                                                      |
| `public."ramesh-agent-checkpoints"` | Encrypted ordered model responses, original clocks, execution counters and retry policy, fenced by the inbound lease             |

The base migration is [202610010001_message_queue.sql](../supabase/migrations/202610010001_message_queue.sql); [202610010002_split_queues.sql](../supabase/migrations/202610010002_split_queues.sql) renames the old job table in place and adds the outbound table. Existing rows and history are preserved. `ramesh-message-jobs` becomes an updatable compatibility **view** over the inbound table so the previous release can finish work during deployment. New application code uses the explicit queue names. These migrations do not alter CRM tables or run SQLite Prisma migrations against Supabase.

## Processing path

```mermaid
flowchart TD
    Event[Baileys notify event] --> Map[Map and check eligibility]
    Map --> Save[Atomically insert message and inbound job]
    Save --> Inbound[(ramesh-inbound-queue)]
    Inbound --> Claim[Agent claims inbound work]
    Claim --> Processing[PROCESSING with a fenced lease]
    Processing --> Agent[LangGraph with encrypted model-response replay]
    Agent <--> Checkpoint[(ramesh-agent-checkpoints)]
    Agent --> Handoff[Atomically finish inbound and save encrypted reply]
    Handoff --> Outbound[(ramesh-outbound-queue)]
    Outbound --> Sender[Sender claims due output]
    Sender --> Delay[Random reply delay and age recheck]
    Delay --> Marker[Commit SENDING before calling WhatsApp]
    Marker --> Send[Send generated reply through current Baileys session]
    Send --> Success[SENT / job DONE]
    Send --> Uncertain[UNCERTAIN / job DEAD if delivery is ambiguous]
```

Admission is serialized in a small bounded in-memory buffer. Eligible work becomes durable when the PostgreSQL enqueue transaction commits. An abrupt process failure before that commit can still lose an SDK event; this is not a durable WhatsApp inbox acknowledgment protocol.

Enqueue atomically deduplicates `(account_id, chat_id, whatsapp_message_id)`, checks capacity across both stages, and inserts the message and inbound row. A duplicate remains a duplicate even when the queue is full. A failed job insert rolls back its message row and state event. After generation, a second transaction inserts one encrypted outbound reply, marks inbound `DONE`, and advances the message to `READY_TO_SEND`. Either all three changes commit or none do. The sender never calls the model.

Both stages run in the existing process and start only after Baileys reports `connected`. A bounded consumer admits up to three active jobs by default. Claims choose the oldest eligible conversation head across both queues using server-assigned `queue_order`; pending, debouncing or retrying work blocks only its own chat. An active outbound delivery occupies one of those slots, and there can be only one outbound lease per account. Completion or newly persisted work wakes the consumer. Idle checks run every five seconds by default; database errors back off up to 30 seconds. These are database operations, not extra WhatsApp requests.

With business tools configured, the assistant uses the general converser/planner/worker/formatter/verifier graph and signed Context Engine reads. The two-node conversation flow and no-key `hello` fallback remain available. Original encrypted transport keys determine identity; queue bodies never grant authority or carry OAuth tokens. Personal task/reminder writes are deployed; indefinitely paused agent workflows, conditional CRM/SLA scheduling and CRM writes remain deferred. The reviewed personal-only route uses deterministic planning and rendering around router/worker/verifier inference.

Claims use a short account transaction advisory lock to recover work, enforce the shared active-job ceiling and select a conversation head atomically across worker processes. Migration `202610030004` replaces the inbound account-wide unique lease index while retaining the outbound unique lease index. Inbound work in different chats can overlap each other and one outbound job; two turns in the same chat cannot. Every claim receives a fresh UUID token. Stale or expired owners cannot hand off, renew, start sending or finalize newer work. Checkpoint transactions acquire the same account lock before row locks to avoid a lock-order cycle. No transaction spans model calls, timers or sends.

Production queue leases last **30 seconds** and renew about every **10 seconds** while work is active. Renewal requires the current unexpired token and is capped by message expiry. Losing renewal or ownership aborts that task; disconnect cancels and drains owned tasks before reconnecting. The graph still has its own original finite deadline, which a renewal or process restart does not extend.

## Message and job states

| Message state   | Inbound          | Outbound            | Meaning                                                 |
| --------------- | ---------------- | ------------------- | ------------------------------------------------------- |
| `QUEUED`        | `READY`          | absent              | Waiting for the agent                                   |
| `PROCESSING`    | `LEASED`         | absent              | Agent preparing a reply                                 |
| `READY_TO_SEND` | `DONE`           | `READY` or `LEASED` | Final reply saved; waiting for due time or pacing       |
| `SENDING`       | `DONE`           | `LEASED`            | Send boundary committed; interruption may mean delivery |
| `SENT`          | `DONE`           | `DONE`              | SDK send completed, not a delivery/read receipt         |
| `EXPIRED`       | `DONE`           | absent or `DONE`    | Too old or no longer eligible                           |
| `FAILED`        | `DEAD` or `DONE` | absent or `DEAD`    | Invalid payload or exhausted pre-send attempts          |
| `UNCERTAIN`     | `DONE`           | `DEAD`              | Possible delivery; no automatic resend                  |

Historical jobs completed before the split remain inbound-only. In-flight legacy `SENDING` leases in that table also recover as `UNCERTAIN`.

Disconnect during generation releases inbound work to `QUEUED`. Disconnect during delivery pacing releases outbound work to `READY_TO_SEND`, retaining the exact saved reply. A deliberate pause does not consume a retry attempt. A later connection can resume within the message-age window. Before handoff, recovery reconstructs the graph and reuses completed model responses whose exact request bindings still match. Identity, permissions and sources are checked again; a changed request invalidates its saved response and every later response. Unknown or meaningful source clocks are retained and can cause a safe cache miss. A provider response not committed before the crash may be regenerated. The original request clock, deadline and finite operation budgets survive recovery. This is deterministic model-response replay, not a native full LangGraph checkpoint. After handoff, retries and restarts reuse the saved outbound output.

An expired `PROCESSING` lease is recovered, with at most five claim attempts by default. An expired `SENDING` lease becomes `UNCERTAIN`. The code records `SENDING` before calling the SDK because a crash or network failure cannot reliably distinguish a delivered message from an undelivered one. A crash between that marker and the actual call can therefore conservatively leave an unsent message uncertain.

There is no automatic retry of a message whose send callback has been invoked. This preserves the bot's duplicate-avoidance preference; it does not promise exactly-once WhatsApp delivery. Dead/uncertain jobs remain inspectable, with no automatic requeue or public retry endpoint.

## Payloads, retention, and local state

Queued messages are encoded with Baileys' `WebMessageInfo` protobuf and encrypted with AES-256-GCM using the existing `AUTH_ENCRYPTION_KEY`. The ciphertext is authenticated against the message row UUID and a distinct `message` category. The original message can then be reconstructed for a quoted reply after restart.

The outbound row stores final content with authenticated category `outbound-reply` and the same message UUID. Conversation payloads are strings; protected business replies are versioned objects that older senders reject. Business delivery metadata and tool receipts use separate authenticated categories. Moving ciphertext between rows or payload categories fails authentication. Terminal transitions clear temporary transport ciphertexts. The inbox retains encrypted text independently in `content_encrypted` and `reply_encrypted`. Business replies are hidden behind a private placeholder and excluded from model history.

Outbound `available_at` is a durable due time and the sender never claims a future row early. Ordinary replies retain their incoming message's expiry and quoted destination. The personal scheduler stores future intent separately and admits a short-lived reminder job only when due, with current recipient authorization, version/cancellation fences and a fixed one-hour deadline. Conditional business-state checks remain future work. Setting a distant queue timestamp alone does not implement a reminder.

The reviewed handoff also checks for a committed personal mutation receipt. Such a run can finalize only its exact protected command confirmation, including a composite personal/business reply. A generic fallback is rejected and the original run retries within existing attempt/expiry bounds, recovering the receipt without repeating the mutation. A temporary delivery-authorization failure retains that confirmation for bounded retry rather than replacing it with a generic “try again” message.

The same handoff protection applies to this run's published, approved,
dispatched, cancelled and terminal business-write transitions. Each operation
must have its current version and actor/run binding in the protected receipt.
Draft-only work creates no delivery obligation. Recovery and delivery never
replace a recorded business outcome with a generic retry invitation. The
additive `202610040001_write_delivery_lookup.sql` migration indexes these checks.

Payloads larger than 256 KiB before encryption are rejected. Terminal transitions clear temporary transport payloads, retaining encrypted inbox content and metadata. Terminal records (including observed messages), jobs, and their event history expire after 30 days through application cleanup. Startup and minute-level maintenance expire stale ready work, recover abandoned leases and remove expired checkpoints. Checkpoints are deleted in the same transaction as inbound handoff or terminal failure. Their encrypted envelope is capped at 4 MiB, expires no later than message expiry or 24 hours from start, and contains at most 96 saved responses. It can include opaque provider-encrypted continuation, never plaintext model reasoning or credentials. See [the replay contract](agent-modules/47-durable-model-checkpoints.md).

## Inbox, context, and operator sends

Migration [202610010003_inbox.sql](../supabase/migrations/202610010003_inbox.sql) adds encrypted inbox content, archived replies, mention flags, and message origin to the existing `ramesh-messages` table. Existing restricted-role grants and RLS still apply. Text, captions, sender names, and group names are encrypted under `AUTH_ENCRYPTION_KEY`; captionless media is represented by a label in that inbox. The new [media lifecycle](agent-modules/30-media-lifecycle.md) separately downloads/processes eligible files into encrypted 24-hour records; raw extracts do not become ordinary inbox text.

Every supported incoming notification is archived before reply filtering. Untagged group messages, stale notifications, and messages observed while reply capacity is full use `OBSERVED`, with no reply job. Reading does not invoke a model. `GROUP_REPLIES_REQUIRE_MENTION = true` in [group-policy.ts](../src/config/group-policy.ts) controls automatic replies only; `false` allows replies to untagged group text too. Own-message echoes, reactions, protocol traffic, and historical sync batches are excluded.

The assistant reads the last 32 messages from up to 40 preceding inbox rows in the same account/chat, with a 48,000-character context budget and 6,000-character cap per historical message. Group participants share history with speaker labels; other groups and DMs never enter it. The triggering message is supplied once and later messages/replies are excluded. Only `SENT` output enters context. Queued, failed, expired, and uncertain output remains visible with its status. The isolated SQLite playground retains a bounded memory fallback and has no durable replay store. Supabase model-response checkpoints are separate from conversation history and do not preserve an authoritative business-data snapshot. The real-data capture GUI uses its own encrypted checkpoint table; its request dispatcher remains serial.

Endpoints: `GET /v1/inbox/conversations?cursor=...`, `GET /v1/inbox/messages?chatId=...&cursor=...`, and `POST /v1/inbox/send`. All require worker authentication. The send body is `{ "requestId": "<UUID>", "chatId": "<existing chat>", "text": "..." }`, with 1–4,000 nonblank characters and a 24 KiB JSON limit. WhatsApp must be connected to submit. Destinations must have received inbox history. The browser retains the UUID on uncertain HTTP results; reuse with different text or a different chat is rejected. HTTP 202 means durably queued, not delivered.

Operator sends bypass generation and enter the existing outbound queue atomically with their inbox row. They have a five-minute send window, normal pacing, fenced leases, and the same `SENDING`/`UNCERTAIN` protections as automatic replies. `SENT` means SDK acceptance, not a delivery/read receipt. Manual sends do not disable automatic replies.

The deployed concurrency/replay release requires the full production schema through `202610030005`, including `202610030004` for ordered concurrent claims, even with business tools disabled. The real-data playground independently requires capture schema `202610030005`. These prerequisites are applied. The deployed outbound automation release additionally requires production migration `202610030006`, which is now applied and verified with the restricted runtime role. Fresh installations must apply it before starting that worker. Completed text cleared by older releases cannot be reconstructed; pending pre-upgrade work has no inbox content and is not automatically backfilled. A pre-inbox consumer cannot interpret operator sends. Older string-only senders reject the new protected business payload. See [first-read rollout and rollback](first-crm-read.md#enablement). Supabase migration and deployment are separate from local implementation/testing.

The following remain in the worker's existing SQLite database:

- Encrypted Baileys credentials and Signal keys.
- Encrypted employee OAuth grants, PKCE enrollment attempts, and pending revocations in separate `ContextOAuth*` tables. See [identity and OAuth](employee-identity-and-oauth.md).
- Admin session hashes and login rate limits.
- Operator connection preference.
- Legacy `Greeting` claims and the durable-storage activation marker.

On startup with Supabase enabled, old local greeting claims are copied idempotently into `ramesh-messages`. Successful claims become `SENT`; other retained claims become `UNCERTAIN`. **Import creates no reply jobs.** This carries duplicate protection across the storage change.

After the first successful initialization, SQLite records `message-storage=postgres`. Removing `MESSAGE_DATABASE_URL` then stops startup instead of silently falling back to the old greeting sender. New, never-migrated development databases can still use the SQLite mode when the setting is absent.

Keep the account ID stable across restarts and deployments. This implementation still expects one active Baileys socket owner for the linked account; the job lease is not a distributed lease on the WhatsApp identity itself.

## Authentication and configuration

The runtime connects as `ramesh_worker`, a dedicated non-superuser login without role creation, database creation, replication, or RLS bypass. Its explicit application grants cover the bot-owned tables, the compatibility view and narrowly scoped trigger functions. Tables have RLS enabled; the view and cleanup triggers use invoker security. Checkpoint RLS requires transaction-local account scope, with employee scope added in capture, and the capture role has no production checkpoint grant. Agent events allow SELECT/INSERT, with retention through foreign-key cascade, but no direct runtime UPDATE/DELETE. Explicit `PUBLIC`, `anon`, `authenticated`, and `service_role` grants are removed for these objects; there is no browser-facing queue API.

The employee resolver separately requires column-level SELECT on `public."VerifiedNumber"` for `id`, `phone_number`, `email`, and `is_active`. `npm run db:identity -- --env-file /private/admin.env --apply` provisions that narrow grant without changing roster rows or policies. This is additional to the queue grants; employee business access comes through signed, employee-scoped Context Engine tools. The admin browser receives no database credential.

Existing database-wide `PUBLIC` privileges still apply to PostgreSQL logins. Inspection found inherited access to the existing PostGIS catalog tables/views and `net.http_request_queue` / `net._http_response`; this change does not modify those shared extension grants. The runtime login is therefore a scoped application login, not an assertion of complete isolation from every shared extension object.

| Variable                    | Meaning                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Existing **SQLite** URL; do not replace it with a Supabase URL                                       |
| `MESSAGE_DATABASE_URL`      | Dedicated `ramesh_worker` PostgreSQL connection; Supabase transaction pooler is supported            |
| `MESSAGE_DB_SSL_CA`         | Trusted CA certificate; actual newlines and literal `\n` sequences are accepted                      |
| `MESSAGE_ACCOUNT_ID`        | Stable namespace, default `primary`, 1–64 letters/digits/underscores/hyphens                         |
| `MESSAGE_QUEUE_POLL_MS`     | Idle database poll interval; default 5000, allowed 250–30000                                         |
| `MESSAGE_QUEUE_CONCURRENCY` | Maximum active jobs across chats and both queues; default 3, allowed 1–8; outbound remains at most 1 |

Remote connections always verify TLS and hostname identity. URL query parameters cannot override TLS or the two-connection pool limit. Loopback connections can use unencrypted PostgreSQL for isolated tests. The existing pacing, pending-message capacity, age window, and send deadline still apply.

The runtime never runs a Supabase migration automatically. The provisioner checks every historical checksum, then applies missing migrations in order, in one transaction. Provision separately with an explicit admin environment file:

```sh
# Validate in a transaction and roll it back.
npm run db:messages -- --env-file /path/to/admin-connection.env

# Apply the same migration and save the dedicated connection privately.
npm run db:messages -- --env-file /path/to/admin-connection.env --apply
```

The source environment supplies `MESSAGE_ADMIN_DATABASE_URL` or `DATABASE_URL`, plus `MESSAGE_DB_SSL_CA` or `PG_SSL_CA`. The generated `.local/message-database.env` has mode `0600` and is ignored by Git. It contains the dedicated runtime connection, not the source admin credential. The script preserves an existing runtime password and verifies the migration checksum on repeat runs.

For EC2, add those runtime values to the protected worker environment and its encrypted Parameter Store backup. Pause the existing sender during the storage cutover, deploy the tested release, verify initialization/import, and restore the previous connection intent. Do not start the retired local WhatsApp pairing alongside EC2. A rollback to pre-queue code requires an explicit cutover plan because that old binary does not understand Supabase's message state.

The concurrency/replay release [e0b7232](https://github.com/rs0125/ramesh-bot/commit/e0b723290478da646809af1542a343d49b913b07) is deployed after successful [CI 37067044403](https://github.com/rs0125/ramesh-bot/actions/runs/37067044403) and [CD 37067181558](https://github.com/rs0125/ramesh-bot/actions/runs/37067181558). Production and capture prerequisites listed above are applied, restricted schema health checks pass, WhatsApp is connected and the effective active-chat limit is three. Runtime spending remains off, and verification used no paid evaluations or test WhatsApp sends. Preserve the encrypted checkpoint key and original deadline during recovery. Outbound automation migration `202610030006` is applied and restricted-role verification passed. The API key is installed on the host and in SSM runtime version 11; the proxy configuration is validated. Code is deployed in `3ad3408`; WhatsApp is connected and HTTPS authorization probes pass. See the [outbound automation integration guide](outbound-automation.md).

For the historical queue split, migration `202610010002` preceded the split-aware worker. The compatibility view supports the previously deployed SQL during this window. Deploying new code without the migration fails startup readiness. Once outbound rows exist, rolling back to the pre-split worker leaves them preserved but undelivered; restore a split-aware worker to drain them. Do not move saved replies back into the inbound queue or automatically resend uncertain rows. The alias can be removed in a later migration after the pre-split rollback window closes.

EC2 SQLite snapshots cover auth/admin/local settings and encrypted employee OAuth state, not PostgreSQL jobs. Supabase backup/PITR settings were not changed or verified by this feature. Retain the authentication encryption key separately so pending encrypted payloads remain recoverable. Revoke/re-enroll restored OAuth grants before reuse; old refresh tokens may already have been consumed.

Production runtime values must stay synchronized between the root-protected host environment and the encrypted SSM backup. Changing the SSM parameter alone does not reload the worker. See [EC2 runtime configuration](ec2-operations.md#runtime-configuration) for the update procedure; keep model keys out of database provisioning credentials and keep the admin's token separate from employee business access.

## Verification

Real PostgreSQL integration tests cover concurrent admission, capacity across stages, atomic handoff rollback, scheduled availability, competing claims, stale leases in both queues, saved-reply restart recovery without regeneration, ambiguous sends, encryption, disconnect/resume, connection-gated consumption, expiry, legacy imports, RLS/grants, migration repeatability, and upgrades from populated historical tables. Focused concurrency and replay tests additionally cover per-chat ordering, competing account limits, debounce/operator barriers, renewable leases, cross-chat progress, exact provider-response recovery, changed-request suffix invalidation, stale-owner fencing, encrypted row swaps, bounded counters and atomic checkpoint cleanup. These use synthetic local PostgreSQL and no model calls. Configuration tests cover restricted credentials, TLS, and certificate serialization. Existing SQLite/auth/admin/deployment tests remain in place. The capture harness adds tests for cross-queue privilege denial, roster RLS, encrypted output, private replay and retention. CI runs these against isolated local PostgreSQL; `dev:chat:live` and `smoke:chat:live` deliberately use real Supabase/Context Engine with capture-only delivery. Synthetic `dev:chat` and repeated fixture evals remain SQLite-based.

CI starts PostgreSQL 17 and runs these tests with the full worker check. Locally, use an isolated Podman container:

```sh
podman run --detach --name ramesh-queue-test \
  --publish 127.0.0.1:55438:5432 \
  --env POSTGRES_PASSWORD=ramesh-test-only \
  --env POSTGRES_DB=ramesh_queue_test docker.io/library/postgres:17

TEST_MESSAGE_DATABASE_URL=postgresql://postgres:ramesh-test-only@127.0.0.1:55438/ramesh_queue_test \
  npm run check
```

Tests create and remove their own temporary databases. The fixture refuses non-loopback hosts or a source database name other than `ramesh_queue_test`. Without that explicit test URL, PostgreSQL integration tests are skipped; the browser fixture always disables any inherited production message connection.

## Why a PostgreSQL table queue here

Supabase's [Queues service](https://supabase.com/docs/guides/queues) uses the `pgmq` extension. It is available on this project but was not installed for this change. The bot needs ordered conversation heads, bounded parallel processing across chats, one paced outbound sender per account, explicit send-uncertainty handling, and atomic state/queue updates with exact `ramesh-` table names. A small PostgreSQL table queue meets that scope without another extension or service. PostgreSQL explicitly supports [`SKIP LOCKED` for queue-style consumers](https://www.postgresql.org/docs/17/sql-select.html).

The implementation does not claim pgmq's broader feature set. New workflow types, long-running tasks, independent priority lanes, or more elaborate scheduling should be designed around their own durable state and retry guarantees.
