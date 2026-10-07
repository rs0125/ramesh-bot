# Verifier

Status: **Code source checks and independent model answer review implemented.**

This release's follow-up revision: verdicts include a fixed diagnostic reason, and stage traces retain only approval, repair category, reason and presentation-issue count. Rejected prose and reviewer feedback remain excluded from logs. Current-task instructions distinguish contextual explanations from a preceding shortlist request and permit useful supported partial answers with specific limitations. The fallback no longer instructs users to narrow an otherwise valid question. See [follow-up recovery](../followup-recovery.md), including its limits and deterministic validation.

**Implemented subset:** tool-evidence.ts validates source path/query, response/source clocks, explicit scope, page counts, totals and consistency metadata. sales.graph.ts reviews the formatted answer against current registered evidence in a fresh model context. The two-review allowance routes wording/layout repairs to the formatter, source-backed factual corrections to a tool-free evidence repair, and missing reads or corrected staged operations back to the tool loop while research remains available. A second failed review returns a limitation. Model review cannot override code authorization and is probabilistic. See the [personal-assistant runbook](../sales-manager-agent.md) and [module 22](22-sales-manager-tool-loop.md) for the current contract. Production enablement remains separate. The richer role/task contracts below remain target design unless explicitly identified as implemented.

Current v44 review enforces material correctness without treating optional enrichment
as a prerequisite. A normal CRM create uses the supplied facts and advertised required
fields; absent optional budget/contact details, preferred wording or native dates for
an uncreated record do not block it. Suggestion-only verdicts may approve a supported
operation without editing its exact proposal. Incorrect targets/values, missing
required input, authorization and unsupported success claims still block dispatch.
Factual and presentation diagnostics are separate. One evidence repair and no-progress
detection bound correction work under the original deadline; they do not raise the
two-review limit or give the repair stage tool authority. See [the current implementation](55-latency-and-model-routing.md#answer-rendering-and-review-cleanup-v44).

## Responsibility

Determine whether the result satisfies the contract and whether its claims are supported. Verification has two layers: application checks establish operational facts; a separate model context assesses nuanced completeness and interpretation. Model agreement cannot override a failed application check.

## Input and output

Input consists of the current run epoch, frozen contract, user objective, worker handoff, registered receipts and candidate answer claims. Do not pass the worker's private reasoning history. A model reviewer may receive a bounded authorized evidence projection, not raw credentials or unrestricted source access.

`VerificationResult` returns `pass`, `repair`, `needs_input` or `blocked`, with per-assertion status, supporting evidence IDs, unresolved issues and an optional narrowly scoped next task. Code validates the verdict against mandatory checks before the orchestrator accepts it.

## Deterministic checks

| Check              | Required evidence                                                                      |
| ------------------ | -------------------------------------------------------------------------------------- |
| Actor and audience | Current identity binding; business output remains in the permitted DM                  |
| Tool authority     | Allowed operation and successful authorization, not only a read-only annotation        |
| Record selection   | Exact requested entity or explicit disambiguation; personal views use assignment       |
| Date and units     | Server-resolved date boundary, normalized quantity/currency units and matching filters |
| Freshness          | Relevant source clock/health, not merely response-generation time                      |
| Coverage           | Explicit cursor and coverage status; bounded rows are not a total                      |
| Claims             | Every sourced field/calculation resolves to registered evidence                        |
| Effects, later     | Committed schedule or authoritative command receipt, not worker prose                  |

For the first assigned-follow-ups preset, verify the requested filter contract and returned evidence shape. A successful empty response can produce “No assigned follow-ups found for today” only when source health and the scoped search succeeded. Incomplete coverage requires bounded wording and a way to request the next page.

## Semantic review

Use the model reviewer for lead-to-supply comparisons, multi-source summaries and answers requiring interpretation. Ask it to check omitted requirements, unsupported inferences, contradictions and whether uncertainty is visible. It may recommend additional evidence; the orchestrator must authorize any recheck through the executor.

A reviewer cannot waive identity checks, erase an inconvenient requirement or declare an external write completed. Its output is untrusted structured data subject to schema and evidence-ID validation. A second provider is optional and must earn its complexity through evals.

## Correction and formatting boundary

`repair` names the failed assertions and the evidence needed to fix them. The orchestrator permits at most the shared repair budget, initially a proposed two passes for complex reads. A lack of available evidence ends in an honest partial result, not repeated attempts to obtain a passing judge score.

Task verification precedes formatting. The formatter's output still needs claim-preservation checks. Deterministic templates can preserve immutable fields for simple reads; a free-form rewrite that adds substantive claims must undergo renewed evidence review. String matching alone cannot prove arbitrary semantic equivalence.

## Acceptance cases

Test forged receipts, valid transport with invalid data, stale source clocks, missing pagination, wrong assignment, wrong date zone, empty-versus-unavailable confusion, missing availability caveats, invented action success and a malicious worker instructing the verifier to pass. Verify a model `pass` cannot bypass a deterministic denial.

Compare review against held-out expected outcomes and human judgments. Measure false passes, unnecessary repair, latency and cost separately. The first preset can ship with code checks once its end-to-end invariants pass; it does not require a general model judge in the critical path.
