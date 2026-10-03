# Business actions

Status: **Generic write execution and audit implemented; CRM domain commands remain deferred.** The [implemented write contract](../business-writes.md) supersedes the proposed table/state names below. Context Engine advertises scoped GIS creation and compensation; read tools stay separate. Depends on [identity](02-identity-resolver.md), [executor](08-tool-executor.md), [persistence](13-supabase-persistence.md) and source-system command handlers.

## Responsibility

Dispatch narrow validated changes to the systems that own the records. Twenty owns CRM mutations; WAG's backend owns supply validation/review workflows. Writing the CRM mirror directly is not a valid shortcut.

Candidate first commands are adding a note or changing a follow-up date. The exact catalogue, caller roles, required fields and confirmation policy must be specified before activation. Avoid generic patch, arbitrary SQL and model-controlled API endpoints.

## Proposal contract

`ActionProposal` identifies the originating run, actor, record, command/version, exact normalized payload, source revision/preconditions, human-readable preview, payload hash, expiry and current status. Store sensitive payloads encrypted in proposed `ramesh-action-proposals`.

The application decides which command classes require explicit confirmation. A read does not require confirmation; a clear low-impact personal reminder request may directly authorize its schedule tool. Material business writes should present their concrete change under the selected command policy.

A confirmation binds actor, audience, proposal ID/hash, record revision and expiry. An ambiguous “yes,” another participant's reply, changed payload or expired proposal cannot authorize execution. Confirmation does not expand backend permissions.

## Execution and state

Proposed states are `proposed`, `waiting_confirmation`, `authorized`, `executing`, `committed_unverified`, `verified`, `reconciling`, `rejected`, `cancelled` and `expired`. These belong to the action record, distinct from the conversational run and delivery status.

Recheck active employee, command scope and source preconditions immediately before execution. Use a stable operation idempotency key where the upstream supports it. If it does not, define a command-specific deduplication/reconciliation strategy before exposing that command.

Persist the attempt before the call. Verify against the authoritative source after success, preserving its command/record ID. A lagging CRM mirror must not trigger the same write again. Report committed-but-not-yet-verified or uncertain outcomes honestly.

## Uncertain outcomes and attribution

A timeout after dispatch enters reconciliation. Read the authoritative record or query the upstream operation before retrying. A model's suggestion to “try again” cannot bypass this state. Do not claim rollback occurred unless a real, separately authorized compensating command did so.

Attribute requesting employee, application service, run and source command separately. Bot-generated housekeeping or notifications should not reset meaningful-activity clocks accidentally. Domain owners define which employee-confirmed actions qualify as real sales activity.

## Acceptance and release gate

Test duplicate inputs, replayed confirmation, changed actor, stale revision, payload edits, scope removal, source rejection, timeout after commit, mirror lag, reconciliation after restart and cancellation racing dispatch. Verification must compare actual source state with the authorized payload.

No command is enabled until its source API semantics, authorization, idempotency behavior, conflict policy, audit and confirmation requirements are implemented and tested. These requirements remain the admission gate for each new CRM command; the generic writer does not itself grant CRM mutations.
