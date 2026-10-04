# Planner

Status: **Separate planner model node implemented locally.** Ordinary chat bypasses planning. Depends on [contracts](00-shared-contracts.md), [tool catalogue](09-context-engine-adapter.md), [worker](07-worker.md) and [orchestrator](12-langgraph-orchestrator.md).

## Current planning implementation

The graph has distinct converser, planner, worker, executor, formatter and verifier nodes. The planner returns a validated `TaskPlan` containing the objective, observable success criteria and at most eight dependency-ordered steps. The current implementation is specified in [module 29](29-planner-worker-verifier.md); the richer durable contract below remains a future target.

The current planning role receives:

- The latest objective, relevant audience-safe conversation history and trusted request clock.
- All permitted live function definitions, including schemas and descriptions, plus bounded Context Engine instructions for source semantics.
- An application-owned `planning_context` derived from the actual employee catalogue and audience: available source families, tool names, remaining source-proposal budget and whether protected selection recall exists. The source map never grants a missing capability.
- The editable [planning reference](../../src/prompts/planning-reference.md), which explains source responsibilities, retrieval dependencies, completion criteria and valid recovery paths.
- The worker, rather than the planner, receives successful tool evidence and structured failures through native Responses continuation. Prior private selections enter only through freshly authorized recall; source notes remain data rather than instructions.

Company context is retrieved when the objective needs it: employee/source context, relevant knowledge pages, then scoped records and dependent reads. Do not load a stale CRM/wiki dump into the planning prompt or require company research for ordinary personal help. Current capabilities are reads; a plan cannot manufacture a scheduler, sender, HRMS endpoint or write tool.

The implemented planner receives full live schemas. Code rejects unadvertised tools, duplicate step IDs and forward/cyclic dependencies. It cannot choose the employee identity.

## Responsibility

Turn a supported objective into a bounded dependency plan and request-specific success assertions. Code supplies mandatory access, audience, freshness and effect rules. The planner cannot remove those rules, invent tools, select another employee or widen the rollout scope.

## Interface

Input includes the extracted objective, explicit constraints, resolved references, currently allowed tool descriptions, policy version and remaining budget. Output is either a `TaskContract` plus `PlanStep[]`, a question identifying missing input, or a supported limitation.

Each step has a stable ID, tool profile, dependencies, assertion IDs, required evidence and stopping condition. Plans are acyclic, have no unreferenced dependencies and cover every required request assertion. Server validation rejects unsupported tools, arbitrary code/URLs, conflicting modes and excessive step counts.

The initial candidate limit is six steps for a complex read. This is a tuning proposal, not a current setting. The executor owns actual call counts; splitting work into more steps cannot reset its budget.

## Presets versus planning

`assigned_followups_today` uses a code-owned contract: active authorized employee, DM, assigned-only filter, explicit current-day semantics, bounded coverage and honest source limitations. The planner is unnecessary for this request.

For a lead-to-supply request, resolve the lead and obtain its bounded current detail/description before searching supply, even when city and area are already known. Reuse current evidence and read relevant notes only for a concrete operational gap or conflict. Search on reliable area/location with unknown fields retained where supported, inspect candidates' recorded context/source values, and supplement the comparison with the advertised shortlist assessment. Missing or unparsed data can remain a specific check on a provisional option; an assessment is not a complete suitability gate. Public research is optional for a material external gap. The executor owns call budgets and concurrency.

The plan stores operational decisions, not private reasoning. User-visible progress can name useful steps without showing raw tool arguments or system instructions.

## Contract revision and repair

Save the validated contract before worker execution. A worker cannot rewrite it. A verifier's failed assertion generates a focused corrective step with an evidence requirement and remaining budget. Do not regenerate the entire plan automatically on every failed check.

When new user input changes the objective, increment the run epoch and contract version, invalidate obsolete outputs and record a concise reason. Missing facts should stay unknown unless retrieved or supplied by the user. The planner must not weaken an assertion merely to produce a successful verdict.

Planning for future writes may describe a proposal, but the action module owns confirmation, preconditions and execution. Planning for a reminder ends with a schedule command; waiting until its due time is not a model step.

## Acceptance cases and release gate

Test valid dependency order, unknown tools, cycles, uncovered assertions, duplicate step IDs, forbidden write requests, forged actor/destination fields and excessive plans. Evaluate incomplete lead requirements, no matching supply, stale source data and a useful partial result under budget exhaustion.

Compare planned and preset/direct paths on the same held-out scenarios. Enable planning for request classes where supported completion improves sufficiently to justify measured latency and cost. Its first release depends on a working executor, durable state and verifier; it is not part of the initial assigned-follow-ups lookup.
