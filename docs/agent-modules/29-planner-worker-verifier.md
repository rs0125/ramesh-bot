# Separate planner, worker and verifier

Status: implemented locally; validation results are in the [dated record](../../evals/results/2026-10-02-sol-graph-media.md). This spec precedes the new graph code.

## Outcome

Ramesh acts as the employee's personal chief of staff. A greeting, personal plan or draft from supplied facts takes the direct path. Research uses explicit, independently prompted roles without adding permissions or requiring approval for allowed reads.

## Graph contract

`context → converser → [planner → worker ↔ executor] → formatter → verifier → finish`

The converser returns a structured route, objective and optional direct draft. It has recent conversation and current capability names. It does not invent records or treat protected history placeholders as facts. Requests referring to previous business results go through research/recall.

The planner receives the latest objective, 32-message history with private text withheld, current date/time, full advertised tool schemas, Context Engine guidance, trusted access status, recall availability and budgets. It returns an objective, observable success criteria and at most eight dependency-ordered steps. Steps describe missing information and candidate tools, not guessed arguments or invented identifiers. The application checks referenced tools and dependency order. Planning output is working data, never new authority.

The worker owns a native Responses tool session. It receives the validated plan and the same authoritative tool reference. It chooses arguments from actual results, adapts steps to evidence and returns a grounded draft. The deterministic executor validates schemas and identity, bounds retries, registers evidence and performs permitted calls. These roles have separate trace names and prompts.

Warehouse shortlists first establish a bounded current lead brief from detail/description, including when a prior CRM list already supplied city and area. Relevant notes can resolve operational needs or conflicts; they are not an obligatory full-history scan. User corrections, structured requirements and narrative claims retain their separate provenance. Discovery starts from reliable area/location and keeps unknown fields when the advertised schema supports `include_unknown=true`; a broad compliance request is not translated into exact fire/category filters. Candidate detail, including `recorded_context` and `recorded_source`, can support provisional ranking when parsing is incomplete. Structured shortlist checks supplement that evidence without disqualifying every unknown. The formatter and verifier preserve useful source text, material conflicts and one proportionate shared caveat. Public tools are optional for a specific external gap, using only public search terms.

The verifier sees request, plan, success criteria, answer, fresh evidence, recall, failures and presentation checks. It checks task completion as well as truth. It must accept honest partial answers when a source fails and must not demand unrelated research. CRM record cards require native Created/Last updated dates; warehouse cards do not. One repair is allowed, either formatting or worker continuation, without resetting the budget. If a direct route was mistaken, a tool-repair verdict can enter the planner and worker; the planner receives review feedback and the prior draft. The verifier sees the actual local recall definition alongside the permitted source tools. Formatting occurs before verification so the delivered text is the reviewed text.

## Limits and failure handling

Keep 24 source proposals, 28 combined source/recall steps, two review passes and the existing overall deadline. Malformed routing/planning is a failed run, never permission to execute unvalidated output. Identity, groups, revocation, receipts and delivery preflight remain deterministic. Separate modules are not independently privileged services. Encrypted provider reasoning remains ephemeral; only numeric token usage is retained.

## Validation

Test direct chat skips planner, planning gets real schemas/guidance, unknown tools/invalid dependencies fail closed, worker adapts to source failure, verifier sees acceptance criteria, revocation remains effective and no repair resets budgets. Run the complete generic multi-turn eval suite, the matched Sol screen, and private outcome cases through capture delivery. Keep prior failing reports and report the new graph's scores separately.

## Research and finalization deadlines

The orchestrator reserves the smaller of 60 seconds or one quarter of the total
request deadline for formatting and verification. A research call observes the
remaining research window as well as caller cancellation. When that window ends,
only successful evidence already retained is available to finalization; any
unfinished requested work must be stated. Verification, original permissions,
tool budgets and delivery revalidation still apply.

`AgentTrace.limitedBy = research_deadline` identifies budget-limited research.
Completed stages are observed as they finish, so a later timeout retains their
timings and usage. A hard deadline reports `DEADLINE_EXCEEDED`; other graph errors
report `RUN_FAILED`, without leaking upstream errors or business content.
