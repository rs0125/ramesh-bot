# Supabase persistence and recovery

Status: **Message tables and the minimal run/event journal are established. Per-chat concurrency and encrypted model-response replay are deployed in `e0b7232`. Native LangGraph snapshots and paused-task state remain proposed.**

The run ID equals its inbound message UUID. Current run state is running/finalized/failed, fenced by the inbound lease and retry attempt. Encrypted tool receipts are append-only; run finalization shares the outbound handoff transaction. Finalized means saved, not sent. Message cleanup cascades to run/event history after 30 days.

The deployed release requires production migrations [202610030004_per_chat_queue.sql](../../supabase/migrations/202610030004_per_chat_queue.sql) and [202610030005_agent_checkpoints.sql](../../supabase/migrations/202610030005_agent_checkpoints.sql), following the earlier inbox/media/ledger migrations. The real-data playground independently requires [capture 202610030005](../../supabase/playground/202610030005_agent_checkpoints.sql). Runtime health checks reject an older schema. These production and capture migrations are applied, including the previously pending production `202610020006` and capture `202610020003` usage ledgers. The separate [outbound automation implementation](48-outbound-automation-api.md) additionally requires production migration `202610030006`, which is applied and verified with the restricted runtime role. Automation is deployed in `3ad3408`; see the [integration guide](../outbound-automation.md).

## Implemented stores and ownership

| Store                                                                                       | Owner and content                                                                                                  |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ramesh-messages`, `ramesh-inbound-queue`, `ramesh-outbound-queue`, `ramesh-message-events` | Message repository; admission order, inbox content, fenced work, delivery and transition history                   |
| `ramesh-agent-runs`                                                                         | One run per inbound job, current retry attempt/lease and running/finalized/failed status                           |
| `ramesh-agent-events`                                                                       | Append-only encrypted tool receipts and finalization events                                                        |
| `ramesh-agent-checkpoints`                                                                  | Encrypted completed model responses, original request/start/deadline clocks, consumption counters and retry policy |
| `ramesh-test-agent-checkpoints`                                                             | Same recovery contract in the physically separate capture namespace and role                                       |

All these tables use quoted hyphenated identifiers in `public`. Production and capture migrations/grants remain independent. SQLite retains device/admin state and synthetic fixtures; it has no production checkpoint authority. Use additive SQL migrations beside existing Supabase migrations, never Prisma against shared Supabase business data. Runtime roles do not own DDL.

## Current concurrency and replay contract

The default account cap is three active jobs across chats and both queues, with one active turn per chat and at most one outbound delivery lease. Server admission order survives debounce, retries and handoff. Production leases last 30 seconds, renew about every 10 seconds and stop at message expiry. The short account advisory lock also covers checkpoint transactions before row locking; no transaction spans a provider call. See [module 46](46-per-chat-concurrency.md).

Recovery reruns the graph and reauthorizes the employee, catalogue and every source read. It reuses a saved native model response only when the ordered request and authority binding match exactly. The full accepted provider response preserves function-call IDs and opaque encrypted continuation. Changed business facts, tool schemas or retained clocks invalidate that response and the saved suffix. Narrow model projections omit only known retrieval-only clocks; unknown metadata is retained and can safely prevent reuse.

The original finite deadline, request clock and operational budgets survive restart, binding changes and response truncation. Lease renewal does not extend the graph deadline. A crash after the provider returns but before checkpoint commit can repeat a model call. Native LangGraph next-node restoration, indefinite pause/resume and exactly-once billing are not implemented. A committed outbound handoff continues to reuse the final reply without invoking the model.

Every begin/read/save/budget/policy operation checks the live inbound lease and message expiry. An invalid lease or storage failure propagates to queue recovery rather than being converted to a finalized generic reply. Terminal/handoff triggers erase the checkpoint in the same transaction; startup/minute maintenance also removes expired entries. Retention is bounded by message expiry or 24 hours from start, with at most 96 responses and 4 MiB of ciphertext. See [module 47](47-durable-model-checkpoints.md).

## Proposed richer task schema

The following contracts describe future task epochs, waiting states and effect reconciliation. They are not additional columns or guarantees in the current minimal journal. A future native LangGraph Postgres adapter would require separately reviewed private checkpoint tables, serialization, encryption and transaction semantics. Personal scheduling tables are implemented in migration `202610030007` (applied and verified; activation uses runtime flags); `ramesh-action-proposals` remains proposed. See [scheduling operations](../personal-scheduling.md).

### Run and event columns

The run table needs an account/run primary key or equivalent account-scoped uniqueness, originating input reference, actor binding, audience/chat reference, unique graph thread ID, epoch, row version, status/outcome, contract version, encrypted task payload, lease token/expiry, active deadline, waiting expiry, usage totals and timestamps. The originating input is unique for new-run creation; clarification inputs attach through uniquely keyed events.

Event rows need event ID, account/run reference, monotonic per-run sequence, epoch, kind, operation/attempt reference where applicable, safe status metadata, encrypted payload, payload version and timestamp. A unique event key makes retrying the same transition idempotent. Started and finished operations are separate events, preserving history rather than rewriting an earlier claim.

Index recoverable runs by account/status/lease expiry, waiting runs by expiry, and events by run/sequence. Use foreign keys or equivalent transactional checks to prevent orphaned event/delivery references. The exact DDL must be exercised on isolated PostgreSQL before rollout.

### Target atomic boundaries

1. **Admission:** associate one inbound job with a new or valid resumed run; duplicate claims find the existing association.
2. **Step commit:** check lease/epoch/version, append the accepted outcome and advance the canonical run version together.
3. **Waiting:** save pending question and run status, enqueue one clarification response and finish that inbound turn together.
4. **Finalization:** save the verified reply and source/effect references, insert/reuse one outbound row, finish inbound work and mark the run finalized in one transaction.
5. **Cancellation:** advance epoch and invalidate eligible unsent prepared output, retaining an audit event.

Checkpoint writes may use a different adapter transaction. Do not assume they commit atomically with domain rows. The canonical run/event ledger governs recovery: a lagging checkpoint must discover a committed operation or response before replaying it. No external API call or LLM generation occurs while holding a database transaction.

### Future queue schema extensions

Business delivery needs explicit output classification, employee binding, run/epoch, evidence references and expiry/refresh policy. Ordinary replies, business replies, operator text and later reminders must be distinguishable. Existing rows migrate as ordinary replies; they must not gain business authority by default.

Preserve current one-reply-per-trigger behavior. A clarification and its later answer correspond to different inbound messages, even when they share a run. Reminder-origin deliveries later require an explicit producer/occurrence identity and cannot pretend to quote an old inbound message.

Define any new suppressed, refresh-pending or cancelled delivery phase additively; do not silently reinterpret existing `READY`, `LEASED`, `DONE` or `DEAD` states. Old workers must not consume unsupported payload versions. Deployment order is migration/readiness support, compatible worker, then feature enablement.

## Security and retention

Restrict tables to bot runtime roles and operator paths with a stated need. Deny general browser/anonymous access. Encrypt sensitive objectives, evidence, history and prepared text with authenticated row/category identities. The implemented response store uses authenticated AES-256-GCM envelopes bound to environment/account/job and current lease checks. Any future graph adapter must provide equivalent protection; a private schema alone is not encryption.

Use live permission checks when reading historical business artifacts. Store no private signing keys, OAuth tokens or plaintext model reasoning. Opaque provider-encrypted reasoning continuation is permitted only inside the encrypted, run-bound replay envelope to resume the native protocol; never decode it or expose it to logs, tools or other runs. The current replay retention is defined above; future paused tasks, evidence and effects need their own retention contract. Cleanup must not remove a live reminder/action's required reference or an unresolved operation record prematurely.

## Recovery and acceptance

Recover expired leases with fencing. A finalized run reuses saved output; an incomplete read may retry within limits; an uncertain future write reconciles. Checkpoint/run version disagreement must fail explicitly, never bypass access. Current replay uses transaction-local RLS settings and transaction advisory locks compatible with the transaction pooler. Any future native checkpointer must independently prove connection-pool and transaction-pooler behavior; do not rely on session-only settings.

Integration cases include concurrent admission, transactional rollback at every handoff, restart after remote read before receipt persistence, stale lease writes, checkpoint lag, encrypted payload corruption, cross-account access, terminal cleanup and populated-schema upgrade. Tests use local PostgreSQL plus fake transport. Backups, keys and restores must cover run/evidence/checkpoint state consistently before production activation.
