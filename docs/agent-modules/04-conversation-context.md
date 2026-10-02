# Conversation context

Status: **Implemented 32-message context and fresh authorized recall; richer reference objects proposed.** Depends on [identity](02-identity-resolver.md), [shared contracts](00-shared-contracts.md) and [persistence](13-supabase-persistence.md).

**Current contract:** The inbox replaces protected reply bodies with a private placeholder for operators. Model history uses a content-free completion marker for captured or sent business replies, so completed questions do not look unanswered; no business facts enter that marker. Process-local fallback follows the same rule. Server-only stored reply/receipt envelopes support `recall_business_context`, which checks the current employee and repeats scoped reads before restoring an unchanged previous answer and order. Changed source results withhold old wording. Independent durable entity references and clarification threads are not implemented. See the [personal-assistant runbook](../sales-manager-agent.md) for the exact code contract; production enablement remains separate.

## Responsibility and current foundation

Assemble the minimum history and entity references needed for the current request without treating old messages as current authorization or current business facts. Reuse [assistant.service.ts](../../src/modules/assistant/assistant.service.ts), [conversation-memory.ts](../../src/modules/assistant/conversation-memory.ts) and [inbox.repository.ts](../../src/infrastructure/database/inbox.repository.ts).

Production reads encrypted Supabase inbox history. Local chat uses bounded process memory. Group history includes other participants and untagged context, which must remain labeled as background. A captured image/media label is not its contents. Previously sent assistant text is conversational history, not fresh evidence.

The [old logistics bot review](23-context-and-media-reference.md) supplies the reference for app-owned Postgres history, bounded turns and expiring media pins. The completion marker is a Ramesh adaptation: preserving the fact that a reply occurred avoids treating a sequence of old business questions as outstanding work. Only the latest request, plus references needed to interpret it, should trigger reads. Private bodies remain excluded from ordinary model history and can only be restored via the bounded recall tool. The context window is 32 messages / 48,000 characters; recall metadata is separately bounded to 96 KB and 24 hours. See [module 24](24-business-recall-and-deal-display.md). Attachment processing is implemented in module 30; typed durable entity references remain an extension.

## Interface and projections

`loadConversationContext(InboundRef, ActorBinding, policy, signal)` is a proposed application port. It returns bounded history, unresolved references, pending-run references, locale/timezone, context provenance and truncation indicators. The authority object remains outside model-visible content.

| Projection | Allowed contents                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------- |
| Converser  | Recent audience-safe messages, current request, enabled capabilities and unresolved references |
| Planner    | Objective, explicit requirements, permitted tool summaries and selected verified references    |
| Worker     | One step, required entity IDs, relevant fresh evidence and that step's tool schemas            |
| Verifier   | Request, frozen contract, candidate result and registered source evidence                      |
| Formatter  | Authorized answer bundle and language preferences                                              |

No role automatically receives another role's full message history. Do not infer a standing instruction or grant from a stored summary.

## Isolation and freshness

Use account, chat, audience and employee binding to select business context. Public group history can remain shared within that group; personal business history cannot. A phone changing employee ownership starts a new business-context binding. Unknown identities cannot receive cached results from a previously verified session.

Record entity references separately from factual snapshots. “That lead” may resolve to a recent lead ID only when unambiguous, but using it requires a new scoped read. Before replaying stored business facts, check current permission and relevant freshness. If source access cannot be established, omit the protected context and explain that live data is unavailable when relevant.

In the first read slice, prefer request-local tool evidence and exclude prior generated business-result bodies from ordinary chat history. Add durable, reauthorized business memory only with explicit content classification. This avoids accidentally making a conversational follow-up bypass current scope checks.

## Pending input and user changes

A clarification record identifies its run, epoch, question, permitted responding actor/audience and expiry. A reply containing an explicit message/run reference can resume it. If several tasks await input and “yes” is ambiguous, clarify. An unrelated request creates another run; it does not confirm a pending write.

Cancellation invalidates the run epoch and unsent prepared output. A changed objective versions the contract. Never convert new group context from another participant into a private employee's confirmation.

## Limits, failures and acceptance

Enforce size bounds before constructing prompts. Current local memory limits are a baseline, not an excuse to concatenate unbounded receipts. Truncation preserves the latest request, required caveats and reference ambiguity. Retrieval failure returns a typed unavailable context; a safe greeting may still be answered.

Acceptance covers concurrent employees, separate groups, phone reassignment, removed record access, quoted instructions, ambiguous references, pending-task collisions, missing media contents and history after uncertain delivery. Only transport-accepted assistant replies enter sent conversation history; an unsent candidate must not be presented as a prior conversation turn.

Retention and operator visibility follow the persistence/observability policies. Protected recall uses the existing encrypted inbox and delivery receipts, not a second independent CRM cache. Production enablement remains a separate rollout.
