# Scoped task worker

Status: **Separate native worker model session and deterministic executor implemented locally.**

The converser routes intent, the planner creates an outcome contract, and the worker chooses native function calls to fulfil it. A distinct executor node validates and performs those calls. The worker may adapt to actual results without resetting its 24-source/28-total proposal budgets. The independent verifier receives the task plan and current evidence; one bounded repair can continue the same worker session. See [module 29](29-planner-worker-verifier.md). Generic durable multi-worker task handoffs below remain future design.

The generated plan is an assistant message named `provisional_task_plan`, followed by the unchanged current user request. It is not interpolated into worker instructions or called a validated requirement. The shared [interpretation contract](../../src/prompts/requirement-interpretation.md) keeps targets, minima, maxima, units, source claims and user corrections distinct. Genuine material ambiguity warrants one focused question after relevant context or a bounded read; it does not authorize a guessed write or require routine requests to go through extra confirmation.

The worker's callable subset is refreshed on every continuation from the remaining
business, personal and write allowances, bounded by the same 28 total proposals.
Exhausted families cannot borrow another family's allowance. A stale exhausted
proposal returns `TOOL_BUDGET_EXHAUSTED` without a remote call; gathered evidence
remains available to the formatter and verifier. Responses uses the documented
[`allowed_tools` selection](https://developers.openai.com/api/docs/guides/function-calling#tool-choice)
to restrict calls while retaining the original schemas for prompt caching.

Personal requests continue after staging a change so the worker can also retrieve
a requested list. Staging never commits the change; independent review still
precedes the transactional mutation and its authoritative receipt.

## Responsibility

Complete one assigned step using only its permitted tools and context, then return a structured handoff. The worker proposes calls; it does not hold database credentials, sign requests, mutate queue state or send WhatsApp messages.

## Worker profiles

| Profile        | Initial capabilities                                               | Boundary                                                                               |
| -------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| CRM read       | Filters, assigned lead search, detail and bounded related context  | Current employee visibility; personal requests remain assigned-only                    |
| Supply read    | Filters, search, detail and requirement assessment when authorized | Preserve units, missing fields and availability uncertainty                            |
| Knowledge read | Search/read approved knowledge                                     | Reauthorize documents and audience; internal knowledge is not automatically group-safe |

One implementation can execute all profiles with a restricted catalogue. Separate worker processes or providers are unnecessary. Profile selection cannot expand beyond employee permissions or the runtime's tool allowlist.

## Decision contract

Input includes run/step references, frozen contract, relevant prior evidence, available tool schemas and remaining limits. A model-directed worker emits exactly one validated next decision: `propose_tool`, `handoff`, `clarify` or `blocked`.

`propose_tool` contains an allowed name and candidate arguments. The executor validates and records the result, then the worker receives a bounded evidence projection. A handoff contains contract version, assertion claims, registered evidence IDs and unresolved requirements. This claim of completion still needs verification.

The deterministic first worker executes the assigned-follow-ups preset directly through the same executor. It returns the same receipt/handoff shape so later model behavior does not require a second persistence path.

## Context and execution rules

Start each step from its scoped bundle. Do not concatenate all previous model turns into every worker prompt. Include only evidence needed by the step, with source freshness and redactions preserved. CRM notes and tool text are untrusted data.

Use discovered filter values rather than inventing stage names, cities or field names. Treat pagination as explicit work within the shared budget. A bounded first page is not a complete count. Stop and ask when multiple accessible leads match an ambiguous name.

A denied tool ends that operation. Do not try another credential, generic database route or different employee. Empty results can be valid; source outage is not an empty result. Future effect tools require a different command profile and action-module policy.

## Recovery and acceptance

Each decision and receipt is associated with the current run epoch. On restart, recover completed operations before proposing another call. A repeated safe read can produce newer evidence, but must be recorded as a new attempt and cannot silently overwrite the source snapshot that a verifier previously used.

Acceptance cases cover forged evidence IDs, a false success handoff, repeated identical proposals, tool-schema mismatch, pagination exhaustion, missing warehouse units, denied candidate access and cancellation during a call. Confirm that the deterministic and model-directed workers both use the same authorization and evidence boundary.

Model-directed workers are enabled only after the preset read path passes restart and leakage tests. They remain read-only until the business-action milestone explicitly introduces effect capabilities.
