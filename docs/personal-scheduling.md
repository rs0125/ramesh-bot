# Personal tasks and scheduling

Implementation status, 3 October 2026: personal scheduling is implemented and production migration `202610030007` is applied. Runtime flags control activation after a compatible release passes readiness checks. This page describes current implementation; the [design overview](reminders-and-tasks-design.md) and modules 15/49/50/51 also include future policies.

## What an employee can ask

- “Add a task to compare the offers.” Saves a personal task without inventing a notification.
- “Remind me on 15 November 2026 at 10 am to call the owner.” Confirms the complete date and time in IST.
- “Every Monday at 9 am, remind me to review my pipeline.” Creates a weekly schedule. Daily and monthly rules are also supported.
- “Show my tasks/reminders.” Returns a numbered page. “Complete the second task” resolves the actual last delivered selection with its recorded version.
- “Move that reminder to tomorrow at 11 am”, “cancel it”, or “snooze it for 30 minutes”. Changes owned schedules; snooze replaces one occurrence while retaining the recurring rule.
- “Add a task to review the lease and remind me on 15 November at 10 am.” Creates the task and linked reminder atomically. Completing/cancelling the task cancels its unsent linked reminders.

Access requires an active, unambiguous VerifiedNumber employee in their own DM. Unknown users can still chat. Personal tools do not require a Context Engine OAuth grant and do not expand CRM write access. Phone/LID mappings are rechecked when using tools and before delivery. A changed or disabled identity suppresses delivery; ownership never transfers to the next holder of the number.

Personal tools are dynamically added as `personal_list` and `personal_apply`. The latter stages one atomic batch of at most eight operations. Code validates ownership, input schema, exact user-authored text spans, versions and dates; the verifier reviews intent; then the application commits and renders its own receipt. It never reports a model's draft as a successful write. Restart recovery reads committed receipts before generating another response.

For a mixed personal/business request, the committed personal receipt takes priority in this first slice; business prose may need a follow-up. A mutation receipt lists its affected records rather than a stale pre-mutation list. Paginated lists render the latest requested page per kind and say “this page”; only that delivered order becomes the ordinal selection.

Forwarded content cannot itself authorize writes. A direct, fully retained voice transcript can supply the owner's instruction. Saved instruction text does not retain the audio beyond its existing 24-hour lifecycle. Retrieved business facts cannot be copied into an unprotected schedule by the model. Conditional CRM reminders, delegation, group reminders, SLA escalation and arbitrary scheduled tool execution are not implemented. Requests needing them must be explained or clarified, never silently simplified.

## Time and lifecycle

Use `Asia/Kolkata` for interpretation/display and UTC instants in storage. Relative durations anchor to the specific trusted command member's admitted time, including debounced turns. A task can have a date-only deadline; that alone does not schedule a notification. There is no 24-hour reminder horizon.

Recurrence supports daily, selected ISO weekdays and monthly dates. Day 31 skips months without that date; “last day” is a separate rule. An optional end instant is inclusive. Weekdays are not an Indian holiday calendar. Materially ambiguous times require clarification.

The scheduler ticks every 30 seconds by default. An occurrence keeps a fixed deadline one hour after its scheduled time. Restart, pacing, queue capacity and retry do not extend that deadline. Missed historical recurring slots are coalesced by advancing the cursor directly; the worker does not send a backlog flood. Delivery is subject to connection state and queue pacing, not an exact-second promise.

Defaults: 50 open tasks and 100 scheduled reminders per owner; ten entries per tool list page; 25 due candidates per tick; two concurrent preparations; 30-second renewable preparation leases; a 20-second preparation timeout and at most five failed preparation attempts. Queue saturation defers work without spending a failed-preparation attempt. Future intent survives message cleanup. Terminal occurrence details and command/list receipts have 30-day cleanup; active tasks and schedules are retained, along with durable cursor/consumed state.

Reminder text and command/selection payloads are encrypted. Replies use the existing private delivery envelope and redacted inbox/history behavior. Ordinary logs do not contain reminder text or phone numbers.

The existing v1 admin inbox presents reminders as assistant messages for compatibility. Supabase still records the distinct `reminder` origin for queue priority, delivery checks and audit.

## Delivery and cancellation

The scheduler uses templates, with **no model calls at due time**. It atomically inserts an encrypted `origin='reminder'` job into the existing outbound queue and links its occurrence. Stable job identities and command receipts prevent duplicate effects after restart. A terminal-message trigger preserves the outcome before message history expires.

Unsent reminders yield to a pending human turn and its response in the same chat. This lets “cancel that reminder” run before delivery. Any necessary earlier non-reminder work keeps its relative ordering while passing the deferred reminder. A leased reminder checks again before pacing and at `beginSend`.

The final database transaction verifies the occurrence, schedule version, dispatch generation, owner, recipient binding, linked task and deadline. A cancellation that commits first prevents sending. If sending already started, the receipt says the notification may still arrive. `UNCERTAIN` sends are never automatically retried or converted into snoozes.

## Storage and activation

Migration `supabase/migrations/202610030007_personal_scheduling.sql` adds:

| Table                         | Purpose                                                |
| ----------------------------- | ------------------------------------------------------ |
| `ramesh-tasks`                | Owned commitments and optional deadlines               |
| `ramesh-reminders`            | Schedule intent, recurrence cursor and revision        |
| `ramesh-reminder-occurrences` | Due slots, generations, leases and delivery outcomes   |
| `ramesh-assistant-commands`   | Atomic mutation receipts and delivered list selections |

Only the dedicated worker receives table privileges. The capture role is explicitly denied. Existing `public.task` and `public.reminder` are untouched because the legacy Twilio poller did not isolate application ownership. No legacy import is included.

Production migration `202610030007` was applied and verified on 3 October 2026: the checksum matches, the terminal trigger is enabled, all four tables have RLS and worker-only CRUD, and capture/API/public grants are absent. For a new environment, apply the ordered, checksum-verified production migrations through the existing message-database provisioning workflow. Preserve the deployed `ramesh_worker` password and TLS settings; never point SQLite Prisma migrations at Supabase. Schema health now requires `202610030007`, even while scheduling is disabled, because queue queries reference occurrence state. The independent capture schema is unchanged.

```dotenv
PERSONAL_SCHEDULING_ENABLED=true
REMINDER_SCHEDULER_ENABLED=true
REMINDER_SCHEDULER_POLL_MS=30000
```

Both features default off. Deploy the compatible binary and verify its release/readiness before enabling the flags, then restart that same binary to load them. Tools require configured OpenAI inference and Supabase message storage. Delivery can run without an inference provider. The poll setting accepts 1000–60000 ms. Keep production and SSM runtime settings consistent when deploying.

Authenticated `GET /v1/status` includes scheduling enablement, running state, last tick, last successful tick and a sanitized error flag. It does not expose personal records. To pause due processing, set `REMINDER_SCHEDULER_ENABLED=false`; already queued notifications still follow their stored delivery fences. Disable both flags to remove new tool access as well. A pause does not cancel existing intent. Use an intentional transport stop for an immediate delivery halt; normal outbound jobs otherwise remain active.

Rollback: keep the additive schema installed. A pre-scheduling binary cannot process reminder jobs correctly and may mark them failed. Stop the sender and scheduler and review pending reminder deliveries before any code rollback; a producer-only pause does not stop the outbound consumer. Prefer a compatible forward fix once reminders exist.

The existing dummy GUI cannot mutate production schedules. Deterministic scheduling tests use a disposable local PostgreSQL database, fake models, synthetic employees and fake transport. Conditional reminders, delegated recipients, a scheduling capture adapter and richer operational counters remain later work.

## Optional Luna prose evaluation

`npm run eval:scheduling -- --max-usd 0.25` exercises the actual graph and tool schemas against synthetic records in a disposable **local** PostgreSQL database. Supply `TEST_MESSAGE_DATABASE_URL`, `OPENAI_API_KEY` and a reviewed `EVAL_USAGE_PRICES_JSON` profile. The default model is `gpt-6-luna`; selecting Sol still requires explicit approval through the shared evaluation policy. This is opt-in and is not part of CI.

The three bounded scenarios cover casual relative-date phrasing, a corrected duration within a debounced burst, and a conditional business reminder that must not become an unconditional schedule. Assertions inspect committed rows and times, not an exact model sentence. All graph stages use the selected evaluation model; no extra paid grader is needed. The fake transport cannot contact WhatsApp, and the fixture refuses remote database URLs. Private reports and shared campaign spending records remain in `.local/evals/`; retain failed runs rather than repeatedly rerunning them.

The [official Luna model reference](https://developers.openai.com/api/docs/models/gpt-6-luna) documents Responses API function calling and supported reasoning effort. Production model configuration does not select the evaluation model.

## Validation recorded on 3 October 2026

The full deterministic check passed 518 tests with local PostgreSQL, followed by successful focused personal-tool and accounting checks after the final changes. TypeScript, build, formatting and migration/permission checks passed. Those tests performed no production database changes or WhatsApp sends. The subsequent authorized rollout applied production migration `202610030007` and verified it without adding test records.

Luna verified the three prose outcomes: “parso subah 10 baje” resolves to the correct IST date; a later “make that 40 minutes” correction saves one reminder using the correcting member's clock; a conditional CRM reminder saves nothing and explains the unsupported future check. Manual review caught a misleading access workaround in the conditional response. The dynamic capability context and prompts were corrected, and that case alone was verified again.

An initial run stopped because new cache-write usage could not be priced. The meter now supports an explicitly configured cache-write rate while retaining unknown usage when that rate is missing. Original failed reports were preserved with separate accounting reconciliation, and the subsequent runs used the remaining original allowance. Total calculated provider usage was **$0.014349**, across 22 requests including that interruption and the focused recheck, within the original $0.25 allowance. This is a small functional sample, not a statistical quality guarantee.

Reports remain ignored under `.local/evals/scheduling-2026-10-03T08-27-58.636Z-7b114a7a`, `scheduling-2026-10-03T08-33-18.157Z-e62e1683` and `scheduling-2026-10-03T08-38-35.153Z-bb62ff3c`. The last includes the consolidated campaign accounting. Do not rerun the paid scenarios just to refresh these reports.
