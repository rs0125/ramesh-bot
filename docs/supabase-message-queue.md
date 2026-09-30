# Supabase message state and reply queue

The worker can persist eligible incoming WhatsApp messages, reply jobs, and state history in the existing WareOnGo Supabase PostgreSQL database. All four application tables use the literal `ramesh-` prefix and live in `public`. SQL identifiers containing the hyphen must be double-quoted.

WhatsApp still pushes messages through the Baileys connection. The worker polls **its own PostgreSQL queue**, not WhatsApp. The admin browser's separate status polling is unchanged.

## Tables

| Table                               | Purpose                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `public."ramesh-messages"`          | One row per account/chat/WhatsApp-message ID: state, expiry, encrypted pending payload, completion time, and a short reason code |
| `public."ramesh-message-jobs"`      | One job per message: availability, lease token/deadline, attempts, and queue outcome                                             |
| `public."ramesh-message-events"`    | Transactional history of message state transitions, written by a database trigger                                                |
| `public."ramesh-schema-migrations"` | Applied migration version, checksum, and time                                                                                    |

The migration is [202610010001_message_queue.sql](../supabase/migrations/202610010001_message_queue.sql). It does not alter CRM tables or run the SQLite Prisma migrations against Supabase.

## Processing path

```mermaid
flowchart TD
    Event[Baileys notify event] --> Map[Map and check eligibility]
    Map --> Save[Atomically insert message and READY job]
    Save --> Store[(Supabase PostgreSQL)]
    Store --> Claim[Connected worker claims one job]
    Claim --> Processing[PROCESSING with a fenced lease]
    Processing --> Agent[Optional LangGraph converser and formatter]
    Agent --> Delay[Random reply delay and age recheck]
    Delay --> Marker[Commit SENDING before calling WhatsApp]
    Marker --> Send[Send generated reply through current Baileys session]
    Send --> Success[SENT / job DONE]
    Send --> Uncertain[UNCERTAIN / job DEAD if delivery is ambiguous]
```

Admission is serialized in a small bounded in-memory buffer. Eligible work becomes durable when the PostgreSQL enqueue transaction commits. An abrupt process failure before that commit can still lose an SDK event; this is not a durable WhatsApp inbox acknowledgment protocol.

Enqueue atomically deduplicates `(account_id, chat_id, whatsapp_message_id)`, checks the pending-job capacity, and inserts both rows. A duplicate remains a duplicate even when the queue is full. A failed job insert rolls back its message row and state event.

The consumer starts only after Baileys reports `connected`. Newly persisted work wakes it immediately. When idle, it checks for work every five seconds by default, so restarts and recovered leases do not depend on another incoming message. Database errors back off up to 30 seconds. These are application database operations, not extra WhatsApp requests.

Job claims use `FOR UPDATE SKIP LOCKED`, a transaction-scoped account lock, and a unique index allowing one leased job per account. Each claim receives a new UUID lease token. A stale consumer cannot start or finalize work owned by a newer lease. Transactions finish before delay timers or network sends begin, so the Supabase transaction-pooler connection is not held during pacing.

The lease duration is the configured agent deadline (zero when no OpenAI key is configured) plus `REPLY_DELAY_MAX_MS + SEND_TIMEOUT_MS + 30000`. Generation is cancelled at the agent deadline or when the session disconnects; the lease includes time for pacing, sending, and database round trips. Future workflows that exceed that bounded window will need a reviewed renewal design.

## Message and job states

| Message state | Job state | Meaning and recovery                                                                         |
| ------------- | --------- | -------------------------------------------------------------------------------------------- |
| `QUEUED`      | `READY`   | Persisted and waiting; safe to claim while connected                                         |
| `PROCESSING`  | `LEASED`  | Claimed and preparing/waiting; an expired lease can be recovered before any send             |
| `SENDING`     | `LEASED`  | The send boundary was committed; interruption is treated conservatively as possible delivery |
| `SENT`        | `DONE`    | SDK send and final state persistence completed; this is not a delivery/read receipt          |
| `EXPIRED`     | `DONE`    | Too old or no longer eligible; nothing is sent                                               |
| `FAILED`      | `DEAD`    | Invalid encrypted payload or exhausted pre-send recovery attempts                            |
| `UNCERTAIN`   | `DEAD`    | Sending may have occurred; no automatic resend                                               |

On disconnect during pacing, the consumer cancels its timer and releases work it knows has not been sent back to `QUEUED`. Such a deliberate pause does not consume a retry attempt. A later connection can resume it if it is still within the message-age window.

An expired `PROCESSING` lease is recovered, with at most five claim attempts by default. An expired `SENDING` lease becomes `UNCERTAIN`. The code records `SENDING` before calling the SDK because a crash or network failure cannot reliably distinguish a delivered message from an undelivered one. A crash between that marker and the actual call can therefore conservatively leave an unsent message uncertain.

There is no automatic retry of a message whose send callback has been invoked. This preserves the bot's duplicate-avoidance preference; it does not promise exactly-once WhatsApp delivery. Dead/uncertain jobs remain inspectable, with no automatic requeue or public retry endpoint.

## Payloads, retention, and local state

Queued messages are encoded with Baileys' `WebMessageInfo` protobuf and encrypted with AES-256-GCM using the existing `AUTH_ENCRYPTION_KEY`. The ciphertext is authenticated against the message row UUID and a distinct `message` category. The original message can then be reconstructed for a quoted reply after restart.

Payloads larger than 256 KiB before encryption are rejected. Terminal transitions clear the encrypted payload. Chat IDs, WhatsApp message IDs, states, timestamps, and reason codes remain as metadata. Terminal records, jobs, and their event history expire after 30 days through application cleanup. Initial/hourly maintenance also expires stale ready work and recovers abandoned leases.

The following remain in the worker's existing SQLite database:

- Encrypted Baileys credentials and Signal keys.
- Admin session hashes and login rate limits.
- Operator connection preference.
- Legacy `Greeting` claims and the durable-storage activation marker.

On startup with Supabase enabled, old local greeting claims are copied idempotently into `ramesh-messages`. Successful claims become `SENT`; other retained claims become `UNCERTAIN`. **Import creates no reply jobs.** This carries duplicate protection across the storage change.

After the first successful initialization, SQLite records `message-storage=postgres`. Removing `MESSAGE_DATABASE_URL` then stops startup instead of silently falling back to the old greeting sender. New, never-migrated development databases can still use the SQLite mode when the setting is absent.

Keep the account ID stable across restarts and deployments. This implementation still expects one active Baileys socket owner for the linked account; the job lease is not a distributed lease on the WhatsApp identity itself.

## Authentication and configuration

The runtime connects as `ramesh_worker`, a dedicated non-superuser login without role creation, database creation, replication, or RLS bypass. Its explicit application grants are limited to these four tables and the state-history trigger function. All four tables have RLS enabled. Explicit `PUBLIC`, `anon`, `authenticated`, and `service_role` table grants are removed for these new tables; there is no browser-facing queue API.

Existing database-wide `PUBLIC` privileges still apply to PostgreSQL logins. Inspection found inherited access to the existing PostGIS catalog tables/views and `net.http_request_queue` / `net._http_response`; this change does not modify those shared extension grants. The runtime login is therefore a scoped application login, not an assertion of complete isolation from every shared extension object.

| Variable                | Meaning                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | Existing **SQLite** URL; do not replace it with a Supabase URL                            |
| `MESSAGE_DATABASE_URL`  | Dedicated `ramesh_worker` PostgreSQL connection; Supabase transaction pooler is supported |
| `MESSAGE_DB_SSL_CA`     | Trusted CA certificate; actual newlines and literal `\n` sequences are accepted           |
| `MESSAGE_ACCOUNT_ID`    | Stable namespace, default `primary`, 1–64 letters/digits/underscores/hyphens              |
| `MESSAGE_QUEUE_POLL_MS` | Idle database poll interval; default 5000, allowed 250–30000                              |

Remote connections always verify TLS and hostname identity. URL query parameters cannot override TLS or the two-connection pool limit. Loopback connections can use unencrypted PostgreSQL for isolated tests. The existing pacing, pending-message capacity, age window, and send deadline still apply.

The runtime never runs a Supabase migration automatically. Provision separately with an explicit admin environment file:

```sh
# Validate in a transaction and roll it back.
npm run db:messages -- --env-file /path/to/admin-connection.env

# Apply the same migration and save the dedicated connection privately.
npm run db:messages -- --env-file /path/to/admin-connection.env --apply
```

The source environment supplies `MESSAGE_ADMIN_DATABASE_URL` or `DATABASE_URL`, plus `MESSAGE_DB_SSL_CA` or `PG_SSL_CA`. The generated `.local/message-database.env` has mode `0600` and is ignored by Git. It contains the dedicated runtime connection, not the source admin credential. The script preserves an existing runtime password and verifies the migration checksum on repeat runs.

For EC2, add those runtime values to the protected worker environment and its encrypted Parameter Store backup. Pause the existing sender during the storage cutover, deploy the tested release, verify initialization/import, and restore the previous connection intent. Do not start the retired local WhatsApp pairing alongside EC2. A rollback to pre-queue code requires an explicit cutover plan because that old binary does not understand Supabase's message state.

EC2 SQLite snapshots cover auth/admin/local settings, not PostgreSQL jobs. Supabase backup/PITR settings were not changed or verified by this feature. Retain the authentication encryption key separately so pending encrypted payloads remain recoverable.

## Verification

Real PostgreSQL integration tests cover concurrent admission, bounded capacity, transaction rollback, competing claims, stale lease fencing, pre-send recovery, ambiguous sends, protobuf/encryption round trips, disconnect/resume, connection-gated consumption, expiry, legacy imports, RLS/grants, and migration repeatability. Configuration tests cover restricted credentials, TLS, and certificate serialization. Existing SQLite/auth/admin/deployment tests remain in place.

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
