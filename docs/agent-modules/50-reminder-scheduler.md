# Reminder scheduler and delivery

Status, 3 October 2026: **This release includes the scheduling review fixes. Production migration `202610030008` is applied and verified; both scheduling flags remain enabled and worker credentials are unchanged. Worker rollout uses CI/CD after pushing `main`; verify the exact release and runtime health.** See [current scope and operations](../personal-scheduling.md). Remaining sections retain the broader design contract; features outside that implementation summary are not promises of current behavior.

## Ownership and runtime

The schedule is durable intent. An occurrence is a due notification opportunity. An outbound job is a short-lived delivery. The scheduler turns eligible occurrences into outbound jobs; it does not perform the WhatsApp send itself and does not run an agent while waiting for a date.

Initially run one small scheduler service inside the worker process, started after database readiness and stopped before application shutdown drains resources. Multiple accidental or future scheduler processes must still be safe: use database leases and uniqueness, not a process-local singleton as correctness protection. The scheduler and Baileys consumer have separate enable switches. Capture mode must use separate tables/queue adapters and must have no production sender capability.

Current defaults: tick every 30 seconds, up to 25 claims per tick, two simultaneous preparation tasks, 30-second leases renewed every 10 seconds, and a 20-second preparation deadline. The reviewed scheduler materializes/reconciles once per tick before individual claims and admits at most three claims per owner per tick. This avoids repeatedly scanning/materializing schedules under the shared queue lock and prevents one owner's ready backlog consuming the whole batch. The per-owner allowance is local to a scheduler tick, not a cluster-wide rate limiter. A full queue defers preparation without spending a failed attempt; deliberate shutdown also refunds its attempt. The one active outbound send per account and shared capacity remain unchanged.

## Data contract

`ramesh-reminder-occurrences` should contain:

| Field                                                       | Meaning                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`, `account_id`, `reminder_id`, `schedule_version`       | Stable occurrence identity and owning schedule revision                                                                   |
| `slot_key`                                                  | Original scheduled slot in the recurrence calendar; never based on retry time                                             |
| `dispatch_generation`                                       | Zero for the normal slot; monotonically allocated replacement generation for explicit snooze only                         |
| `scheduled_for`                                             | Intended UTC instant                                                                                                      |
| `eligible_at`                                               | Next permissible preparation time, including explicit snooze/quiet-hour policy                                            |
| `not_after`                                                 | Absolute last permissible send instant; retries do not move it                                                            |
| `state`                                                     | `pending`, `preparing`, `waiting_source`, `queued`, `sent`, `cancelled`, `missed`, `failed`, `uncertain`, or `suppressed` |
| `lease_token`, `lease_until`, `attempts`, `next_attempt_at` | Fenced bounded preparation ownership and retries                                                                          |
| `recipient_employee_id`, `recipient_binding`                | Intended stable employee and captured identity binding; no caller-selected phone authority                                |
| `outbound_message_id`                                       | Link to the one prepared outbound job, nullable before enqueue and after ledger cleanup                                   |
| `source_ref`, `reason_code`, timestamps                     | Bounded audit references and state explanation; private text remains encrypted elsewhere                                  |

Use a unique key on `(account_id, reminder_id, schedule_version, slot_key, dispatch_generation)`. A normal scheduled slot uses generation zero. Index the due states by account and `next_attempt_at`/`eligible_at`, plus reminder/version for cancellation. Restrict writes to the intended runtime roles using the repository's existing RLS/grant conventions. Scope every query by account and owner where applicable; RLS alone does not supply the requesting employee.

The reminder stores the calendar rule, immutable anchor, revision and next slot cursor. Advancing the cursor does not increment the user-facing schedule revision. Editing the rule does. Persist recurrence generation and its cursor advance atomically. Materialize only the next needed occurrence; do not insert years of daily queue jobs or make an unbounded recurrence scan after downtime.

Keep active schedules regardless of age. Proposed retention for terminal occurrence details and command receipts is 30 days; preserve the schedule's last outcome and forward-only recurrence cursor longer. This prevents a retained recurring schedule from recreating purged historical slots. Do not tie the lifetime of a reminder or task to the 30-day message ledger. Use a nullable outbound linkage with safe deletion semantics, so normal message cleanup cannot delete intent or fail because an old occurrence references it.

A one-off schedule also retains its consumed slot/version independently of the occurrence row. Materializing its sole occurrence records that slot atomically; reconciliation stores the schedule's final outcome. Purging an old terminal occurrence must never make the one-off eligible to materialize again. A deliberate reschedule uses a new revision, not erasure of the consumed marker. Unresolved, leased or queued occurrences/commands are not eligible for terminal retention cleanup.

## Due processing

1. Using the database clock, materialize and reconcile a bounded due batch once per scheduler tick. Then claim prepared occurrences in short transactions, excluding owners that used their tick allowance. Ignore cancelled schedules, future slots and already queued/terminal occurrences. Acquire a random lease token and deadline.
2. Release the transaction before any identity or Context Engine call. Renew ownership during bounded preparation. A stale process must not enqueue after its lease expires.
3. Resolve the owner and intended recipient from stable active employee IDs. Require an unambiguous current phone/LID binding and the appropriate schedule permission. A changed phone binding must be deliberately re-resolved; it cannot transfer ownership of someone else's reminder.
4. For a linked task, verify it is still open. For a conditional business reminder, read the authoritative current record/condition using explicit scheduler authority and a recipient-scoped projection. Unknown or stale source health means `waiting_source`, not an assertion that the condition is true. An obsolete condition becomes `suppressed` or resolves the schedule as its policy specifies.
5. Render a short WhatsApp template. Plain personal reminder text requires no model. If future dynamic briefings use a model, give them a separate finite preparation budget and preserve the same delivery guards.
6. In one transaction, revalidate lease, schedule revision, task state, expiry and recipient binding; insert the encrypted outbound job and mark the occurrence `queued`. Advance the recurrence cursor/materialize its next slot in a consistent transaction where required. Wake the existing sender only after commit.

Do not hold database locks during tool calls, image processing, pacing or WhatsApp operations. Source data can still change between a remote read and dispatch; use the existing bounded-freshness delivery receipt/preflight contract for protected business content and be explicit about that limit.

Preserve content provenance: an instruction authored by the requesting user can be ordinary personal reminder text. A model must not copy retrieved CRM, warehouse or analytics facts into that field to bypass future authorization and freshness checks. Source-derived content retains protected references and follows the business-linked path, or that schedule request is deferred until that capability exists. The model cannot downgrade the classification itself.

## Queue integration and irreversible send boundary

Add an internal schedule-aware enqueue method backed by the same transaction client as occurrence updates. Refactor a small shared queue insertion helper if needed; do not copy the public endpoint logic into another independently committing path. The current repository's transaction/admission lock must remain consistently ordered with schedule locks to avoid deadlocks.

Propose `origin='reminder'` and a typed schedule-delivery reference containing occurrence, reminder revision, owner/recipient identity and absolute deadline. This origin is generated only by the scheduler; neither the public automation request nor a model can set it. The deployed `origin='automation'` path remains an immediate arbitrary-recipient service send and does not claim these guarantees.

Derive the job ID from account, reminder ID, schedule revision, original occurrence slot and `dispatch_generation`. Enqueue the occurrence and job once. Use the absolute occurrence deadline for outbound `expires_at`, optionally capped by the shorter transport freshness window. Do not turn each retry into a fresh `expiresInSeconds` allowance. If the job expires while disconnected, reconcile that same occurrence; any catch-up generation must be an explicit new policy outcome, not a hidden retry with a new key.

Immediately before `beginSend`, perform current identity/permission preflight. Then one short transaction must lock the relevant schedule/occurrence and job, verify the same schedule revision, dispatch generation and eligibility, and persist `SENDING`. Cancellation, rescheduling and task completion use the same lock order and fence. If cancellation wins, the SDK is never invoked. If `SENDING` wins, cancellation can stop later occurrences but cannot promise to recall this one.

Use the existing account-scoped queue advisory lock first across admission, `beginSend`, cancellation and task-linked edits; then lock task rows, reminder rows, occurrences and queue rows in stable ID order. A shared adapter must enforce that order. Recheck the current recipient binding as well as active employee status: an unchanged owner ID does not authorize sending to an old phone after reassignment.

The final authorization read and the network send cannot be one atomic transaction. A revocation after that read remains a narrow external-state race; do not advertise an absolute guarantee that a message can be recalled. Keep the interval short, abort before SDK invocation when cancellation is observed, and record the exact send boundary.

### Let user turns reach cancellation before sending

The existing strict conversation FIFO presents an extra race: a reminder enqueued before a later “cancel that” message would block processing the cancellation until the reminder had sent. The new scheduler integration must therefore introduce a narrow priority exception for **unsent `origin='reminder'` notifications**. Such jobs yield to pending human inbound turns for that chat; human turns retain their own FIFO order. Admin sends, ordinary assistant replies and generic automation jobs keep their existing ordering contract.

Change both the conversation-head claim predicate and the final pre-send check. A reminder must not be claimed ahead of a pending human turn. If a human turn arrives after its lease was claimed, release the unsent reminder lease after pacing/before `beginSend` under the same account lock; the claim predicate must then allow the human turn past that reminder. Do not infer cancellation by matching message text. Any pending human turn gets the opportunity to change its tasks/schedules through normal authorized tools.

Reclaiming the reminder requires a fresh lease and current identity/source preflight. Its fixed `not_after` bounds starvation: repeated human work may cause a missed reminder rather than forcing the reminder ahead of the user. Once `SENDING` has won the atomic boundary, communicate that cancellation cannot guarantee recall. Human-turn priority is already deployed with the initial scheduling release.

### Crash and send outcomes

Reuse the transport's existing conservative outcomes:

| Event                                                | Recovery                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Crash before occurrence lease                        | Another tick can claim it.                                                                      |
| Crash during preparation                             | Expired lease permits another preparation with the same occurrence identity and fixed deadline. |
| Crash after queue commit, before wake                | Queue polling finds the committed job.                                                          |
| Crash before `SENDING`                               | Reclaim the unsent job if still eligible.                                                       |
| Send accepted                                        | Mark queue job `SENT`; reconcile occurrence `sent`.                                             |
| Crash/error after SDK invocation or lost send result | Record `UNCERTAIN`; do not automatically resend.                                                |
| Queue success, occurrence update failed              | Reconcile the existing job's terminal state without a new send.                                 |
| Schedule cancelled while job waits                   | Invalidate the queued job; final send fence prevents delivery.                                  |

`sent` means accepted by the transport, not recipient delivery/read or completion of the task. An acknowledgement/snooze does not satisfy a CRM follow-up or SLA. Preserve the original wording and intended due date in an overdue/catch-up notice where appropriate.

## Time, recurrence and catch-up

Use `Asia/Kolkata` for initial user interpretation and calendar recurrence. Store UTC instants and the IANA zone, not the server's local date. A daily 09:00 rule advances by local calendar dates; an explicit “every 24 hours” interval advances by elapsed duration. Do not conflate them even when they currently produce the same IST timestamps.

Proposed initial one-off policy: eligible at its requested instant and valid for one hour afterward unless the user gives an earlier hard deadline. Late by more than that becomes `missed`, visible in the user's list. Explicit snooze creates a replacement occurrence row with the same original calendar slot and schedule version, a new disclosed due instant, and a new `dispatch_generation`. Allocate that positive generation from a monotonic counter retained on the reminder, independent of occurrence cleanup. Cancel the superseded unsent occurrence/job atomically; preserve already-sent history. Include the generation in the new job ID and final send fence, so the replacement cannot collide with the cancelled job. Ordinary retries keep the same generation and deadline. A normal later recurring slot still starts at generation zero and retains the original recurrence anchor. An uncertain send is not automatically retried through snooze; a user must deliberately request a new notification.

For recurring schedules, keep at most one catch-up notification per schedule after downtime and record skipped slots. Advance directly to the next eligible local slot without emitting every missed occurrence. Coalescing is an explicit product policy: a once-daily check-in can say it was delayed, while a time-critical appointment reminder may be marked missed. Do not send a catch-up for an already `uncertain` slot.

Monthly day 31 and leap-day recurrences need explicit semantics: proposed default is skip months/years without that date; “last day of the month” is a separate rule. State this in creation acknowledgements when relevant. Weekdays mean Monday–Friday, not an unconfigured holiday calendar. A timezone change revises future schedules explicitly; changing the server timezone does not.

## Commands and conversational recovery

Task/reminder writes require a durable command receipt, not just a cached model response. In `ramesh-assistant-commands`, bind each operation to account, trusted owner, admitted inbound run/message, logical operation slot and a fingerprint of normalized arguments. Record its committed result in the same transaction as the mutation. Replays return that result; conflicting reuse is an error.

Anchor a relative time to the trusted admission timestamp of the actual command-bearing message. In a debounced batch, retain that member reference; an earlier voice note or forwarded message before midnight must not shift a later “tomorrow” request. Persist the chosen clock and normalized time in the batch receipt.

Generate command identities in application code. A fresh model tool-call ID after graph recovery is not a safe business idempotency key. Before resuming a write-capable turn, load its already committed commands and feed the receipts back into the graph; do not ask the model to recreate them. Use the existing native model checkpoint to recover the intended tool-call mapping when available, but the database receipt is authoritative even if a checkpoint write failed.

The command coordinator binds normalized intent and its result to one durable batch per inbound run. If recovery proposes different arguments after commit, stop for reconciliation rather than performing a second mutation. Before commit, a correction replaces the staged batch in full. Identical separate operations explicitly requested in one turn retain distinct operation positions. Limit allowed mutations per turn and do not deduplicate unrelated later user requests merely because their text matches.

Collect proposals into **one bounded atomic mutation batch per inbound turn**, with one durable receipt. This supports “create a task and remind me Friday” without committing an orphan task first. The tool adapter can replace an uncommitted proposal during verifier correction. The verifier reviews its deterministic pending preview; the application commits the final batch once and renders the receipt. A recovered turn reconciles that same receipt. It cannot start an additional write batch after one has committed. Multiple independent commit cycles in one conversation turn remain a later capability.

Store command payload/result encrypted with owner-bound references. The deterministic confirmation reads the committed receipt: exact saved date, affected count and whether a send had already started. It must not infer success from proposed arguments or an error-shaped tool result. The queue handoff verifies the stored command ID before finalizing any reply from a run that committed a mutation. A late error leaves that run eligible for bounded receipt recovery rather than finalizing “try again”. Delivery reauthorization failure preserves a protected confirmation for bounded retry rather than replacing it with generic failure prose. Command retention must outlast every allowed inbound replay; expired inbound work cannot recreate a command after its receipt is purged.

## Operations and observability

Expose scheduler health separately from WhatsApp connection: last successful tick, oldest due age, count waiting on sources, queue age, expired leases, missed/uncertain deliveries and reconciliation lag. Logs contain IDs and reason codes, not reminder text, media, phone numbers or service keys. Track queued-versus-sent and missed occurrences distinctly.

Provide an operator pause for due admission that does not discard schedules. Maintain bounded reconciliation/cleanup even while Baileys is disconnected. Ensure cleanup cannot erase a leased/queued occurrence whose delivery state is unresolved. Graceful shutdown aborts preparation and releases/reclaims leases; it does not mark a not-yet-invoked send as delivered.

See module 51 for failure cases and rollout gates. Production scheduling remains enabled and migration `202610030008` was applied and verified on 3 October 2026. This release includes the review fixes; deploy the compatible worker through CI/CD and verify its exact release and runtime health. No legacy table is repurposed, and this review does not send test WhatsApp messages or run paid evaluations.
