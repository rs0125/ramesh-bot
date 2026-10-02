# Inbound admission

Status: **Trusted queue admission is integrated. Per-chat concurrency and restart replay are implemented locally, not deployed.** Depends on [shared contracts](00-shared-contracts.md), [identity](02-identity-resolver.md) and [persistence](13-supabase-persistence.md).

**Implemented subset:** DurableMessages passes the original decrypted transport key and persisted message UUID to the graph. Its journal callback and checkpoint handle are tied to the current inbound lease. The local increment admits up to three active chats by default, with one active turn per chat and one outbound lease for the account. Leases last 30 seconds, renew about every 10 seconds and cannot extend message expiry. Production migrations `202610030004`/`202610030005` are required before rollout. See the [first-read runbook](../first-crm-read.md) for the exact code contract and activation steps; production enablement remains separate.

## Responsibility and current code

Convert a real Baileys event into durable, ordered work without letting message text choose its sender or destination. Reuse [message.mapper.ts](../../src/infrastructure/whatsapp/message.mapper.ts), [durable-messages.ts](../../src/infrastructure/whatsapp/durable-messages.ts) and [message-queue.repository.ts](../../src/infrastructure/database/message-queue.repository.ts).

The current system archives ordinary received messages, including untagged group context, while eligibility for an automatic reply is evaluated separately. Eligible text DMs and genuine group mentions become inbound jobs. Historical sync, own echoes, reactions and protocol events are not new requests. Media labels/captions do not imply file contents have been read.

## Interface

Input is a transport-owned `WAMessage`, current bot identities and account configuration. Persist the encrypted original message with its actual key before constructing an `InboundRef`. Preserve participant identity for groups. A request body typed by a user cannot construct a trusted transport envelope.

Admission returns the existing distinctions `queued`, `duplicate`, `full`, `ignored` and `observed`. Only `queued` authorizes automatic processing. `observed` context is not a pending request. A claimed inbound job exposes a fenced token and immutable input reference; the new run adapter passes those to the orchestrator without passing queue mutation authority into a prompt.

## Processing sequence

1. Normalize the supported message envelope and text bounds. Validate account, message ID, timestamp and transport type.
2. Compute reply eligibility from code-owned DM/group policy and message age. Keep archival independent from reply eligibility.
3. Atomically deduplicate `(account_id, chat_id, whatsapp_message_id)`, archive content and create the inbound job if eligible and within capacity.
4. Claim a job with a lease, reconstruct the original transport key and resolve identity. Unknown identity remains a valid conversational request.
5. Bind the run and encrypted replay store to that inbound job, trusted sender and current lease. On retry, reconstruct the graph, revalidate identity/tools and reread source data; reuse only exact matching completed model responses within the original deadline. Attaching a later clarification to a paused task remains proposed.
6. Dispatch to the orchestrator. Finalization atomically hands off to outbound and deletes the checkpoint. A storage/lease failure propagates to queue recovery; the transport does not manufacture a successful response.

The local concurrency increment preserves server-assigned admission order within each chat through generation, retry, handoff and sending. Pending work blocks its own chat while unrelated chats may advance. Debounce never crosses another participant or operator turn. Client message timestamps still inform age checks and do not choose processing order. See [module 46](46-per-chat-concurrency.md); captured GUI dispatch remains serial.

## Failures and recovery

Duplicate admission never creates a second run. A crash after enqueue but before run creation recovers from the inbound job. A crash after run creation reuses the unique run association and its original clock/deadline. Deterministic response replay can avoid completed model calls; it does not skip fresh authorization or source reads, and changed request inputs invalidate the saved suffix. A stale lease holder cannot create a competing completion.

An SDK event can still be lost before the database enqueue commits; Baileys ingestion is not an acknowledged durable upstream queue. Preserve this limitation in operator metrics. Database errors must not silently fall back to SQLite in a production account already configured for Supabase.

If the queue is full, preserve the existing observable admission outcome; do not issue an untracked WhatsApp reply. Invalid or undecryptable payloads become a bounded terminal error. Disconnect cancels active processing according to the existing connection policy; resumption rechecks age and run state.

## Acceptance cases

| Case                                                | Required behavior                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Duplicate event, including during capacity pressure | One stored request/run, no second automatic reply                              |
| Untagged group text                                 | Context may be archived; no automatic run                                      |
| Quoted number or forged display name                | Does not alter the actual sender                                               |
| LID sender and missing reciprocal mapping           | Ordinary chat still works; business admission fails closed                     |
| Restart between enqueue and run creation            | Exactly one run association is recovered                                       |
| Expired claim racing a new owner                    | Only the current fenced owner can advance work                                 |
| Another chat while a turn is running                | Progresses within the account cap without overtaking work in its own chat      |
| Later turn in the same chat                         | Waits through the earlier turn's retry and outbound handoff                    |
| Future clarification to a paused task               | Proposed: requires a validated reference; no paused-task resume is implemented |

The implemented queue and replay paths reuse the existing trusted transport reference, listener and PostgreSQL consumer. A richer paused-task admission transaction remains future work.
