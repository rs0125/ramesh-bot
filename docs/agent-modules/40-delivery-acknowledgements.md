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
acknowledge transport delivery using the original trusted remote JID, participant
and message ID. This is not a read/played receipt, a model response or a business
authorization decision. Do not acknowledge failed persistence, self messages or
unadmitted history. Persisted duplicates can be acknowledged again.

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
persistence failure; prove receipt calls never become read receipts or sends.
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
