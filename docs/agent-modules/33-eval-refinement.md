# Evaluation refinement and bounded completion

## Turn-scoped expectation follow-up

The first isolated-turn regrade still rejected a correct showroom comparison
because the journey description mentioned the later switch to a distribution hub.
Hiding future messages is insufficient when a shared rubric reveals the future.
Withhold legacy case descriptions from every judge request, including one-turn
calibration cases: some descriptions reveal the expected answer verdict. Grade the current request, prior dialogue, current authority,
schemas and evidence against the shared criteria. Keep journey expectations in
the authored case for human review and deterministic outcome contracts.

The judge helper may also accept an explicit array of per-turn expectations;
validate its length and reveal only the current entry. Explicit rubrics must
state verdict-free success criteria. Legacy string descriptions stay available
for human review but are never model inputs. Add positive and negative correction
calibration cases and verify that future-rubric sentinels cannot appear in earlier
requests. Record this as another judge version, without replacing earlier runs.

## Scope and evidence

Refine the retained Sol graph evaluation without changing employee authorization,
read-only tool permissions, evidence validation, or capture-only test delivery.
The baseline full run is v13, 132/148; v16 has focused results only. Keep every
original report unchanged. A corrected fixture or grader creates a new dataset
or judge version, never a retroactive pass.

The retained failures identify:

- Grading without tool argument descriptions incorrectly rejects the documented
  case-insensitive Search Console filter.
- Whole-conversation booleans obscure which turn failed; a good final answer can
  hide an earlier refusal. Require a verdict for every delivered turn.
- UTC retrieval timestamps were mistaken for IST. Supply mechanically converted
  clock context and calibrate the judge with positive and negative examples.
- The missing-native-date scenario clears search dates but leaves detail dates
  populated. Apply the scenario consistently to both reads.
- A last-call assertion penalizes an otherwise correct assigned-follow-up result.
  Check the required query and prohibit unintended scope expansion explicitly.
- Date-query equivalence can accept a literal period with the wrong CRM date
  field. Compare resolved bounds and date-field meaning before literal equality.
- Personal planning can ignore an offline cutoff or leave remaining work
  unscheduled. Preserve fixed commitments, full work duration and explicit
  conditional blocks when an appointment's end time is unknown.
- Notes without timestamps must not be described as demonstrably latest. Short
  action lists should use known requirements and ask only about material gaps.
- A live cross-domain request reached the hard deadline after useful reads, lost
  those results, and reported no stage timings. Reserve a finalization window and
  retain completed stage metrics even when the run fails.

## Evaluation contract

The external judge returns indexed per-turn continuity, grounding, formatting and
usefulness verdicts. Each failed criterion has a concrete finding identifying the
answer claim or omission and the source/constraint it violates. Validate that
every turn appears exactly once, findings agree with failed criteria, and aggregate
the result in code. No judge can override deterministic safety gates.

Capture each turn's actual access status and complete advertised schemas directly
at context admission, including direct routes. Never reuse an earlier turn's
catalogue. Supply trusted application identity separately from quoted records.
Use a fixed synthetic clock for reproducible relative dates and scheduling;
production still uses the actual clock. Analytics query checks resolve dates on
the source calendar. Private live tests continue using real time and real data.

Add a separate paid judge-calibration runner with small, generic contrastive cases:
correct/wrong time conversion, native/mirror dates, verification versus redundant
intake, source unknown versus negative claim, unsafe policy/injection, and a bad
first turn followed by a good final turn. Calibration expects outcomes, not prose
or a particular model's preferred style. Calibration failures remain failures.

Query assertions test source semantics, not incidental call ordering. Scope checks
must still reject accessible/company-wide queries where the request remains
assigned-only. Successful native detail enrichment is valid when genuinely
returned; the missing-date fixture must not accidentally supply it.

## Runtime changes

Reserve up to 60 seconds, at most one quarter of the existing hard deadline, for
formatting and verification. Stop starting research after its earlier deadline;
abort an in-flight research call at that boundary. Pass only successfully retained
evidence to finalization with a clear research-limit signal. Never emit an
unverified partial answer, reset tool budgets, or bypass delivery revalidation.
The hard deadline and caller cancellation remain authoritative.

Record each completed graph stage as it finishes. Preserve these metrics on a
timeout/error without logging source contents or hidden model reasoning. Make
partial completion visible in trace metadata so evaluation cannot confuse a
budget-limited answer with a fully completed task.

Use shared prompt rules for scheduling, evidence limitations and short follow-up
answers, rather than contradictory stage-specific requirements. Keep all prompts
editable Markdown. Do not relax freshness validation merely to hide failures.

## Validation and rollout

1. Unit-test query semantics, fixture consistency, judge verdict validation,
   source clock conversion, research cutoff, cancellation and surviving trace
   metrics. Include negative examples for every relaxed assertion.
2. Run judge calibration and focused real-API regression scenarios.
3. Freeze final code, prompts, fixtures and judge; run every public scenario twice.
   Persist hashes, all trials, failures, usage, latency and JUnit results.
4. Run the private outcome suite against actual Supabase and Context Engine with
   the configured Raghav identity, capture queues only. Never publish private
   inputs, reference snapshots or traces.
5. Run required repository checks using disposable local PostgreSQL. Update the
   results documentation and refresh the local GUI. No production deployment is
   part of this refinement.

This follows the [official OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices):
evaluate representative outcomes and traces, calibrate automated judgments, and
retain repeatable regression runs. The concrete fixes above come from this
repository's retained evidence.

## Temporal grading and separate re-evaluation

A retained v18 trial exposed a grader applying a later user's attribution question
to an earlier request for two totals. Grade each reply against the current turn
and the preceding conversation. A conversation-wide expectation must be satisfied
at the appropriate turn, not repeated before the user asks. Add contrastive cases
where the later answer supplies the limitation correctly or fails to supply it.

When only a grader changes, a separate offline re-evaluation may apply the new
rubric to a complete frozen public run. It must retain every saved agent answer,
use fresh independent grading calls, and write a new report with the source run ID,
source report hash, original model/code/prompt hashes and new grader provenance.
Never overwrite the raw source run, reroll failed answers, select only favourable
trials, or describe a regrade as a new agent execution. Incomplete and private runs
are ineligible for the public/CI regrade command. Deterministic check failures
remain failures. Calibration must pass before using the new grader for a gate.

## Causal turn grading

Whole-conversation judge calls still leaked later requirements into earlier verdicts despite calibration. Evaluate one delivered turn per judge request, with only preceding user/assistant history and that turn's current evidence, schema and authorization. Future turns must not be sent. Withhold journey-wide descriptions too, following the turn-scoped expectation contract above; the explicit current request governs which outcome is due now. Reindex the single-turn verdict in code and aggregate all criteria without discarding failures. Retain model usage across each judge call and stop on caller cancellation. Unit tests assert future-turn and future-rubric exclusion and preservation of an earlier failing answer. A new judge-only report over every retained answer measures this methodological change; it is never a new agent execution.

## Public judge model selection

The blind 28-case calibration was run twice with the same rubric and evidence.
Terra agreed on 54/56 trials; Sol agreed on 56/56. Use Sol as the default public
conversation/calibration/regrade judge while retaining an explicit model override.
This does not imply independent model-family judgment when the assistant also uses
Sol. Keep both calibration reports and compare the same retained answers under
each judge; do not convert a model change into an alleged agent improvement.
Historical controlled-comparison and private reports retain their original judge.
