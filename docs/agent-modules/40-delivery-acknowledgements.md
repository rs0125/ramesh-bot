# 40. Production delivery acknowledgements and failure visibility

## Observed incident

On 2 October, a voice note entered the production media store, downloaded and
transcribed successfully. The agent completed five permitted CRM/supply reads and
saved a business response. The outbound verifier rejected it, leaving the message
EXPIRED with `business_delivery_not_authorized`, so the user received nothing.
The original data fingerprints still matched when replayed, and the full fresh
preflight reproduced the rejection. Diagnosis identified the identity lookup
conflict without weakening source or authority checks. Transcription and final
delivery are different stages.

The failure was reproduced as concurrent Prisma P1008/P2028 errors in reciprocal
LID resolution. Replace the interactive SQLite transaction with discovery of the
candidate phone key followed by one SELECT that re-reads both mapping directions
in one snapshot. Validate both decrypted values; a changed/disappearing mapping
still denies access. Do not serialize all MCP queries or extend timeouts to hide
this problem. Supabase remains the message, queue and business-data store; this
SQLite lookup is only for Baileys session state.

Baileys 7.0.0-rc14 uses an inactive receipt while `markOnlineOnConnect=false`.
Before this fix, Ramesh added no normal delivery acknowledgement. The old logistics bot
used Twilio webhooks/media delivery, so its transport acknowledgements were handled
by Twilio rather than this Baileys adapter.

## Receipt contract

Keep offline presence. After successful durable message archival, explicitly
acknowledge transport delivery and mark the message read using the original trusted
remote JID, participant and message ID. The 4 October QoL change adds the explicitly
requested blue-tick read receipt; it never claims audio was played. Neither receipt
is a business authorization decision. Do not acknowledge failed persistence, self
messages or unadmitted history. Persisted duplicates can be acknowledged again.

Admit both `messages.upsert` kinds (`notify` and `append`). The pinned Baileys
version emits messages received while offline as `append`, including new requests
sent during a reconnect. Apply the same timestamp, sender, group-mention and
persistent deduplication checks to both kinds. Stale deliveries may be archived as
observed context but must not start a reply; the separate `messaging-history.set`
event is not ingested. Self messages and protocol events remain excluded.

Receipt dispatch must be bounded and must not hold up admission of the next item
in a forwarded burst. Receipt failures must not change a saved queue job into a
persistence failure. Keep error logs free of message content, JIDs and credentials.
Use fake sockets in tests; never send diagnostic receipts to an old user message.

## Working acknowledgement

When the graph begins planning/tool work, send one fixed `Sure, just a sec.` reply
and a `✏️` reaction to the original request. A burst targets its latest direct
instruction, falling back to its last member. Simple direct chat and catalogue
loading alone do not trigger this. Actual tool calls and confirmed business-write
dispatch also signal the same hook; the transport deduplicates them.

The application supplies the target and fixed text, never model arguments. Before
dispatch, claim `ramesh-inbound-queue.acknowledged_at` under the current live lease.
This persists across retry/restart. It records an attempt, not guaranteed delivery:
a crash after claiming may omit cosmetic feedback instead of duplicating it.
The claim is bounded and cancelled when answer preparation ends, preventing a slow
claim from sending progress after the answer is ready. Socket feedback is bounded,
best effort, and independent of the durable final-answer outbox; failures cannot
repeat tools or close the session. The pencil remains as an acknowledgement, not
a success receipt. No extra model call or business content is involved.

Migration `202610040002_reminder_source_quote.sql` adds this marker and reminder
quote provenance. The current pending QoL batch also includes migrations through
`202610040004`; apply the complete ordered sequence before worker rollout.

Typing presence now follows active preparation, including thinking/tool work,
with an eight-second refresh, five-minute cutoff and cleanup on completion or
cancellation. Direct `stop` is a durable ingress control that can cancel unsent
investigations without waiting for that chat's worker. Neither cosmetic feedback
nor cancellation claims successful rollback of an already committed effect.
See [WhatsApp QoL](../whatsapp-qol.md) for exact reminder replies and control limits.

## Delivery verification contract

Maintain current employee authorization, original query scope and stable source
fingerprints. Diagnose the concrete failing check with safe reason/tool metadata.
No generic 'authorization' label for every transport or source outage. Retry only
transient reads within the original deadline; revoked authority and changed
business facts remain denied. A correction must retain the same protection in
both WhatsApp and capture sinks.

A failed check now produces a neutral failure notice. Persist replacement output
atomically under the current outbound
lease before sending it. Do not put the withheld business reply into SENT history,
call its original memory callback, or mark a business task complete. Preserve
same-owner voice transcript references only while unexpired. No replay or automatic
send of the old incident is part of diagnosis.

## Validation

Test persisted text/audio/batched messages, duplicated messages, full inbox and
persistence failure; prove explicit read receipts preserve the original keys and
never become played receipts. Verify one work acknowledgement across concurrent
claims and restart, and suppression of late feedback.
Exercise the reproduced delivery failure, concurrent reads, source changes,
revocation, cancellation and restart. Keep the normal provider evaluation frozen
while transport changes are implemented in an isolated checkout. Re-run the
relevant deterministic and real-data capture checks before rollout.

The combined release passed 237 tests without skips and shipped as `cdd9881`.
CI run `37023166129` and EC2 deployment `37023329168` passed. After deployment,
the full CRM graph completed with delivery authorization, and the original five
queries passed a fresh concurrent preflight in 3.78 seconds. Both were read-only
diagnostics with no sender. Sender-side ticks still need observation on a new real
message; no historical receipts or old business replies were replayed.
