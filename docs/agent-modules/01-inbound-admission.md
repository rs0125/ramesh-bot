# Inbound admission

Status: **Existing queue admission; first-read trusted context integrated.** Depends on [shared contracts](00-shared-contracts.md), [identity](02-identity-resolver.md) and [persistence](13-supabase-persistence.md).

**Implemented subset:** DurableMessages passes the original decrypted transport key and persisted message UUID to the graph. Its journal callback is tied to the current inbound lease. Account-wide serialization remains unchanged. See the [first-read runbook](../first-crm-read.md) for the exact code contract and activation steps; production enablement remains separate.

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
5. Attach the input to an existing waiting run only after sender, audience, expiry and reference checks. Otherwise create a new run with a unique origin-input association.
6. Dispatch to the orchestrator. Finalization or a waiting transition releases the claim through the repository; the transport layer does not manufacture a reply.

The first CRM pilot retains current account-wide serialization. The later concurrency increment uses conversation-scoped fencing and separate generation capacity. Database arrival order is the processing order; message timestamps inform age checks but are not a reliable global ordering primitive.

## Failures and recovery

Duplicate admission never creates a second run. A crash after enqueue but before run creation recovers from the inbound job. A crash after run creation reuses the unique run association. A stale lease holder cannot create a competing completion.

An SDK event can still be lost before the database enqueue commits; Baileys ingestion is not an acknowledged durable upstream queue. Preserve this limitation in operator metrics. Database errors must not silently fall back to SQLite in a production account already configured for Supabase.

If the queue is full, preserve the existing observable admission outcome; do not issue an untracked WhatsApp reply. Invalid or undecryptable payloads become a bounded terminal error. Disconnect cancels active processing according to the existing connection policy; resumption rechecks age and run state.

## Acceptance cases

| Case                                                | Required behavior                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| Duplicate event, including during capacity pressure | One stored request/run, no second automatic reply                         |
| Untagged group text                                 | Context may be archived; no automatic run                                 |
| Quoted number or forged display name                | Does not alter the actual sender                                          |
| LID sender and missing reciprocal mapping           | Ordinary chat still works; business admission fails closed                |
| Restart between enqueue and run creation            | Exactly one run association is recovered                                  |
| Expired claim racing a new owner                    | Only the current fenced owner can advance work                            |
| New request while another run waits                 | Routes independently unless a valid reference binds it to the waiting run |

Implementation requires a run-admission repository transaction and propagation of the original trusted transport reference. No new WhatsApp listener or polling mechanism is needed.
