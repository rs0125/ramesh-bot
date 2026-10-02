# Production evaluation for Ramesh

Researched: **2 October 2026**. This is a review and proposed operating contract,
not a claim that production monitoring or deployment gates have been installed.
The [retained results](../../evals/results/2026-10-02-eval-refinement.md) distinguish
agent runs, judge-only regrades, infrastructure tests and private live checks.

## Recommendation

Keep the repository-owned harness and measure the whole assistant: admission,
identity, context, planning, tool execution, verification, formatting and captured
delivery. A useful answer, correct permissions, durable execution and acceptable
latency are separate requirements. One aggregate LLM score cannot establish all
four. Preserve exact failures and explain changes to the measurement method.

For example, success on “summarize these forwarded notes and tell me what to do”
means retaining the order, distinguishing confirmed facts from requests, preserving
numbers and negations, answering the request once, and sending nothing outside
the intended conversation. It does not require one particular tool sequence.

## What the primary sources support

- Anthropic separates tasks, repeated trials, traces and actual outcomes. It
  recommends combining code, model and human graders, inspecting failures and
  avoiding rigid tool-path expectations when several solutions are valid.
  `pass@k` measures at least one successful attempt; `pass^k` measures success on
  every attempt. Consistency matters for a WhatsApp assistant whose user normally
  receives one answer. [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
- OpenAI recommends task-specific cases, explicit criteria, human calibration and
  continuous evaluation. Its guide calls out judge position and verbosity bias;
  pairwise comparisons and bounded pass/fail questions are useful grading forms.
  The same page now marks the hosted Evals platform for deprecation. We can apply
  the methodology without migrating this runner into that product.
  [Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
- OpenAI's trace-grading guidance explains why end-to-end scores need execution
  traces: intermediate decisions and tool results help locate the cause of a
  failure. For Ramesh, use recorded stage inputs/outputs and evidence, without
  requiring private model reasoning.
  [Trace grading](https://developers.openai.com/api/docs/guides/trace-grading).
- LangSmith distinguishes offline datasets with reference outcomes from online
  runs without known answers. It describes feeding production findings back into
  offline cases, versioning datasets and separating development/test subsets.
  Those practices also work in our existing TypeScript runner; adopting LangSmith
  is optional. [Evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts).

The rest of this document applies those principles to the inspected Ramesh
implementation. Priorities, case examples and release rules below are our proposed
engineering decisions, not vendor-prescribed thresholds.

## Current coverage and remaining work

| Area                | Present in this checkout                                                                                            | Remaining production work                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Behavioral outcomes | 74 fictional multi-turn scenarios; repeated real-model calls; every trial retained                                  | Separate an untouched release set from cases used while tuning prompts                       |
| Infrastructure      | PostgreSQL queue, identity, authorization, replay, media and debounce tests                                         | Exercise deployment recovery and provider outages on a staging topology                      |
| Semantic grading    | Separate judge call; criterion findings; 28 positive/negative calibration examples, repeated twice                  | Employee-labelled calibration and measured false-pass/false-fail rates                       |
| Temporal fairness   | Each turn's judge receives prior dialogue and current evidence, never future turns or shared future-bearing rubrics | Human audit of current-turn rubrics and judge disagreements                                  |
| Reproducibility     | Prompt, dataset and source hashes; fixed synthetic clock; mutation invalidates runs                                 | Pin usable model versions and record provider drift; maintain a reviewed baseline            |
| Real business data  | Private Supabase/Context Engine outcomes, fixed employee and capture-only delivery                                  | Broader identities, changing permissions and a private holdout with source timestamps        |
| Media               | API and browser checks for three forwarded notes, exact STT quoting, ordered batch answer; expiry tests             | Representative human Hindi/Hinglish audio and document-quality cases                         |
| CI                  | Manual/opt-in weekly full run, calibration before agent trials, retained artifacts                                  | Required pre-release quality decision; current workflow does not block each PR or deployment |
| Operations          | Local stage traces and run metadata                                                                                 | Sampled production quality review, alert ownership and rollback criteria                     |

Passing all authored judge examples is not proof of judge reliability. In this
refinement, a 52/52 calibration coexisted with overrejection of legitimate
conversation answers. We replaced whole-conversation judging with isolated
current-turn calls after finding future-request leakage. We also found that legacy case descriptions could leak future corrections or
expected verdicts, including in calibration. The current judge withholds those
descriptions and expected labels, using the request, evidence and shared rubric.
Original reports remain unchanged, and regrades are labelled as measurement
changes rather than improved agent performance.

## Define success before choosing tools

Each new case should declare the user goal, trusted employee/audience, initial
environment, authoritative facts and allowable effects. Include must-have outcomes,
prohibited outcomes and material uncertainty. Keep these expectations out of the
agent's inputs. An exact exemplar answer is optional; an outcome contract is not.

| User outcome                                    | Positive evidence                                                                        | Failure that must remain visible                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| “Which of these leads needs me first?”          | Priorities grounded in current assigned records, native dates and deadlines              | Prioritization invented from names or record order                                  |
| “Find five suitable options for the second one” | Correct prior entity, requirement-aware comparison, listing references and explicit gaps | Fresh intake despite adequate context; five unsuitable listings just to hit a count |
| “Why did traffic change?”                       | Correct source periods, metric definitions and limited causal claims                     | Search clicks treated as GA4 sessions, or invented CRM attribution                  |
| “Help me get through this afternoon”            | Feasible order that respects fixed commitments; useful initial help                      | A long questionnaire or a schedule that crosses the user's hard cutoff              |
| Forwarded audio followed by “summarize”         | All voices in order, exact quotes and one common response                                | Lost correction, reversed negation, premature separate replies                      |
| Future “move the follow-up to Monday”           | Authorized, exact intended record/date, durable single effect and verified state         | Saying “done” without a committed effect or duplicating it after a timeout          |

Check scope, schemas, destination, record identity, date semantics and forbidden
effects deterministically. Allow equivalent authorized retrieval routes. Use
semantic judgment for whether the synthesis is useful and faithful. Keep partial
diagnostic scores, but a serious authorization failure cannot be offset by fluent
wording or other passing criteria.

## Data and judge discipline

Maintain three separate sets: public development regressions, a private release
holdout and recent production incidents awaiting review. Split by original task
and conversation lineage, not by individual turns. Paraphrasing a development
case does not make it independent. Record when a holdout case is inspected for
tuning and move it into the development set afterwards.

For live Supabase cases, record the retrieval time and authorized reference facts
privately. Check assertions against those facts instead of hard-coding a changing
lead count. Keep public cases fictional. Do not upload private transcripts,
contacts, media or credentials as CI artifacts. Raw media remains subject to the
24-hour Ramesh retention contract; a screenshot or eval log must not become an
untracked permanent media archive.

Have domain reviewers label both good and bad answers before tuning the judge.
Measure false passes on unsafe/unsupported answers separately from false failures
on valid alternatives. Review all serious failures and a random sample of passes.
Disagreements need an adjudicated label, not an automatic second judge vote.
Separate criteria for factual support, task completion, continuity and readability.

For Sol/Terra or prompt comparisons, use the same cases, environment, budgets and
judge version. Blind the candidate names and randomize answer order for pairwise
review. Keep ties. Compare cost and latency alongside usefulness. A separate API
call does not eliminate same-provider model bias; include human review of the
comparison sample before selecting a production model.

The runtime verifier can repair an answer before delivery. The eval judge grades
the delivered answer and recorded effects. A verifier's approval is evidence about
its behavior, not a ground-truth label for the evaluator.

## Repetition and reporting

Use a small protected smoke selection for routine changes and the complete suite
for releases and scheduled regression checks. Two trials are a cost-conscious
screen, not a statistical reliability guarantee. Increase trials for affected or
high-impact slices before deciding a release is better.

Report per-trial success, cases that pass every trial, serious failures, unresolved
judge disagreements, cancellations, timeouts and invalid runs. Show category
results so strong chat performance cannot hide weak business reads. Do not replace
failed trials with reruns or summarize only the best attempt. Preserve source and
grader versions when regrading saved answers.

For a future comparative report, bootstrap at the scenario/conversation level,
retaining correlated turns together. Report the interval and sample size with the
point estimate. Do not interpret 148 trials across 74 cases as 148 independent
production users. Freeze acceptance rules before running the candidate.

## Failure and side-effect coverage

Prioritize these staging cases alongside conversational quality:

- Role revocation between retrieval and delivery; unknown/ambiguous identity;
  forged phone assertions; group messages claiming DM authority.
- Rate limits, expired signatures, unavailable tools, malformed tool results and
  stale evidence. Verify useful qualified output only when evidence allows it.
- Duplicate inbound events, overlapping consumers, lease expiry, restart after
  result persistence and an uncertain outbound send. Assert actual delivery count.
- Out-of-order media completion, a forwarded burst followed by instructions,
  duplicate attachments, a failed transcription and media expiring before retry.
- Prompt injection in CRM notes, documents and transcripts. Data cannot expand
  authority, select a delivery recipient or become a developer instruction.
- For future writes: isolated stateful fixtures or a disposable database, explicit
  pre/postconditions, idempotency keys and ambiguous-timeout reconciliation.
  An outbound capture queue alone does not neutralize a tool that writes to the
  real CRM. Production write credentials must stay outside these tests.

No write tools are enabled by this review. New document tools should bring cases
for page citations, incomplete extraction, owner isolation and contradictory
content without encoding a preferred business-specific tool path.

## Media evaluation

Separate recognition quality from assistant quality. First compare transcription
against human-labelled audio: names, area/budget units, numbers, dates, negation
and corrections matter especially. Then feed fixed transcripts to the agent to
test comprehension. Finally test the complete audio-to-delivery path.

The [current STT comparison](../../evals/results/2026-10-02-stt-comparison.md) uses
synthetic Opus audio. All three models preserved the English checks; the generated
Hindi/mixed audio did not produce dependable recognition. That is a limitation of
this benchmark, not evidence about accuracy on real employees' speech. Use a
consented representative private sample before changing the model on that basis.

## Proposed release and production loop

1. Run deterministic checks and judge calibration. An infrastructure failure or
   invalid source hash makes the evaluation inconclusive, not successful.
2. Run the affected smoke cases and full release suite on a frozen revision. Review
   serious failures and judge disagreements. Keep the previous approved baseline.
3. Run the private holdout with the real Context Engine and captured delivery.
   Check freshness and authority again at delivery. Do not instantiate Baileys.
4. Deploy a read-only shadow or limited employee pilot only through the normal
   authorized rollout process. Shadow mode must capture effects at every tool
   boundary as well as at outbound delivery.
5. Sample production conversations for review and collect corrections. Turn
   adjudicated failures into fictional regressions or restricted private cases.
   Roll back on a confirmed cross-user disclosure, unauthorized effect or sustained
   delivery failure. Choose numerical quality/latency thresholds from an observed
   baseline rather than inventing a universal pass percentage.

Instrument queue wait, debounce collection, media extraction, model stages, tools,
delivery preflight and transport separately. Track p50/p95 end-to-end latency,
failure/timeout/retry rates and cost per completed user task. Measure repeat-user
corrections and task completion; short answers and few tool calls alone are not
success. Keep alerts content-free by default, with restricted, expiring evidence
for incident review.

The immediate next production investments are a human-labelled holdout, a required
release decision using the retained reports, and a small review/monitoring loop.
They address gaps that adding more synthetic prompts alone will not close.
