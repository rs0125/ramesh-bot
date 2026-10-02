# Formatter and final answer gate

Status: **Model formatting followed by independent evidence review implemented.**

**Implemented subset:** The personal-assistant formatter uses human-readable deal names, native Created/Last updated dates, and warehouse IDs, with page coverage, uncertainty and capability boundaries. Deal UUIDs are hidden. The first formatting pass receives source evidence; a deterministic UUID/date-label guard complements semantic review. finishReply applies style guards, then the verifier reviews the resulting text. The historical daily preset retains its deterministic renderer. Generic multi-worker AnswerBundle contracts below remain proposed. See the [personal-assistant runbook](../sales-manager-agent.md) and [module 22](22-sales-manager-tool-loop.md) for the current contract. Production enablement remains separate. The richer role/task contracts below remain target design unless explicitly identified as implemented.

## Responsibility

Produce readable WhatsApp text while preserving the authorized result. It edits wording; it does not retrieve records, resolve identity, choose a destination or perform actions. Its output is still checked before queueing.

## Input and output contract

Ordinary chat retains the existing request/draft input. Business responses receive an `AnswerBundle` containing typed facts, names/IDs, dates, amounts/units, evidence references, coverage limitations, mandatory caveats and an outcome. These are data, not instructions.

The output is final text plus an application-derived list of included claim references. The application must not trust a model's claim list without checking it against the bundle. Never embed signing material or raw MCP error bodies.

## Rendering strategy

For the first follow-up lookup, prefer a deterministic renderer for business rows and required caveats. It can format an intro, lead labels, due fields and a bounded-result note without an additional model rewrite of facts. The existing formatter remains available for ordinary chat and clarification. This still uses the same formatting boundary and outbound contract.

For later complex answers, the model may compose prose around structured facts. Immutable values can be rendered by code or protected placeholders. Validate that required negations, uncertainty, names, dates, units and action status survive. Reject unknown placeholders or newly introduced factual claims; use a safe structured fallback or return to verification.

## Style requirements

- Match the user's language/script and level of formality.
- Answer directly with short sentences and useful lists when needed.
- Avoid em dashes, canned AI introductions, corporate filler and automatic closing offers.
- Preserve uncertainty: “not recorded” cannot become “unavailable,” and “drafted” cannot become “sent.”
- Do not mention internal agents, credentials, SQL, validation contracts or queue states in normal user replies.
- Keep ordinary outputs within the existing 4,000-character graph limit. If business results exceed the limit, reduce the selected page before rendering and disclose the bound; do not cut off facts or caveats mid-sentence.

## Final gate and failures

Code rechecks current run epoch, permitted audience, output size, control characters/style and immutable claim values. Business results must have passed operational verification. A formatted reply does not relax authorization: delivery rechecks access again if the reply waits in the queue.

Formatting failure cannot convert a denied/unavailable business operation into a friendly success message. Use a verified deterministic fallback when available. Otherwise return a safe limitation, preserve the failed trace and stop within budget. Cancellation must prevent late text from being finalized.

## Acceptance cases

Cover dates crossing midnight, lakh/crore or area-unit preservation, numbered lead labels, partial-page caveats, unknown availability, zero results, pending versus completed reminders, and user text containing formatting instructions. Repeated model evals assess naturalness and fidelity; code asserts style/size and protected facts.

Regression tests must retain the existing ordinary-chat behavior. The first CRM slice should not require rewriting every conversation prompt or changing delivery pacing.
