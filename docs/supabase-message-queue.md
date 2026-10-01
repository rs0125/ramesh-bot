# Supabase inbound and outbound queues

Reviewed **1 October 2026** through release `5eb14d0`. The split queues and migrations `202610010001` / `202610010002` are deployed. This is the transport queue contract; the broader [architecture plan](assistant-architecture-plan.md) covers future reminder and tool workflows.

The worker persists incoming WhatsApp messages, finalized outgoing replies, and state history in the existing WareOnGo Supabase PostgreSQL database. The five application tables use the literal `ramesh-` prefix and live in `public`. SQL identifiers containing the hyphen must be double-quoted.

WhatsApp still pushes messages through the Baileys connection. The worker polls **its own PostgreSQL queue**, not WhatsApp. The admin browser's separate status polling is unchanged.

## Tables

| Table                               | Purpose                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `public."ramesh-messages"`          | One row per account/chat/WhatsApp-message ID: state, expiry, encrypted pending payload, completion time, and a short reason code |
| `public."ramesh-inbound-queue"`     | Incoming work for the agent: availability, lease token/deadline, attempts, and processing outcome                                |
| `public."ramesh-outbound-queue"`    | Finalized encrypted replies for the sender: availability, lease token/deadline, delivery attempts, and outcome                   |
| `public."ramesh-message-events"`    | Transactional history of message state transitions, written by a database trigger                                                |
| `public."ramesh-schema-migrations"` | Applied migration version, checksum, and time                                                                                    |

The base migration is [202610010001_message_queue.sql](../supabase/migrations/202610010001_message_queue.sql); [202610010002_split_queues.sql](../supabase/migrations/202610010002_split_queues.sql) renames the old job table in place and adds the outbound table. Existing rows and history are preserved. `ramesh-message-jobs` becomes an updatable compatibility **view** over the inbound table so the previous release can finish work during deployment. New application code uses the explicit queue names. These migrations do not alter CRM tables or run SQLite Prisma migrations against Supabase.

## Processing path

```mermaid
flowchart TD
    Event[Baileys notify event] --> Map[Map and check eligibility]
    Map --> Save[Atomically insert message and inbound job]
    Save --> Inbound[(ramesh-inbound-queue)]
    Inbound --> Claim[Agent claims inbound work]
    Claim --> Processing[PROCESSING with a fenced lease]
    Processing --> Agent[Optional LangGraph converser and formatter]
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

Both stages run in the existing process and start only after Baileys reports `connected`. Each loop checks due outbound work first, then inbound, preserving normal conversation order. Newly persisted work wakes it immediately. When idle, it checks every five seconds by default, so restarts and recovered leases do not depend on another incoming message. Database errors back off up to 30 seconds. These are application database operations, not extra WhatsApp requests.

The active agent is the two-node OpenAI Terra converser/formatter, with `hello` as the no-key fallback. Planner, worker, and verifier agents are deferred. The Context Engine MCP service scaffold is disconnected from this consumer: current queue payloads do not grant CRM access or carry employee OAuth tokens. Introducing tool runs or reminders will require their own workflow/authorization state.

Claims use `FOR UPDATE SKIP LOCKED`, an account transaction lock, and one-active-lease indexes on each queue. Inside that same lock the repository checks both queues, so an inbound and outbound lease cannot overlap for one account through this application. Every claim receives a new UUID lease token. Stale or expired owners cannot hand off, start sending, or finalize newer work. Transactions finish before model calls, timers, or sends, so the transaction-pooler connection is not held during those operations.

The lease duration is the configured agent deadline (zero when no OpenAI key is configured) plus `REPLY_DELAY_MAX_MS + SEND_TIMEOUT_MS + 30000`. Generation is cancelled at the agent deadline or when the session disconnects; the lease includes time for pacing, sending, and database round trips. Future workflows that exceed that bounded window will need a reviewed renewal design.

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

Disconnect during generation releases inbound work to `QUEUED`. Disconnect during delivery pacing releases outbound work to `READY_TO_SEND`, retaining the exact saved reply. A deliberate pause does not consume a retry attempt. A later connection can resume within the message-age window. An inbound crash before handoff may repeat generation; after handoff, retries and restarts reuse the saved output.

An expired `PROCESSING` lease is recovered, with at most five claim attempts by default. An expired `SENDING` lease becomes `UNCERTAIN`. The code records `SENDING` before calling the SDK because a crash or network failure cannot reliably distinguish a delivered message from an undelivered one. A crash between that marker and the actual call can therefore conservatively leave an unsent message uncertain.

There is no automatic retry of a message whose send callback has been invoked. This preserves the bot's duplicate-avoidance preference; it does not promise exactly-once WhatsApp delivery. Dead/uncertain jobs remain inspectable, with no automatic requeue or public retry endpoint.

## Payloads, retention, and local state

Queued messages are encoded with Baileys' `WebMessageInfo` protobuf and encrypted with AES-256-GCM using the existing `AUTH_ENCRYPTION_KEY`. The ciphertext is authenticated against the message row UUID and a distinct `message` category. The original message can then be reconstructed for a quoted reply after restart.

The outbound row stores final text with authenticated category `outbound-reply` and the same message UUID. Moving ciphertext between rows or payload categories fails authentication. Terminal transitions clear temporary transport ciphertexts. The inbox retains encrypted text independently in `content_encrypted` and `reply_encrypted`, so completed messages remain readable and usable as context across restarts.

Outbound `available_at` is a durable due time and the sender never claims a future row early. This version emits immediate replies only. It retains the incoming message's expiry and quoted destination: a long-lived reminder scheduler, recipient authorization, cancellation, and due-time business-state checks remain future work. Setting a distant timestamp alone does not implement reminders.

Payloads larger than 256 KiB before encryption are rejected. Terminal transitions clear temporary transport payloads, retaining encrypted inbox content and metadata. Terminal records (including observed messages), jobs, and their event history expire after 30 days through application cleanup. Initial/hourly maintenance also expires stale ready work and recovers abandoned leases.

## Inbox, context, and operator sends

Migration [202610010003_inbox.sql](../supabase/migrations/202610010003_inbox.sql) adds encrypted inbox content, archived replies, mention flags, and message origin to the existing `ramesh-messages` table. Existing restricted-role grants and RLS still apply. Text, captions, sender names, and group names are encrypted under `AUTH_ENCRYPTION_KEY`; captionless media is represented by a label, without file download or transcription.

Every supported incoming notification is archived before reply filtering. Untagged group messages, stale notifications, and messages observed while reply capacity is full use `OBSERVED`, with no reply job. Reading does not invoke a model. `GROUP_REPLIES_REQUIRE_MENTION = true` in [group-policy.ts](../src/config/group-policy.ts) controls automatic replies only; `false` allows replies to untagged group text too. Own-message echoes, reactions, protocol traffic, and historical sync batches are excluded.

The assistant reads up to 40 preceding inbox rows in the same account/chat, with a 16,000-character context budget and 6,000-character cap per historical message. Group participants share history with speaker labels; other groups and DMs never enter it. The triggering message is supplied once and later messages/replies are excluded. Only `SENT` output enters context. Queued, failed, expired, and uncertain output remains visible with its status. The isolated SQLite playground retains a bounded memory fallback. No LangGraph checkpoints are introduced.

Endpoints: `GET /v1/inbox/conversations?cursor=...`, `GET /v1/inbox/messages?chatId=...&cursor=...`, and `POST /v1/inbox/send`. All require worker authentication. The send body is `{ "requestId": "<UUID>", "chatId": "<existing chat>", "text": "..." }`, with 1–4,000 nonblank characters and a 24 KiB JSON limit. WhatsApp must be connected to submit. Destinations must have received inbox history. The browser retains the UUID on uncertain HTTP results; reuse with different text or a different chat is rejected. HTTP 202 means durably queued, not delivered.

Operator sends bypass generation and enter the existing outbound queue atomically with their inbox row. They have a five-minute send window, normal pacing, fenced leases, and the same `SENDING`/`UNCERTAIN` protections as automatic replies. `SENT` means SDK acceptance, not a delivery/read receipt. Manual sends do not disable automatic replies.

Apply migration `202610010003` with the existing provisioner before deploying the worker, then deploy the matching admin. Startup checks this migration. Completed text cleared by older releases cannot be reconstructed; pending pre-upgrade work has no inbox content and is not automatically backfilled. Once operator sends exist, keep an inbox-aware worker to drain them: a pre-inbox consumer cannot interpret their payload. Supabase migration and deployment are separate from local implementation/testing.

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

The runtime connects as `ramesh_worker`, a dedicated non-superuser login without role creation, database creation, replication, or RLS bypass. Its explicit application grants cover these five tables, the compatibility view, and the state-history trigger function. All five tables have RLS enabled; the view uses invoker security. Explicit `PUBLIC`, `anon`, `authenticated`, and `service_role` grants are removed for these objects; there is no browser-facing queue API.

The employee resolver separately requires column-level SELECT on `public."VerifiedNumber"` for `id`, `phone_number`, `email`, and `is_active`. `npm run db:identity -- --env-file /private/admin.env --apply` provisions that narrow grant without changing roster rows or policies. This is additional to the queue grants; employee business access still comes through OAuth-scoped Context Engine tools. The admin browser receives no database credential.

Existing database-wide `PUBLIC` privileges still apply to PostgreSQL logins. Inspection found inherited access to the existing PostGIS catalog tables/views and `net.http_request_queue` / `net._http_response`; this change does not modify those shared extension grants. The runtime login is therefore a scoped application login, not an assertion of complete isolation from every shared extension object.

| Variable                | Meaning                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | Existing **SQLite** URL; do not replace it with a Supabase URL                            |
| `MESSAGE_DATABASE_URL`  | Dedicated `ramesh_worker` PostgreSQL connection; Supabase transaction pooler is supported |
| `MESSAGE_DB_SSL_CA`     | Trusted CA certificate; actual newlines and literal `\n` sequences are accepted           |
| `MESSAGE_ACCOUNT_ID`    | Stable namespace, default `primary`, 1–64 letters/digits/underscores/hyphens              |
| `MESSAGE_QUEUE_POLL_MS` | Idle database poll interval; default 5000, allowed 250–30000                              |

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

For the queue split, apply migration `202610010002` before deploying the new worker. The compatibility view supports the previously deployed SQL during this window. Deploying new code without the migration fails startup readiness. Once outbound rows exist, rolling back to the pre-split worker leaves them preserved but undelivered; restore a split-aware worker to drain them. Do not move saved replies back into the inbound queue or automatically resend uncertain rows. The alias can be removed in a later migration after the pre-split rollback window closes.

EC2 SQLite snapshots cover auth/admin/local settings and encrypted employee OAuth state, not PostgreSQL jobs. Supabase backup/PITR settings were not changed or verified by this feature. Retain the authentication encryption key separately so pending encrypted payloads remain recoverable. Revoke/re-enroll restored OAuth grants before reuse; old refresh tokens may already have been consumed.

Production runtime values must stay synchronized between the root-protected host environment and the encrypted SSM backup. Changing the SSM parameter alone does not reload the worker. See [EC2 runtime configuration](ec2-operations.md#runtime-configuration) for the update procedure; keep model keys out of database provisioning credentials and keep the admin's token separate from employee business access.

## Verification

Real PostgreSQL integration tests cover concurrent admission, capacity across stages, atomic handoff rollback, scheduled availability, competing claims, stale leases in both queues, saved-reply restart recovery without regeneration, ambiguous sends, encryption, disconnect/resume, connection-gated consumption, expiry, legacy imports, RLS/grants, migration repeatability, and upgrades from populated historical tables. Configuration tests cover restricted credentials, TLS, and certificate serialization. Existing SQLite/auth/admin/deployment tests remain in place. The local GUI and live model evals still use isolated SQLite and a capture-only transport; queue SQL is tested against an isolated local PostgreSQL container.

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

Supabase's [Queues service](https://supabase.com/docs/guides/queues) uses the `pgmq` extension. It is available on this project but was not installed for this change. The current bot needs one ordered consumer per account, explicit send-uncertainty handling, and atomic state/queue updates with exact `ramesh-` table names. A small PostgreSQL table queue meets that scope without another extension or service. PostgreSQL explicitly supports [`SKIP LOCKED` for queue-style consumers](https://www.postgresql.org/docs/17/sql-select.html).

The implementation does not claim pgmq's broader feature set. New workflow types, long-running tasks, independent priority lanes, or more elaborate scheduling should be designed around their own durable state and retry guarantees.
