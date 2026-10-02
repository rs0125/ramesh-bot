# Shared contracts and ownership

Status: **General read projections are implemented. Durable model-response replay is deployed in `e0b7232`. Generic paused-task contracts remain proposed.**

**Implemented subset:** The current loop uses ToolSessionRequest, ModelToolCall, ContextToolRun, ToolEvidence and the versioned ToolDelivery receipt. The deployed recovery implementation adds `AgentCheckpointSession`: ordered exact-request response replay, original clocks/deadline, atomic consumption counters and bounded retry policy, all fenced by the trusted inbound lease. It does not implement every generic object below. Generic plans, task epochs, paused runs and write handoffs below remain proposed. See the [personal-assistant runbook](../sales-manager-agent.md) and [module 22](22-sales-manager-tool-loop.md) for the current contract. The richer role/task contracts below remain target design unless explicitly identified as implemented; their future enablement is separate from the deployed replay release.

## Purpose

Define the minimum information exchanged between modules without turning a model response into an authorization decision. Separate runtime-only authority from serializable task data and model-visible context. Modules may use narrower projections; they must not silently reinterpret the same field.

## Core objects

| Object               | Required information                                                                                                                             | Writer / consumer                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `InboundRef`         | Account, stored message ID, chat reference, original transport-key reference, input timestamp, audience                                          | Admission / identity and orchestrator                        |
| `ActorBinding`       | Binding ID, account/chat/audience, current employee ID when verified, trusted sender reference                                                   | Identity runtime / credentials, executor, delivery           |
| `RunRecord`          | Run ID, originating input, attached input references, actor binding, epoch, row version, status, contract version, thread ID, budgets and expiry | Orchestrator through repository / recovery and admin         |
| `TaskContract`       | Objective, mode, assertion IDs, policy version, resolved entities, requirements, requested output shape                                          | Preset or planner plus code validation / worker and verifier |
| `PlanStep`           | Stable step ID, dependencies, tool profile, assertions covered, required prior evidence and stopping condition                                   | Planner / orchestrator and worker                            |
| `ToolProposal`       | Step ID, allowed tool name, untrusted arguments and purpose                                                                                      | Worker / executor                                            |
| `ToolReceipt`        | Server-generated operation ID, run/step/epoch, validated tool/input fingerprint, outcome, timestamps and evidence reference                      | Executor / verifier and recovery                             |
| `EvidenceRecord`     | Source path, entity references, encrypted payload reference, retrieval/source times, coverage, redactions and verification flags                 | Adapter/executor / context, verifier and delivery            |
| `StepHandoff`        | Contract version, step ID, result, claimed assertion outcomes, registered evidence references and unresolved work                                | Worker / verifier and orchestrator                           |
| `VerificationResult` | Assertion results, evidence references, verdict and narrowly scoped correction or question                                                       | Code checks and verifier / orchestrator                      |
| `AnswerBundle`       | Outcome, permitted claims, evidence references, caveats, unresolved question and action receipts if applicable                                   | Verified runtime / formatter                                 |
| `PreparedDelivery`   | Final encrypted text reference, server-bound destination, source/effect references, run epoch, purpose, availability and expiry                  | Finalization / sender                                        |

`ActorBinding` is an application object. Models may receive a non-authoritative description of available capabilities, never a signer, bearer token, raw transport key or credential reference they can replace. `actorBindingId` in a record is a lookup reference, not a cached permission grant.

## Versions and identifiers

- `runId` identifies one objective. A clarification reply can attach a new inbound message to the same run.
- `epoch` increases when the user's objective changes, the run is superseded or cancellation invalidates pending work. Late results from older epochs cannot advance it.
- `version` supports compare-and-swap for repository mutations. It is distinct from `contractVersion`, which identifies the accepted success criteria.
- `operationId` identifies one logical tool operation. Read retry attempts have separate attempt IDs; future effects reuse one idempotency key across transport attempts.
- `evidenceRef` must resolve to an executor-created record belonging to the same authorized run. A model cannot establish evidence by inventing an ID.
- `responseKey` is derived by code from run, epoch, triggering inbound message and response purpose. Repeating finalization reuses the same outbound work.
- Schema and prompt versions accompany persisted data. Unsupported versions fail explicitly during recovery; they are not coerced into a new shape.

## Outcomes and lifecycle

| Run status                       | Meaning                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `created`                        | Input is durably associated with a run; no work has started            |
| `running`                        | One fenced owner is advancing the task                                 |
| `waiting_input`                  | A clarification was saved and the lease released                       |
| `waiting_confirmation`           | A future action proposal awaits a bound decision                       |
| `verifying`                      | The candidate result is being checked                                  |
| `ready_to_finalize`              | An authorized answer bundle has passed the final checks                |
| `finalized`                      | The response and completion outcome were committed to outbound storage |
| `cancelled`, `expired`, `failed` | Processing ended without normal completion                             |
| `reconciling`                    | A future effect has an uncertain outcome that must be resolved         |

`finalized` carries an outcome of `complete`, `partial`, `denied` or `unavailable`. A complete empty result is different from unavailable data. Worker `blocked` results are mapped to these states by the orchestrator; a worker does not directly finalize a run. Transport status remains separate: a finalized task is not proof of WhatsApp delivery.

Tool outcomes distinguish `succeeded`, `denied`, `invalid_arguments`, `unavailable`, `timeout`, `cancelled` and, for future effects, `uncertain`. Preserve safe upstream error codes such as existing `ContextEngineError` values. Denials must not be reclassified as transient failures.

## Assertion and evidence rules

A contract combines immutable application assertions with request-specific assertions. Required application assertions include trusted active actor, authorized tools and records, allowed audience, relevant freshness, bounded coverage and no fabricated effects. A planner can add criteria, not remove these requirements.

Each returned claim identifies whether it is a sourced field, a calculation over sourced fields, a user-provided assumption, or a recommendation with stated reasons. User text can supply requirements; it cannot establish a CRM record's current state. Record retrieval time and source refresh time separately. Unknown source freshness stays unknown.

Use structured values for dates, quantities, currencies and units. Formatting labels are derived from those values. Pagination reports `complete`, `bounded` or `unknown` coverage with its cursor/reference; the number of returned rows alone never establishes completeness.

## Boundaries and acceptance

Persist serializable records and concise decisions. Never persist plaintext private reasoning, credentials or executable callbacks in checkpoints. The native Responses protocol has one explicit exception: its opaque provider-encrypted reasoning continuation may be retained inside the authenticated, encrypted, run-bound response checkpoint alongside accepted output items and function-call IDs. It must not be decoded, logged, surfaced as tool/context data, or reused across runs. Sensitive payloads require encryption and actor-aware access even within the same Supabase project.

A replayed response is not authorization or a saved source-of-truth snapshot. Reconstruct the graph under current identity/tool scope and fresh source reads; reuse the response only for the matching request binding. Keep the original deadline and counters across retries. Production migrations `202610030004`/`202610030005` and independent capture `202610030005` are applied. Fresh installations require those migrations and their earlier prerequisites. See [persistence](13-supabase-persistence.md) and [the replay contract](47-durable-model-checkpoints.md).

Contract acceptance cases must demonstrate that unknown fields cannot smuggle actor/destination overrides, old epochs cannot finalize, forged evidence IDs are rejected, partial results remain partial, and business effects are never inferred from a worker's prose. Every module using these fields depends on this shared schema contract; the persistence spec owns storage details.
