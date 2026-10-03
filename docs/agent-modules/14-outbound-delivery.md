# Outbound delivery

Status: **Durable sender and general tool-receipt preflight implemented; new producers proposed.** Reuse [durable-messages.ts](../../src/infrastructure/whatsapp/durable-messages.ts), [message-queue.repository.ts](../../src/infrastructure/database/message-queue.repository.ts) and [the queue contract](../supabase-message-queue.md).

**Implemented subset:** Protected replies require fresh identity/scope resolution and a matching re-read fingerprint after pacing. Revoked, changed, expired or disabled output is suppressed; the current read loop does not schedule automatic refresh. The encrypted versioned payload makes older string-only senders fail closed. See the [personal-assistant runbook](../sales-manager-agent.md) for the exact code contract and activation steps; production enablement remains separate.

Failed business delivery checks replace the withheld output with a neutral retry
notice under the same outbound lease. The transaction replaces both stored reply
copies, clears protected evidence and marks the agent run failed. A restart can
send only that notice; the original business memory callback is discarded.
Same-owner unexpired voice references still render their italic quoted transcripts.
Cancellation releases unsent work without creating a notice. See
[module 40](40-delivery-acknowledgements.md) for the production incident and tests.

## Responsibility

Deliver saved, authorized content through the one active Baileys account. The sender never calls a model to regenerate text and never accepts a model-chosen destination. Separate task completion from transport acceptance, delivery and reading.

## Input contract

`PreparedDelivery` includes server-bound chat/employee references, encrypted finalized text, purpose/classification, run epoch or reminder version, evidence/effect references, availability, expiry and an idempotent response/occurrence key. Existing automatic replies retain their original quote reference. Reminder payload version 4 carries an optional minimal original-command quote, validated against the current destination; reminders without stored provenance stay unquoted. All reminder text starts with `⏰`.

Operator messages remain separately attributable. The operational admin credential does not grant CRM reads or authorize an agent to populate a message with private business data. Preserve existing manual-send constraints to received conversations.

## Delivery sequence

1. Claim ready, due outbound work with a fenced lease.
2. Validate payload version, current run/reminder version, destination and expiry.
3. For business content, re-resolve the recipient and recheck access to referenced records through application services. Do not rely on an old credential or employee snapshot.
4. If time-sensitive evidence has expired, suspend the prepared output and request a bounded refresh; do not send stale claims. If access is denied, suppress sensitive content.
5. Apply existing pacing and recheck lease/expiry/cancellation immediately before the send boundary.
6. Commit `SENDING`, invoke the bound Baileys send once, and record SDK acceptance or an uncertain outcome.

For a reminder, supply a stable native WhatsApp message ID derived from its durable
dispatch and persist it on the exact occurrence in the `SENT` completion transaction.
Quoted `done`/`snooze` commands resolve this ID with current owner and generation
checks. A lost send response remains uncertain and is neither automatically resent
nor treated as a confirmed quick-reply target.

The business preflight interface must be implemented for the first enabled preset. If no appropriate current-access check can be performed, that business message cannot be sent. A fresh scoped reread may establish access for a small result set; it also consumes a bounded delivery-preflight budget and must preserve the answer's stated freshness.

## Cancellation, revocation and uncertainty

Cancellation before the send marker prevents delivery. A policy/version change invalidates pending content. Authorization and external send cannot be one database transaction; minimize the interval between preflight and invocation, and record check time. Do not claim revocation can recall a message already sent.

Retain existing conservative uncertainty handling. A crash or timeout after the send boundary may mean WhatsApp accepted the message; do not automatically resend. `SENT` means SDK acceptance, not a read receipt. Retry only demonstrably unsent work, reusing the exact saved content after required checks.

The initial pilot retains global account serialization. Later independent generation must not bypass sender pacing or create multiple socket owners. A slow model should eventually cease blocking unrelated ready outbound work, but that change requires explicit lease/concurrency tests.

## Acceptance cases

Cover restart after finalization, stale leases, duplicate response keys, expired replies, employee deactivation after queueing, lost record visibility, reassignments, stale evidence, cancelled run epochs, unknown destination, failed preflight and a crash after possible send. Confirm that denied content is never included in a generic failure message or exposed through an unrestricted operator trace.

All automated cases use captured transports. Existing ordinary chat must still deliver without requiring CRM access. Reminder and business-reply classifications default closed until their preflight implementation and schema support are present.
