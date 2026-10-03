# WhatsApp feedback, reminders and conversation controls

Implemented on 4 October 2026. Production Supabase migrations through
`202610040004` were applied and verified on that date: checksums, restricted-worker
health, new-column access, RLS and indexes passed. Credentials and the capture
schema are unchanged. The worker rolls out separately through CI/CD; migration
success alone does not establish which code is running.

- Incoming archived messages receive delivery and read receipts immediately,
  without waiting for model generation, debounce completion or media extraction.
  Untagged group messages can be marked read without generating a reply. Self
  messages, protocol events and history imports do not trigger feedback. Audio
  receives a read receipt, never a played receipt.
- Once a request enters planning/tool work, Ramesh replies `Sure, just a sec.`
  and reacts `✏️`. A debounced batch uses its latest direct instruction. A fenced
  database marker prevents repeated acknowledgements across retries and restart.
  The pencil stays as acknowledgement, not a claim that the operation succeeded.
  Ordinary direct chat skips this step. Feedback is best effort and uses no model.
- Typing presence starts when admitted work begins, including media processing,
  thinking, tool use and final composition. It refreshes every eight seconds and
  clears when preparation finishes, fails or is cancelled. It does not run while
  a message is merely waiting in the queue. Presence is best effort, has a
  five-minute safety cutoff and does not change the account's global offline
  presence. Separate chats and overlapping owners cannot clear each other's
  indicator. This uses Baileys `composing`/`paused`; WhatsApp presence expires
  without refresh ([Baileys documentation](https://github.com/WhiskeySockets/Baileys/blob/master/README.md#update-presence)).
- Reminders begin with `⏰ Reminder:` and retain their resolved IST due time.
  New reminders quote the original authorizing WhatsApp message, using a minimal
  encrypted snapshot tied to the owner and reminder. It survives recurring and
  snoozed deliveries and inbox cleanup. Text/captions retain original wording;
  audio retains its key and type without transcript, bytes or download credentials.
  Other media quotes retain only type and caption. Media retention stays 24 hours.
  Existing reminders without provenance remain unquoted, and a damaged/mismatched
  snapshot never invents a replacement quote. A clarification may be the current
  authorizing message, for example `tomorrow at 10`.

## Replying to a reminder

Reply directly to a delivered reminder with `done` or `snooze 30m`. The trusted
native quote identifies the exact occurrence. The resolver checks current employee
identity, ownership, chat, reminder version and delivery generation before any
change; it never falls back to the latest reminder. These shortcuts use no model.

`done` marks that occurrence acknowledged, retaining its delivery history. It does
not complete a linked task or cancel future recurring reminders. `snooze 30m`
reschedules that occurrence and preserves its original quote and recurrence.
An acknowledged or replaced occurrence cannot be snoozed. Command receipts and
the write audit make retry/restart recovery idempotent.

The sender saves the exact native WhatsApp message ID atomically with confirmed
`SENT` completion. Uncertain deliveries, older notifications without recorded
keys, foreign quotes and occurrences beyond the existing 30-day retention cannot
be targeted this way. Plain unquoted `done` remains ordinary assistant input.

## Stopping work

A direct typed `stop` is handled during durable ingress, ahead of debounce and
the busy conversation worker. In a group, it also requires an actual bot mention
and targets only that sender's work. Forwarded text, voice transcripts and tool
content cannot invoke this control.

The transaction cancels eligible earlier unsent investigations in the same chat,
fences their database writes and delivery, and aborts active preparation. Other
people's chats, automatic reminders and operator messages remain independent.
Saved effects and published confirmations are preserved and reported separately.
Already sending or uncertain replies cannot be withdrawn; stopping is not rollback.
Independent media/provider work already in flight may still finish.

The fixed acknowledgement uses the durable outbound queue. Duplicate commands
cannot cancel later work or enqueue another acknowledgement. If the outbound
capacity is exhausted, cancellation still succeeds without adding another reply.

## Migration and compatibility

Apply the full ordered migration sequence before deploying this worker:

1. `202610040002_reminder_source_quote.sql`: nullable encrypted reminder quote and
   the inbound work-acknowledgement marker.
2. `202610040003_investigation_stop.sql`: durable STOP outcome on the message row.
3. `202610040004_reminder_replies.sql`: occurrence native message ID and
   acknowledgement timestamp.

Worker readiness requires schema `202610040004`. These additions create no new
role or table and need no new environment settings. Capture storage is unchanged;
automated checks do not instantiate a live sender.

The schema addition preserves old reminder text, but older worker code does not
understand version 4 queued reminder payloads. Do not roll back to an older sender
without first accounting for pending version 4 reminder deliveries.

## Validation

Use fake transports, real pinned Baileys serialization and isolated local PostgreSQL.
Check read receipt routing, stalled sockets, reaction failure, batch selection,
planning versus direct chat, duplicate/restarted acknowledgement claims, and late
feedback suppression. Reminder checks cover source ownership, current-run/batch
membership, source deletion, recurrence, snooze, legacy payloads, malformed
snapshots and final native quote context. Control checks cover exact quoted targets,
fresh authorization, idempotency, recurrence, STOP during active work, protected
effects, queue capacity, stale completion fencing, unrelated chat progress and
typing cleanup. The actual durable sender is exercised with a fake WhatsApp
session and disposable PostgreSQL. No paid evaluation or real WhatsApp message
is needed for these deterministic changes.

## Additional proposals for review

These are suggestions, not implemented behavior:

1. Extend the exact quoted reminder shortcuts to natural-language rescheduling
   such as `tomorrow at 10`, retaining the same trusted target and IST conventions.
2. Add a per-user preference for concise answers and quiet hours for nonurgent
   proactive reminders, with explicitly requested reminder times taking precedence.
