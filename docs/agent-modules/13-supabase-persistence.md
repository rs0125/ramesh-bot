# Supabase persistence and recovery

Status: **Message tables and minimal run/event journal implemented; richer task state and checkpoints proposed.** Migration [202610010004_agent_reads.sql](../../supabase/migrations/202610010004_agent_reads.sql) adds the journal and protected delivery fields. The [personal-assistant runbook](../sales-manager-agent.md) defines the current read-only journal integration; the contracts below describe the richer target schema and are not all columns in migration 004.

The current run ID equals its inbound message UUID. State is running/finalized/failed, fenced by the inbound lease and retry attempt. Encrypted tool receipts are append-only; run finalization shares the outbound handoff transaction. Finalized means saved, not sent. Message cleanup cascades to runs and events after 30 days. Whole-read replay before finalization is safe because the bounded tool loop performs no business writes; paused checkpoints are deferred until intermediate resumption is required.

## Stores and ownership

| Store                                                                  | Owner and content                                                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Existing `ramesh-messages`, inbound/outbound queues and message events | Message repository; archival, delivery and transition history                                                               |
| Proposed `ramesh-agent-runs`                                           | Run repository; actor/input references, epoch/version, status/outcome, contract, deadline, budget and checkpoint pointer    |
| Proposed `ramesh-agent-events`                                         | Append-only operation/decision history; input attachments, handoffs, receipts, evidence payload references and verification |
| Proposed checkpoint tables in private `ramesh_agent` schema            | Compatible LangGraph Postgres adapter; execution snapshots                                                                  |
| Proposed `ramesh-reminders`                                            | Reminder repository; schedules and linked occurrences                                                                       |
| Proposed `ramesh-action-proposals`                                     | Action repository; future exact commands and reconciliation                                                                 |

Use additive SQL migrations beside existing Supabase migrations. Do not apply the local Prisma/SQLite schema to the shared Supabase database. One migration owner defines grants and schema versions. Application roles do not own migration DDL.

## Run and event columns

The run table needs an account/run primary key or equivalent account-scoped uniqueness, originating input reference, actor binding, audience/chat reference, unique graph thread ID, epoch, row version, status/outcome, contract version, encrypted task payload, lease token/expiry, active deadline, waiting expiry, usage totals and timestamps. The originating input is unique for new-run creation; clarification inputs attach through uniquely keyed events.

Event rows need event ID, account/run reference, monotonic per-run sequence, epoch, kind, operation/attempt reference where applicable, safe status metadata, encrypted payload, payload version and timestamp. A unique event key makes retrying the same transition idempotent. Started and finished operations are separate events, preserving history rather than rewriting an earlier claim.

Index recoverable runs by account/status/lease expiry, waiting runs by expiry, and events by run/sequence. Use foreign keys or equivalent transactional checks to prevent orphaned event/delivery references. The exact DDL must be exercised on isolated PostgreSQL before rollout.

## Atomic boundaries

1. **Admission:** associate one inbound job with a new or valid resumed run; duplicate claims find the existing association.
2. **Step commit:** check lease/epoch/version, append the accepted outcome and advance the canonical run version together.
3. **Waiting:** save pending question and run status, enqueue one clarification response and finish that inbound turn together.
4. **Finalization:** save the verified reply and source/effect references, insert/reuse one outbound row, finish inbound work and mark the run finalized in one transaction.
5. **Cancellation:** advance epoch and invalidate eligible unsent prepared output, retaining an audit event.

Checkpoint writes may use a different adapter transaction. Do not assume they commit atomically with domain rows. The canonical run/event ledger governs recovery: a lagging checkpoint must discover a committed operation or response before replaying it. No external API call or LLM generation occurs while holding a database transaction.

## Queue schema extensions

Business delivery needs explicit output classification, employee binding, run/epoch, evidence references and expiry/refresh policy. Ordinary replies, business replies, operator text and later reminders must be distinguishable. Existing rows migrate as ordinary replies; they must not gain business authority by default.

Preserve current one-reply-per-trigger behavior for the first slice. A clarification and its later answer correspond to different inbound messages, even when they share a run. Reminder-origin deliveries later require an explicit producer/occurrence identity and cannot pretend to quote an old inbound message.

Define any new suppressed, refresh-pending or cancelled delivery phase additively; do not silently reinterpret existing `READY`, `LEASED`, `DONE` or `DEAD` states. Old workers must not consume unsupported payload versions. Deployment order is migration/readiness support, compatible worker, then feature enablement.

## Security and retention

Restrict tables to bot runtime roles and operator paths with a stated need. Deny general browser/anonymous access. Encrypt sensitive objectives, evidence, history and prepared text with authenticated row/category identities. Checkpoint serialization must also protect sensitive fields; using a private schema alone is not encryption. Verify the chosen adapter's serialization support or store only references to encrypted payloads.

Use live permission checks when reading historical business artifacts. Store no private signing keys, OAuth tokens or model reasoning. Define retention before pilot rollout; the existing inbox retention does not automatically define the appropriate evidence retention. Cleanup must not remove a live reminder/action's required reference or an unresolved operation record prematurely.

## Recovery and acceptance

Recover expired leases with fencing. A finalized run reuses saved output; an incomplete read may retry within limits; an uncertain future write reconciles. Checkpoint/run version disagreement must fail explicitly, never bypass access. Connection-pool limits and transaction-pooler behavior must be tested with the chosen checkpointer; do not rely on session-only settings without verification.

Integration cases include concurrent admission, transactional rollback at every handoff, restart after remote read before receipt persistence, stale lease writes, checkpoint lag, encrypted payload corruption, cross-account access, terminal cleanup and populated-schema upgrade. Tests use local PostgreSQL plus fake transport. Backups, keys and restores must cover run/evidence/checkpoint state consistently before production activation.
