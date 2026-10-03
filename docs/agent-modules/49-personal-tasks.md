# Personal tasks

Status: **Implemented; production schema `202610030007` applied. Runtime flags control activation.** Owned tasks, atomic mutation receipts and persisted selection references are implemented. See [current scope and operations](../personal-scheduling.md). Remaining sections retain the broader design contract; features outside that implementation summary are not promises of current behavior.

## Product contract and examples

A personal task is a durable commitment owned by the requesting employee. It is distinct from a Twenty CRM task, a sales activity and an agent's internal execution plan. Its initial state machine is `open` → `done` or `cancelled`. No background model is needed to keep it alive, and its lifetime is not bounded by the conversation window or 24-hour media retention.

Initial access is an active verified employee's own private chat. Bind ownership to account and stable employee ID, never to a caller-supplied phone number. Unknown users can discuss or draft a list in ordinary chat but do not receive persistent personal task tools under this policy. Delegation, shared/group tasks and external contacts are separate features.

| User request                                                             | Intended behavior                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| “Add a task to compare the revised warehouse offers.”                    | Save one open personal task; no invented deadline or reminder.                                                           |
| “Add a task to send the brochure by Friday.”                             | Save the explicit deadline at its stated precision, without assuming notification permission.                            |
| “Add a task to review the lease, and remind me on 15 November at 10 am.” | Atomically save the task and its linked reminder, then acknowledge the exact IST time.                                   |
| “Show my pending tasks.”                                                 | Read the owner's durable open tasks and return a bounded ordered selection.                                              |
| “Mark the second task done.”                                             | Resolve the previously displayed stable ID/version, then complete that task and cancel eligible unsent linked reminders. |
| “Draft a reply saying I am done.”                                        | Draft text; do not complete any saved task.                                                                              |
| “Assign this task to Priya in CRM.”                                      | Require the separate CRM/delegation capability; do not silently create a personal substitute.                            |

Conversational statements are not automatically task commands. Use the user's intent and context; clarify only when a statement such as “I should review this on Friday” leaves persistence materially uncertain. An explicit “add”, “complete” or “cancel” request does not require redundant confirmation.

## Tools and application authority

Advertise local task tools dynamically only when the feature is enabled and the requester satisfies the identity policy. Introduce an explicit application-owned mutation path; do not weaken the existing read-only Context Engine filter or rely on a model prompt as the write guard.

| Tool            | Proposed arguments                                                            | Trusted behavior                                                               |
| --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `task_create`   | Task text/notes, optional explicit deadline and explicitly requested reminder | Stage owned creation; validate all requested linked records together.          |
| `task_list`     | Bounded state/date filters and pagination                                     | Read only authorized owner records and return an ordered selection reference.  |
| `task_update`   | Stable/selected reference, expected version, changed text/deadline            | Apply only explicit fields through an owner-scoped version check.              |
| `task_complete` | Stable/selected reference and expected version                                | Mark done and cancel eligible unsent linked reminders in the same transaction. |
| `task_cancel`   | Stable/selected reference and expected version                                | Cancel the task and eligible unsent linked reminders atomically.               |

The runtime supplies account, owner, admission timestamp, command identity and authorization. A model cannot select an owner or recipient, mint an authoritative version, or grant itself a broader write capability. Reject authority-shaped extra fields. Text and notes are data, not instructions to execute tools.

`task_list` advertises `readOnlyHint: true`. Mutations advertise `readOnlyHint: false`; creates are not generally idempotent across independent explicit requests, while command replay is deduplicated by application code. Complete/cancel operations must accurately describe state-changing behavior rather than claiming append-only safety.

Return typed failures for inactive identity, absent/unauthorized target, stale version, ambiguous selection, invalid date, capacity and storage failure. An unavailable list is not an empty task list. A proposed write or an error-shaped result is never evidence that persistence succeeded.

## Minimal data model

Propose `ramesh-tasks` under the same restricted Supabase access conventions as the assistant's durable state:

| Field                                          | Meaning                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `id`, `account_id`, `owner_employee_id`        | Stable task identity and authorization scope.                                     |
| Encrypted text and optional notes              | User-authored commitment, with protected-content provenance where applicable.     |
| `state`                                        | `open`, `done` or `cancelled`; no inferred CRM status.                            |
| Optional deadline and precision                | Explicit timed instant, or explicit local date without an invented time.          |
| `timezone`                                     | Initial `Asia/Kolkata`, retained for interpretation/display.                      |
| `version`                                      | Incremented on accepted user-visible edits/state changes.                         |
| `creation_command_key`                         | Durable creation identity, retained independently of old chat/checkpoint cleanup. |
| Created/updated/completed/cancelled timestamps | UTC audit instants set by trusted application/database time.                      |

An explicit timed deadline is UTC `timestamptz` with timezone. A date-only deadline such as “by Friday” retains a local date and `date` precision; do not fabricate a 9 am or midnight notification. Proposed date-only overdue semantics begin after that IST calendar day ends. An actual reminder still needs a precise notification time. Application validation enforces mutually exclusive date-only and timed forms.

There is no 24-hour task horizon. Keep an open task until its owner completes or cancels it, regardless of message history. Terminal retention/deletion is an explicit lifecycle policy, not an accidental consequence of outbound/message cleanup. Initial scope excludes automatic reopening, reassignment and recurring task generation; recurrence belongs to explicitly requested reminders unless a future task contract adds it.

Use `ramesh-reminders` for optional linked schedules, `ramesh-reminder-occurrences` for delivery opportunities and `ramesh-assistant-commands` for mutation/list receipts. Do not overload agent runs, chat messages or outbound jobs as the source of truth for a task.

## Atomic writes and graph recovery

The first implementation accepts **one bounded atomic mutation batch per admitted inbound turn**. Tools stage typed proposals; application code validates ownership, exact selection, expected versions, limits and normalized arguments, then commits once. A batch can include several explicitly requested tasks or a task with its requested reminder. It cannot commit one part and report another part as successful after failure.

Persist the admitted operation slots and normalized batch before execution. The durable receipt binds account, trusted employee, original inbound identity and fingerprints of normalized arguments. Mutation and committed result share a database transaction. Feed the receipt to formatting and verification so the assistant states the actual saved text, deadlines, versions and counts.

On graph recovery, load accepted/committed command state before allowing writes. Reuse the same batch; do not reconstruct new operations solely from a regenerated model response or tool-call ID. A changed proposal for an occupied slot is a reconciliation conflict, not permission for a second task. No additional write batch can start after one has committed in that turn. Independently requested later tasks with the same words remain distinct user intentions.

Resolve relative dates using the server-captured admission timestamp of the command-bearing inbound member and persist that member identity, clock and normalized date/instant. A grouped/debounced turn must not use an earlier unrelated member's timestamp. A restart across midnight must not shift “Friday”, “tomorrow” or a duration. Native model checkpoints may help recover tool-call mapping, but the database receipt remains authoritative if checkpoint saving or acknowledgement delivery failed.

Retain terminal command receipts for a proposed 30 days after resolution; retain unresolved work until reconciled. Bound inbound replay so an expired job cannot recreate a mutation after its receipt is purged. Active tasks and their creation identities outlive this receipt retention. Private receipt payloads/results are encrypted and remain owner-authorized on every read.

Concurrent edits use compare-and-swap against the expected version. A losing edit returns a conflict and the authorized current state for resolution; it does not silently overwrite. A replay of the same completion returns its receipt. A different request against a stale target/version still receives normal conflict handling, even if a similar terminal state has since been reached.

## Ordered conversational selection

“The second task” refers to the list actually presented, not whichever row is now second in a fresh query. Persist a bounded encrypted list receipt in `ramesh-assistant-commands` containing account/owner, selection reference, filters/page and the exact ordered task IDs with observed versions. This reuses the fourth table rather than adding a general conversation-memory table.

Bind the snapshot to the finalized outbound presentation. If formatting changes or omits entries, the final recorded order must still match the numbered list the user saw. Task/reminder lists should use deterministic rendering or verified references so the formatter cannot silently reorder the IDs. An unsent/failed newer list cannot replace the last presented selection; an uncertain presentation requires explicit disambiguation. An acknowledgement between listing and selection must not erase a valid reference.

A mutation accepts either a stable task ID with expected version or an owner-bound selection reference plus ordinal. Resolve that ID, recheck current authorization and compare version within the transaction. New tasks, sorting changes and pagination cannot change the selected identity. A stale, expired, deleted or ambiguous reference prompts a fresh list or clarification; never substitute a neighboring task.

Store only bounded relevant snapshots with the command receipt retention policy. This capability covers personal task/reminder selection; it does not claim that arbitrary historical CRM lists are now exactly recoverable. Failure to retrieve a receipt must not be disguised as “you have no tasks”.

## Task and reminder linkage

A task has no reminder unless the user asks for one. A deadline is informational by itself. Several explicitly requested reminders may link to one open task, each with its own schedule and version. Task-plus-reminder creation commits together, or neither part is acknowledged as saved.

Changing a task deadline does not silently shift an independently chosen reminder. If the user explicitly asks to move both, stage both edits in the same atomic batch. Snoozing a linked reminder changes its notification timing, not the task deadline or any CRM activity clock.

Completing or cancelling a task must, in one transaction and the lock order from module 50:

1. Validate active owner, target and expected version.
2. Set the terminal task state, version and timestamp.
3. Cancel active linked reminder definitions and invalidate their eligible unsent occurrences/jobs.
4. Commit a receipt describing the task change, affected reminders and any delivery already past the send boundary.

The planned scheduler-origin queue must let unsent reminders yield to pending human inbound turns, including when already leased or pacing. This gives a later “done” or “cancel” turn a chance to commit before `SENDING` while retaining FIFO among human turns. It is a prerequisite to the new feature, not current deployed automation behavior.

If completion wins the final transaction fence, linked unsent reminders cannot call the sender. If a send has begun, say the current notification may still arrive; cancel future ones. Preserve sent/uncertain history and never automatically resend an uncertain occurrence. Completing a task after its notification was accepted is still an ordinary task mutation, not a transport recall.

## Privacy and business boundaries

Apply account/owner authorization in both the local executor and repository operations. Current active identity is required for task queries, mutation receipts and selection references. Another employee using a reassigned phone must not inherit the prior owner's task text. Logs contain IDs, states and reason codes rather than personal notes or phone numbers.

Task content such as “send this file to an external number” is not continuing authority to perform that action. Saving a task stores the commitment; it does not trigger arbitrary tools, CRM writes or future automatic delegation. A reminder can quote an authorized personal instruction without executing it.

Preserve provenance of protected business content. The model cannot copy retrieved CRM facts into a personal task/reminder field to evade future source authorization or freshness checks. User-authored text and source-derived facts are distinguished by the application; protected references require the business-linked policy or a deferred capability. Do not expose stored protected material through a personal list after access has been revoked.

An ordinary personal task does not require CRM access. Conversely, a valid personal-task identity or outbound service key does not authorize a CRM write. A request to complete a CRM follow-up, assign work to another person or modify a deal must use its separately authorized capability and must not be silently approximated with a private todo.

## Legacy reuse decision

Reuse the legacy product concept, not its physical tables in this increment. The existing phone-keyed `task`/`reminder` tables lack the new stable-owner, revision and durable-command contracts; the legacy reminder poller claims all pending reminders for Twilio. Adding new Ramesh rows there would require a coordinated migration of every producer/consumer.

The inspected sources are the [legacy task service](../../../../whatsapp-logistics-bot/src/services/taskService.js), [reminder service](../../../../whatsapp-logistics-bot/src/services/reminderService.js), [legacy schema](../../../../whatsapp-logistics-bot/prisma/schema.prisma), and the shared mappings in [CRM-Automations](../../../../CRM-Automations/prisma/schema.prisma). These workspace-relative links are evidence of current local code, not proof of live legacy deployment state.

Use the four namespaced Ramesh tables and leave legacy records untouched. A later approved import/cutover needs ownership resolution, timezone validation, deduplication and old-worker coordination as specified in module 51. No automatic import or cleanup follows from this design.

## Observable acceptance outcomes

Verify behavior with synthetic employees, a fake clock, local transactions and fake/capture transport. These invariants need no paid model calls.

| Scenario                                                         | Required outcome                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Open task survives months, restarts and chat cleanup             | It remains owned and listable until an explicit terminal action.                 |
| Commit succeeds, formatter/checkpoint/acknowledgement fails      | Recovery returns the original receipt and creates no duplicate task.             |
| Same tool proposal repeats versus two separate explicit requests | Proposal replay resolves once; independent intentions can create separate tasks. |
| Task has a deadline but no requested reminder                    | No reminder or outbound job is created.                                          |
| Task-plus-reminder batch fails halfway                           | Transaction rolls back; neither is falsely acknowledged.                         |
| Two edits race on one expected version                           | One accepted change, one conflict; no lost update.                               |
| New tasks change list ordering before “complete the second”      | The original displayed ID is resolved and version-checked.                       |
| Task query/selection storage is unavailable                      | Report unavailability, not an empty list or guessed target.                      |
| Task completes while linked notification waits/paces             | Human turn can proceed; completion cancels eligible unsent reminders atomically. |
| Send crossed `SENDING` before task completion                    | Honest may-arrive outcome; no retry or claim of recall.                          |
| Inactive owner or reassigned phone requests old tasks            | Deny access without transferring ownership.                                      |
| Saved text contains tool instructions or external targets        | Text remains inert; no unrelated action or authority escalation.                 |
| Date-only deadline reaches IST midnight                          | Deadline precision is preserved; no invented notification is emitted.            |
