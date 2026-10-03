# Reminder and task migration, evaluation and rollout

Status, 3 October 2026: **This release includes the scheduling review fixes. Production migration `202610030008` is applied and verified; both scheduling flags remain enabled and worker credentials are unchanged. Worker rollout uses CI/CD after pushing `main`; verify the exact release and runtime health.** Legacy import and capture scheduling remain separate work. See [current scope and operations](../personal-scheduling.md). Remaining sections retain the broader design contract; features outside that implementation summary are not promises of current behavior.

This contract complements the [design overview](../reminders-and-tasks-design.md), [personal tasks](49-personal-tasks.md), [scheduler](50-reminder-scheduler.md), [personal reminders](15-reminders.md), [SLA escalation](16-sla-escalation.md), [outbound delivery](14-outbound-delivery.md), [per-chat concurrency](46-per-chat-concurrency.md), [restart checkpoints](47-durable-model-checkpoints.md), and [outbound automation](48-outbound-automation-api.md).

## What the old bot establishes

The source review covers the repositories on disk, not a live deployment or database inventory:

- [`reminderService.js`](../../../../whatsapp-logistics-bot/src/services/reminderService.js) persists reminder intents, polls every 30 seconds, catches up on boot, and marks work more than one hour late as missed. It interprets model reply directives such as `[[REMINDER|minutes=...|text=...]]`; its parser rejects delays beyond 24 hours.
- The same poller selects **all** rows with `status=pending` and `dueAt<=now`; it does not filter by transport, application owner or bot number. Its conditional update changes `pending` to `sent` **before** calling Twilio. A crash in between can therefore lose a notification while retaining a `sent` record. A caught transport failure subsequently changes the row to `failed`.
- [`server.js`](../../../../whatsapp-logistics-bot/server.js) starts that poller during server startup. Creating a second poller without changing deployment ownership is unsafe even if the new implementation uses a different bot account.
- [`taskService.js`](../../../../whatsapp-logistics-bot/src/services/taskService.js) distinguishes standing tasks from timed reminders. It loads a sender's open tasks in creation order and resolves completion numbers against that previously loaded list. It parses mutation directives from generated reply text; individual completion updates use the resolved row ID. Persistence errors are logged and swallowed rather than returned as verified mutation outcomes.
- [`openclawService.js`](../../../../whatsapp-logistics-bot/src/services/openclawService.js) supplies open tasks and pending reminders as personal context. It formats times in `Asia/Kolkata`; its reminder context includes the time but not a full calendar date, which is insufficient for longer horizons.
- The [logistics Prisma schema](../../../../whatsapp-logistics-bot/prisma/schema.prisma) maps `Task` and `Reminder` to physical `task` and `reminder` tables, with ownership tied to `VerifiedNumber.phoneNumber`. The [CRM-Automations Prisma schema](../../../../CRM-Automations/prisma/schema.prisma) also maps these table names. That establishes a shared schema dependency; it does not establish which writers or pollers are running today.

Retain the useful distinctions: personal ownership, persistent intent, task/reminder separation, a short polling interval and bounded late catch-up. Replace reply directives, implicit phone-only ownership, claims represented as successful delivery, and success acknowledgements that can outlive failed writes.

The old code's 24-hour cap is a transport-specific implementation decision. It must not become a limit on Ramesh's stored reminder intent. Do not infer current WhatsApp transport eligibility from an old comment or promise that scheduling guarantees future delivery.

## Storage recommendation and reuse boundary

Use new, explicitly named Supabase tables. Do not repurpose the shared legacy tables in place.

| Proposed table                | Responsibility                                                                                                 | Retention/ownership boundary                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ramesh-tasks`                | Employee-owned standing tasks, status, version and optional task deadline                                      | Independent of WhatsApp message retention; completion and deletion are explicit operations               |
| `ramesh-reminders`            | Long-lived reminder intent, normalized schedule, recipient binding, version and optional task/entity reference | Remains valid for weeks or months; not an expiring outbound message                                      |
| `ramesh-reminder-occurrences` | One scheduled notification occurrence, condition checks, fixed deadline, lease and delivery linkage            | Retains enough state to deduplicate ticks and distinguish sent, missed, cancelled and uncertain outcomes |
| `ramesh-assistant-commands`   | Durable receipt for a requested mutation and its normalized arguments, owner and verified result               | Outlives model checkpoints and inbound message cleanup sufficiently to prevent duplicate mutations       |

The initial mutation contract commits one atomic batch per inbound turn. Creating a task together with its linked reminder is one transaction and one shared command receipt, not two separately acknowledged writes. Replay identity is tied to the trusted turn/batch, not a provider-generated tool call ID. A different regenerated proposal conflicts with the already committed batch and must be reconciled explicitly.

These four tables are created by production migration `202610030007`. Access uses the restricted worker role and explicit employee ownership checks; public/API roles and capture credentials have no production scheduling privileges. Migration `202610030008_personal_context.sql` extends `ramesh-assistant-commands.kind` with `context` and adds indexes for one context receipt per run and owner retrieval. It creates no additional table or broader grant. Context payloads are encrypted, expire after 24 hours and can be recalled only from actually delivered turns in the same owner's chat. That migration was applied in production on 3 October 2026; checksum, restricted-worker schema health, role grants and RLS were verified, with existing credentials and runtime flags preserved.

Reuse the current queue, outbound pacing, encryption, account transaction lock and send uncertainty handling. The reminder scheduler creates a short-lived delivery only when an occurrence is due. It does not put a three-month timer in the current outbound queue or keep a model invocation running until that time.

The existing outbound API accepts relative delivery expiry of up to 24 hours. That bounds delivery attempts after enqueue, not the age or future due date of reminder intent. A future scheduler needs to preserve an **absolute occurrence deadline** when calling or sharing the delivery admission layer; every retry must not mint a new relative expiry.

Existing legacy rows lack application ownership, occurrence keys, mutation receipts and lease fencing. Adding a new transport column alone does not make them safe: the deployed old poller ignores such a column. Existing `task` rows are also mapped by CRM-Automations. Never run a broad rename, delete, status rewrite or implicit takeover against either table as part of Ramesh deployment.

## Optional legacy import

The default rollout creates new Ramesh records only. Import is a separate, optional operation after a read-only live inventory and a reviewed ownership cutover. No such inventory or import has been performed for this design.

### Inventory before any import

Record the following without exposing reminder/task text, phone numbers or source credentials in ordinary logs or committed fixtures:

1. Physical table/column definitions, timestamp types, constraints, indexes, grants, RLS policies and all application mappings.
2. Counts by state, due-time bucket and source account; approximate oldest/newest records; duplicate/ambiguous owner mappings and unmapped recipients.
3. Every running deployment, cron, startup hook, worker and automation that reads or writes `task` or `reminder`, including Twilio configuration ownership. Repository references alone are insufficient.
4. Whether the live legacy bot can still create, list, complete or cancel tasks/reminders during the cutover. Stopping a poller while leaving producers active is not a completed transfer.
5. Timestamp interpretation evidence from the actual driver, session configuration and known recorded events. Prisma `DateTime` without an explicit timezone annotation does not prove stored UTC semantics.
6. A protected backup/export strategy, import dry-run report and a rollback owner. Exports containing personal text stay outside Git and follow the database's access and retention policy.

### Time conversion must be explicit

If a legacy column is `timestamp without time zone`, the import must not cast it implicitly using the import session's timezone. Establish whether values represent UTC instants or local wall time first. Only after that evidence is recorded should conversion use the verified source zone, for example `AT TIME ZONE 'UTC'` when UTC was actually established. A table can contain mixed historical conventions; ambiguous rows go into a review report rather than silently shifting by five and a half hours.

Ramesh stores due instants as `timestamptz` and preserves the interpretation zone, initially `Asia/Kolkata`. Retain original source values and the conversion policy in the protected migration evidence, not in conversational prompts.

### Import decisions

| Legacy input                                              | Proposed treatment                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Open task with one active verified owner                  | Eligible for an idempotent copy after source ownership is settled                                                              |
| Completed task                                            | Optional history import as completed; never create an active reminder automatically                                            |
| Future pending reminder with verified owner/time          | Eligible for an idempotent schedule copy only after the old consumer cannot send it                                            |
| Due pending reminder within the fixed catch-up window     | Explicit cutover decision using the original due instant and original late deadline; never give import time a new grace period |
| Due pending reminder beyond catch-up                      | Mark the imported occurrence missed if imported at all; do not send a backlog burst                                            |
| `sent`, `failed`, `missed` or `cancelled` reminder        | Optional historical record, never an active schedule; `sent` is not proof of receipt because of the old pre-send update        |
| Unknown status, ambiguous owner/time or transport binding | Skip with a review reason; never guess a recipient or reinterpret status                                                       |

An imported record needs an immutable origin mapping such as `(source_system, source_table, source_id)` with a uniqueness constraint. Preserve source state/version evidence and import batch ID. Re-running a batch must return the existing mapping, not create a second task or notification. Importing to different environments must use distinct databases/roles or explicit environment namespaces with enforcement, not a browser-controlled flag.

### Transfer ownership without duplicate sending

1. Produce a non-sending import preview with counts, source IDs, destination IDs, resolved owners and timestamps available only to authorized operators.
2. Disable the legacy producers and consumer for the selected scope, or first deploy and verify a transport/application filter that the old poller actually honors. A new database column without the corresponding old code change is insufficient.
3. Drain or reconcile in-flight sends. Treat ambiguous Twilio results and pre-send `sent` records conservatively; never automatically resend them as new Ramesh occurrences.
4. Freeze/recheck the selected source rows, then perform the idempotent copy and record the ownership boundary. Leave legacy records intact; the disabled/filtering legacy application prevents re-consumption.
5. Verify destination counts, owner bindings, due instants, terminal classifications and origin uniqueness without activating delivery.
6. Enable only the reviewed destination cohort. Monitor for any continued legacy writes. Newly appearing legacy pending work is an ownership violation to investigate, not an automatic invitation to import continuously.

## Clock and delivery policy

The initial personal slice implements the following baseline policies; conditional business behavior remains deferred:

- Scheduler tick: 30 seconds, plus a catch-up pass on startup. Tick cadence is not a promise of delivery within exactly 30 seconds; queue backlog and transport pacing also matter.
- Timezone: `Asia/Kolkata`. Store and compare UTC instants; interpret and display local intent in IST. Acknowledgements include an unambiguous date, time and timezone for future reminders, including those beyond the next day.
- Catch-up: at most one hour after each occurrence's original scheduled instant. Define `delivery_deadline_at = occurrence_due_at + 1 hour` once. At the exact deadline, the occurrence is expired/missed and cannot start a send. Restart, retry, temporary source failure and queue delay do not extend it.
- Horizon: no inherited 24-hour intent cap. Requests for next week, next month or months ahead create durable schedules when their dates are valid. They do not retain inbound media or provider sessions for that duration.
- Ambiguity: ask about materially ambiguous times such as “at 8” unless conversation context resolves morning/evening. An impossible calendar date is a clarification/validation result, not an automatic rollover.
- Recurrence: preserve local calendar intent where supported. Unsupported recurrence is explained rather than silently turned into a one-off. Month-end and leap-day policies must be explicit before activating those recurrence forms; the first version can limit recurrence to the forms with defined behavior.
- Ownership: the requesting active employee's DM is the initial recipient policy. Delegation requires an explicit authorization policy; a phone number in text is not identity proof. Resolve current recipient/employee access at mutation and due time.

Business-derived content must retain application-owned provenance and delivery classification through the mutation receipt, schedule and occurrence. A model-supplied label such as “personal” cannot remove protected-business delivery checks or turn a revoked CRM read into a scheduled plain-text notification. User-authored instruction text can still be stored as personal intent; it is not represented as a verified CRM fact.

Task completion, reminder cancellation, CRM activity and SLA resolution remain separate operations. For a task-linked reminder, task completion can suppress future notifications through an explicit linkage policy. It must not update unrelated CRM meaningful-activity clocks. SLA order remains **assignees first, then existing CRM admins**, with rules and episodes owned by CRM-Automations.

Long-lived schedules and command receipts must not depend on a foreign-key cascade from a WhatsApp message deleted after 30 days, a model checkpoint removed at finalization, or a media copy expiring after 24 hours. Store an independent command ID and stable owner/entity references. Keep an originating message reference as nullable audit metadata where useful. A far-future reminder cannot extend private media retention by retaining an attachment reference. Keep a durable consumed/completed marker on a one-off intent and a monotonic forward cursor for recurrence; pruning old occurrence or transport audit rows must not make an already consumed slot appear due again.

## Outcome-based acceptance matrix

Use public synthetic names and abstract task/reminder text. Assert user-visible outcomes and persisted invariants, not a particular model tool name, chain of thought or prompt wording. The matrix includes both implemented personal checks and future business/import/capture cases. It is not a claim that every future capability below exists or has been tested.

| Area         | Scenario                                                                                             | Required outcome                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Creation     | “Remind me tomorrow at 9 am” from an active employee                                                 | One committed schedule and an acknowledgement naming the resolved IST date/time                                    |
| Creation     | Database write fails after the model proposes a reminder                                             | No success acknowledgement; no partially active schedule                                                           |
| Creation     | Same inbound event is delivered twice                                                                | One schedule and the same verified command receipt                                                                 |
| Creation     | Restart after command commit but before acknowledgement                                              | Existing result returned; no second mutation                                                                       |
| Creation     | Checkpoint suffix invalidation generates a different provider call ID for the same committed request | Stable command identity recovers the receipt; provider call IDs cannot be the only idempotency key                 |
| Creation     | Regenerated arguments differ after an earlier command committed                                      | Conflict/reconciliation with the committed result; no silent second or replacement mutation                        |
| Ownership    | User types another employee's phone number as their own identity                                     | Actor remains the transport-resolved employee; no access to the claimed employee's records                         |
| Ownership    | Unknown sender requests organizational tasks/reminders                                               | Ordinary conversation remains available; no organizational mutation is committed                                   |
| Ownership    | Employee becomes inactive or the phone binding changes before due time                               | No automatic transfer of the reminder or its contents to another person                                            |
| Ownership    | Identical display names or conflicting verified numbers                                              | Ambiguity surfaced; no guessed recipient                                                                           |
| Task         | Add a task without any notification time                                                             | A standing task exists; no notification schedule is invented                                                       |
| Task         | Complete a linked task before its reminder is prepared                                               | Task completed once; linked obsolete occurrence suppressed according to policy                                     |
| Task         | “Finish the second task” after another client changes the list                                       | Resolve the previously presented stable selection or clarify; never complete the new second row accidentally       |
| Task         | Concurrent complete and rename/reschedule                                                            | Version conflict produces a truthful result; no lost update                                                        |
| Time         | Local midnight versus UTC day boundary                                                               | “Today” and “tomorrow” use IST, not the server's calendar day                                                      |
| Time         | 12 am, 12 pm, 00:00 and 12:00                                                                        | Correct midnight/noon interpretation and clear acknowledgement                                                     |
| Time         | “At 8” without sufficient context                                                                    | Clarification before scheduling                                                                                    |
| Time         | A request for next week or three months from now                                                     | Intent persists; no outbound message is created before its due occurrence                                          |
| Time         | Schedule survives 30-day message cleanup and 24-hour media cleanup                                   | Intent remains valid; deleted private media is not recovered or sent                                               |
| Time         | “31 February” or another impossible date                                                             | Validation/clarification; no silent date rollover                                                                  |
| Time         | Monthly 31st recurrence crosses April                                                                | Chosen documented skip/last-day rule, or unsupported-rule response before commit                                   |
| Time         | Leap-day one-off or recurrence crosses a non-leap year                                               | Valid 29 February preserved; unsupported/invalid recurrence handled explicitly                                     |
| Time         | Scheduler host timezone changes                                                                      | Due instant and user-facing IST time remain unchanged                                                              |
| Scheduler    | Two schedulers tick on the same due occurrence                                                       | One occurrence and one eligible outbound message                                                                   |
| Scheduler    | Crash after occurrence claim, before queue transaction                                               | Expired lease recoverable; stale owner cannot enqueue                                                              |
| Scheduler    | Crash after queue commit, before marking local progress                                              | Unique occurrence/delivery mapping prevents another outbound insert                                                |
| Scheduler    | A stale worker finishes after lease replacement                                                      | Its mutation/handoff is rejected by the lease token/version check                                                  |
| Scheduler    | Restart at due time plus 59 minutes                                                                  | At most one catch-up notification; remaining deadline is one minute, not a fresh hour                              |
| Scheduler    | Restart at or after due time plus one hour                                                           | Occurrence recorded missed/expired without sending                                                                 |
| Scheduler    | Clock jumps forward then backward                                                                    | No duplicate occurrence; original stored instants/deadlines remain authoritative                                   |
| Scheduler    | One conversation is slow while another has due work                                                  | Independent chats progress within the global bound, preserving each chat's order                                   |
| Cancellation | Human cancellation arrives after reminder enqueue but before `SENDING`                               | Reminder yields at claim/pacing fence; human turn runs and cancellation prevents SDK invocation                    |
| Cancellation | Task completion or rescheduling arrives while the reminder owns a lease                              | Release unsent reminder ownership, preserve human FIFO, and recheck the revised intent before any later send       |
| Cancellation | Repeated human turns keep a reminder waiting beyond its fixed deadline                               | Record a missed occurrence; do not force it ahead of the user or extend expiry                                     |
| Cancellation | Cancel while the occurrence is claimed but before `beginSend`                                        | Cancellation and sender use one arbitration boundary; unsent notification suppressed                               |
| Cancellation | Cancel after transport invocation began                                                              | Response acknowledges the send may already be in progress; no false retraction claim                               |
| Cancellation | Explicit snooze replaces a cancelled outbound job whose ledger row remains                           | Replacement uses a new dispatch generation/job ID; retries retain that generation and cannot resurrect the old job |
| Time         | Debounced batch spans IST midnight, with the reminder request in its later member                    | Relative date uses that command-bearing message's trusted admission clock, not the older batch root                |
| Cancellation | Snooze repeatedly across scheduler ticks                                                             | Versioned replacement timing; old unsent occurrence cannot fire                                                    |
| Cancellation | Reschedule to a later date while old output is waiting in the queue                                  | Old unsent output invalidated; exactly one new eligible occurrence                                                 |
| Delivery     | Disconnect before send                                                                               | Durable pending work retained only until its original deadline                                                     |
| Delivery     | Connection resumes after the original deadline                                                       | No stale notification is sent                                                                                      |
| Delivery     | SDK call times out or process dies after invocation                                                  | Occurrence/outbound state becomes uncertain; no automatic resend with a new key                                    |
| Delivery     | SDK accepts the message                                                                              | Report transport acceptance separately from recipient receipt/read status                                          |
| Business     | Linked CRM condition resolves before due time                                                        | Suppress obsolete notification based on a fresh authorized read                                                    |
| Business     | Source is stale/unavailable during condition check                                                   | Defer within the fixed deadline or expire; do not assert a breach from unknown data                                |
| Business     | Lead reassigned during escalation grace                                                              | Re-evaluate current assignees and authority; old recipient does not inherit notification rights                    |
| Business     | Personal reminder is snoozed or an alert is acknowledged                                             | CRM SLA/meaningful-activity clock unchanged                                                                        |
| Import       | Preview/import rerun for the same source rows                                                        | Same origin mappings; no duplicate active records or occurrences                                                   |
| Import       | Historical `sent`, failed or cancelled reminders encountered                                         | Never imported as active work                                                                                      |
| Import       | Legacy poller is still unfiltered/active                                                             | Activation blocked for the overlapping cohort, while unrelated work remains unaffected                             |
| Import       | Timestamp convention or owner cannot be established                                                  | Row skipped with a review reason, not guessed or silently converted                                                |
| Isolation    | Capture-mode reminder becomes due                                                                    | Only capture tables/sink touched; no production outbox or Baileys invocation                                       |
| Isolation    | Browser submits a production recipient, account or delivery flag                                     | Server-owned capture identity/routing wins; no authority switch                                                    |

## Evaluation harness and evidence

### Deterministic checks first

The review adds regressions for post-commit fallback rejection and same-run receipt recovery through the actual durable consumer, retained confirmation on authorization failure, bounded permanent-denial retries, personal-context ownership/expiry, ordered pagination continuation, quota enforcement on reactivation, pause attempt refunds, retained delivery outcomes and per-owner due fairness. Graph tests use fake models to verify the personal-only route avoids planner/formatter inference without skipping semantic verification, and that mixed answers keep both the useful additional answer and deterministic receipt. Composite evidence rejects mismatched owners. When a personal list/history/occurrence read informs an answer, `businessRecallAllowed: false` blocks business-only recall of that prose; receipt-only creation can retain its separately verified business segment.

The scheduling review passed 546 model-free tests with no skips, including local PostgreSQL integration, plus schema validation, TypeScript checks and the build. Documentation formatting is checked separately. The subsequent authorized rollout applied production migration `202610030008`; worker deployment uses CI/CD and requires exact-release/runtime verification. No new paid model tests were run for this review; the opt-in Luna runner remains available, and the previous release's paid reports are retained rather than rerun.

Use a fake clock for scheduling logic and explicit UTC/IST fixtures. Test calendar conversion as pure functions. In integration tests, use disposable local PostgreSQL databases and restricted roles; inject controlled database time or explicit timestamps at well-defined seams rather than depending on long sleeps. Do not change production clocks or write production schedules to validate date math.

Exercise the actual transaction code with two independent repository/scheduler instances. Force lease expiry, process interruption boundaries and concurrent cancellation/`beginSend`. Synchronize those races with test barriers so the assertions prove both possible orderings. Cancellation and send admission must use the existing account advisory lock and a consistent row-lock order. A race test must verify the stored occurrence, schedule version and outbound state together, not just that a callback ran once.

Use a fake WhatsApp session and a capture sink. Count transport invocations and inspect synthetic payloads. Deliberately fail acknowledgement, database commit and transport calls at separate boundaries to verify uncertainty behavior. A test must never obtain a real Baileys session or production sending credentials.

### Capture isolation

Capture configuration is server-owned. Prefer separate databases and roles for tests; if shared infrastructure is unavoidable, require explicit capture tables and a role unable to insert/update production delivery tables. An `environment` field or `test=true` request parameter alone is insufficient isolation.

The scheduler's capture mode must persist and claim realistic due occurrences and run authorization/condition checks through fixtures, then route its result exclusively to the capture sink. It must not call the production outbound automation API. Assert attempted access to the production queue is denied and that the transport factory is never constructed. The dummy GUI may display delivery previews but cannot change recipient binding or promote an occurrence to production.

### Model evaluation comes later

Most invariants here require no model. Reuse existing traces where appropriate, then run deterministic unit/integration checks before considering paid evaluations. If language ambiguity, multi-turn edits or acknowledgements still need measurement, use a narrowly approved synthetic outcome suite with `gpt-6-luna` for both agent and grader. Obtain the agreed case/repetition/spend scope first. A production model setting does not authorize an evaluation. Any Sol evaluation requires explicit user approval; no Sol tests are planned here.

Grade whether the intended task/reminder exists with the correct owner, time and state, whether a truthful acknowledgement was given, and whether unintended mutations/notifications occurred. Avoid exact-response matching or requiring a specific sequence of tool calls. Preserve interrupted/failing traces and do not rerun a broad suite solely to obtain a green report. Private business examples, if later needed, remain in ignored private fixtures and must not be committed.

### Review evidence

Record commit/schema versions, fixture timezone, policy versions, test scenario IDs and pass/fail results. Retain sanitized transaction/lease/command/occurrence identifiers needed to diagnose a failure. Never log reminder content, source credentials, phone numbers or attachment bytes by default. Passing these tests establishes implementation behavior under the exercised conditions; it does not by itself activate scheduling or establish production source health.

## Phased implementation and rollout

The table below remains the broader implementation plan. The initial personal slice is already active in production as `2bf91be` with migration `202610030007`; legacy import, conditional CRM/SLA integration and capture scheduling are not active. For this review release, the additive `202610030008` migration has been applied in production and verified against its checksum, restricted-worker schema health, role grants and RLS. Existing worker credentials and enabled runtime flags are unchanged. Deploy the compatible worker through CI/CD after pushing `main`, then check its exact release, schema health, scheduler ticks and connection status without sending a test notification. Applied migration state alone is not proof that the new worker is running.

| Phase                         | Work                                                                                      | Exit condition                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 0. Design and inventory       | Agree owner/time/recurrence/late policy; inspect legacy writers only if import is desired | No unresolved double-owner assumption; no production activation                             |
| 1. Additive persistence       | New Ramesh tables, restricted grants, version checks and command receipts                 | Deterministic mutation, idempotency and retention checks pass; scheduling remains disabled  |
| 2. Capture scheduler          | Due-claim/occurrence/condition/outbound-admission behavior through capture only           | Clock/race/restart/expiry matrix passes with production sends impossible                    |
| 3. Personal task tools        | Current-employee task and reminder mutations, committed-result acknowledgements           | Agent cannot claim success on failed writes or repeat committed mutations after replay      |
| 4. Small production cohort    | Enable explicitly selected employees and supported recurrence forms                       | Operator-reviewed preview, bounded volumes and observable delivery outcomes                 |
| 5. Optional legacy import     | Follow the separate ownership freeze, conversion and origin-mapping process above         | Old producers/consumer cannot overlap; imported history does not become new active work     |
| 6. CRM escalation integration | Consume authoritative CRM episodes and fresh recipient/condition decisions                | Assignee-then-admin policy, source-health and reassignment tests pass; no second SLA engine |

Do not make silent table reuse or an import a prerequisite for new reminder functionality. A clean new cohort can start without modifying legacy records. Keep rollout controls for schedule mutation and due processing independent so a delivery incident can pause the scheduler without discarding intent.

## Rollback and operational limits

Pause new schedule admission and due processing for the affected scope. Preserve tasks, reminder versions, command receipts and occurrence/outbound mappings. Stop claiming new work, then drain or cancel work that has not crossed the send boundary using the same fenced state transition as normal cancellation. An uncertain/invoked send remains uncertain; neither rollback nor a restart makes it safe to resend.

Do not automatically re-enable the old Twilio poller as rollback. It does not understand Ramesh's versions, import ownership or future horizons and can duplicate already prepared/sent work. Returning a cohort to the old application would require a separate reconciled transfer with terminal/uncertain outcomes excluded. It must not rely on copying Ramesh rows back as `pending`.

The safe rollback state is durable intent with delivery visibly paused, not deleted schedules or two active owners. After correcting the issue, resume with the original due instants and fixed catch-up deadlines. Schedules outside that window are missed, not replayed as a fresh batch. The review does not change current production enablement or perform a legacy import.
