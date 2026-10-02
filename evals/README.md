# Ramesh conversation evaluation

The current harness exercises Ramesh as a personal chief of staff with all employee-permitted tools. It runs the real OpenAI model through the same graph used by the live playground. All tool facts are fictional, and no WhatsApp transport or production database is constructed.

## Run it

Routine text-agent and grader checks default to `gpt-6-luna`, one trial, one concurrent case and a three-trial allowance. Production `OPENAI_MODEL` cannot select the evaluation model; use `EVAL_MODEL` or `--model` explicitly. Supply the existing key through the ignored `.env` or CI secret, never in a command.

```sh
# List cases without an API key or paid request.
npm run eval:conversations -- --suite all --list

# A small Luna agent + Luna grader screen: three cases, one trial each.
npm run eval:ci -- --case changed-history,source-label-crm-name,source-label-knowledge-title

# One focused conversation, two independent trials.
npm run eval:conversations -- --case ordinal-reference --trials 2
```

All paid runners reject plans exceeding `--max-trials` (default 3). This counts scenario executions, not HTTP calls or dollars. An intentional larger run needs an explicit allowance. Never launch the full 85-case suite by habit. Scope cases to the change and reuse retained traces for offline inspection.

**Get the user's approval before any Sol agent or grader call**, including private live-source tests and comparison runs. State the models, cases, repetitions and expected spend/limits first. After approval, `--sol-approval <reference>` records it; the flag itself is not permission. Production and the interactive playground keep their configured models. STT uses its dedicated audio models, also with a bounded trial allowance.

`--suite all|conversation|journeys|adversarial|pagination|recovery`, `--case`, `--trials 1..5`, `--concurrency 1..4`, `--model`, `--judge-model`, `--max-trials`, `--sol-approval` and `--output` are supported by the conversation runner. Every completed trial is retained. An interrupted run is incomplete, even if every completed row passed; do not rerun it merely to obtain a green summary. Limits remain 240 seconds per graph and 6000 output tokens per response. Failed/in-flight requests can have unreported billed usage.

Luna checks are low-cost screening, not evidence of identical Sol behavior. No Luna quality calibration has been performed for this change. The previous Sol calibration scores remain historical. [Spending policy](../docs/agent-modules/42-evaluation-spend-controls.md).

## Coverage

| Area                        | Scenarios | What is exercised                                                                                                                                                                                                                                       |
| --------------------------- | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversational recall       |         8 | Reported RFQ-to-five-options failure, ordinal references, native dates, 32-message window, intervening chat, changed/revoked data, corrected use and owner questions                                                                                    |
| Analytics                   |        16 | GA4 and GSC comparisons, source calendars, metric units, filters, form signals, zero baselines, privacy/coverage, provisional data, partial failures, recovery and source injection                                                                     |
| Personal assistance         |         9 | Planning, changed constraints, drafting, overwhelm, casual updates, identity honesty, Hinglish, topic switches, unavailable reminders and media                                                                                                         |
| CRM                         |         8 | Today-to-all, month windows, totals versus pages, workday priorities, call prep, source failures, empty searches and note injection                                                                                                                     |
| Supply                      |         5 | Provisional options, grounded comparisons, changed use, inventory totals and owner drafts                                                                                                                                                               |
| Knowledge and combined work |         4 | Read-to-agenda, property preparation, source injection and cross-domain work briefs                                                                                                                                                                     |
| Access/action boundaries    |         4 | Unknown users, groups, absent analytics permission, unsupported writes and sends                                                                                                                                                                        |
| Adversarial journeys        |        20 | Source injection and role spoofing, requested versus reported facts, retry recovery, configuration failures, old dates, native-date substitution, cohort/causal pressure, policy laundering, personal planning, unknown warehouse fields and shortening |
| Paginated research          |         6 | Bounded pool membership, late-page candidates, overlapping rows, empty continuation pages, interrupted sources and cursor cycles                                                                                                                        |
| Recall recovery and labels  |         5 | Changed dates, genuine continuation, partial-source refresh, instruction-like CRM names and knowledge titles                                                                                                                                            |

The personal-assistance row contains nine scenarios; reminder and media limitations are separate cases within that total. The scenario registry is the source of truth; `--list` prints all IDs. Tests assert unique IDs, domain coverage and valid turn references.

`tests/fixtures/context-tool-catalogue.json` and `context-guidance.md` are public tool schema/instruction snapshots from the actual Context Engine, without employee records or credentials. `sales-fixture.ts` supplies stable fictional CRM/property data and realistic paging/date filters for the covered queries. Search queries do not rewrite record stages to manufacture matches. Summary counts agree with the fictional inventory; detail reads preserve searched fields. `analytics-fixture.ts` preserves real response semantics while using invented aggregate metrics and example.test labels. These are contract fixtures, not a full database/query emulator.

Actual company knowledge and a small authorized sample of deals/listings informed the scenarios: native dates versus activity, follow-up/stage interpretation, operational requirements, owner checks and unknown commercial units. No copied customer identity, roster number, company note or property record is committed. Scenario-specific mutations test stale/changed facts and source injection.

## Checks and reports

Every turn records the user request, trusted clock, proposed calls, returned tool results (including failures/reuse), actual source attempts, successful evidence, executed local recall/output, graph stages, reply, runtime review, token counts and duration. Per-turn trace gates can require or forbid calls and bound actual/proposed call counts separately. Hard checks enforce tool/query contracts, no forbidden reads, no deal UUIDs, chat formatting and known case requirements. A fresh structured model judge reviews continuity, grounding, formatting and usefulness for each delivered turn using preceding conversation and current successful evidence. Source reads and application-owned recall are distinct trace fields; absence from the source-read list alone does not mean recall was skipped.

The judge is probabilistic and uses the same provider/model family. It is not proof of safety or equivalence to Claude. Deterministic authorization, source validation, audience isolation and delivery checks remain separate. A capability-only get_context call is allowed when testing missing analytics permissions, but ordinary personal drafting/planning should not read company data. The judge receives the same trusted calendar context used for personal dates; Google reporting calendars still come from evidence.

Each run writes:

- `run-metadata.json` before the first paid trial: model, limits, scenario IDs, prompt manifest, judge hash, dataset hash and a file-by-file code/input manifest.
- `trials.ndjson` after each trial, including failures and drafts/reviews, so an interrupted run retains finished work.
- `report.json`, `junit.xml` and `summary.md` when complete, with per-case pass rates and failure reasons.

The start-time snapshot prevents a long-running experiment from being mislabeled by edits made while it runs. Reports live under `.local/ci-evals/<run>/` for `eval:ci` and `.local/conversation-evals/<run>/` otherwise. Earlier baseline reports produced before this metadata improvement are preserved with their original format.

## CI

`.github/workflows/ci.yml` runs deterministic checks with disposable PostgreSQL and no model secret. Paid `.github/workflows/agent-evals.yml` is **manual only on main**. The dispatcher selects case IDs, repetitions, total trial allowance and model; both agent and grader default to Luna. Sol requires the explicit approval reference. Automatic weekly execution and automatic grader calibration were removed. No paid workflow runs on untrusted PR code. Configure the `agent-evals` environment's key only for intentional approved use.

The paid job publishes the Markdown summary and uploads only `.local/ci-evals` for 14 days. These artifacts contain fictional transcripts, not real-data smoke results. The workflow is authored locally; configuring the remote environment/secret and executing it on GitHub remain deployment tasks. `npm run eval:ci` has been executed locally with the real API key.

## Real-source smoke

Use `PLAYGROUND_ENV_FILE=.local/live-playground-analytics.env npm run dev:chat:live` for the currently provisioned local full-catalogue profile. The actual local Context Engine must also be running. The real-source smoke command requires explicit model/run approval when that profile uses Sol and an allowance for its five test turns; do not run it automatically. This connects actual Supabase and Context Engine, pins the authorized employee in server configuration and uses `ramesh-test-inbound-queue` / `ramesh-test-outbound-queue`. It never creates Baileys. Keep raw source/transcript artifacts private under `.local`, and report only outcomes, timings and relevant limitations outside that directory. See the [live setup](../docs/live-data-playground.md) for the older deployed-endpoint profile and provisioning steps.

The current local analytics profile uses the actual Context Engine running locally against real Supabase and Google sources, because the production public key registration still needs its analytics scope rollout. Live reads proved that the signed route can expose all seventeen tools to the authorized admin. That is not a claim that every employee has admin access or that production was updated.

## Tuning record, 2 October 2026

The historical pre-adversarial full run on **chief-of-staff-v7 passed 92/108 trials**: every scenario ran twice and all failures were retained. The quality gate is still red. Remaining issues include overcautious verification, long-list dates, occasional stock wording, unsupported analytics inferences and an incorrectly confirmed deal status in a draft. The [dated results](results/2026-10-02.md) separate these from a recall-visibility judge defect, whose corrected trace passed **3/3** additional focused trials. The final real-source browser run passed **6/6** capture checks.

The first complete chief-of-staff run passed **91/108 trials**, retaining all failures. It exposed unsolicited planning after casual updates, inconsistent wording repairs, a date-card guard applied to casual client mentions, and some unsupported inferences. It also exposed fixture/judge defects: an unsupported synthetic CRM stage, inconsistent search/summary data, missing personal-clock context in the judge, and a no-read assertion that incorrectly rejected capability discovery. These are distinguished from agent failures rather than treated as evidence that all prompts were bad.

A focused v2 run passed **20/24 trials** before the remaining fixture/judge corrections. The v3 full rerun passed **92/108**, the v4 focused run passed **21/24**, v5 passed **87/108**, and v6 passed **48/54** with one trial per scenario. Subsequent corrections addressed clock/access context in the judge, ongoing-task updates, chat layout and successful fallback handling. The [dated results record](results/2026-10-02.md) contains run identifiers, final outcomes, deterministic/source checks and remaining failures. Original artifacts remain in `.local`; successful reruns do not erase failed trials. Because fixtures and rubrics changed too, these scores are not a controlled model-comparison trend.

The prior sales-manager-v2 baseline passed 51/51 single-request trials. It is historical and does not measure the newer chief-of-staff role. The older `eval:agent`, `eval:business` and `eval:sales` commands remain available as legacy regression suites; the current CI contract is the 85-scenario multi-turn harness.

Prompt design and repeated task-specific evals follow [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices). The local [coworker-loop review](../docs/agent-modules/26-coworker-loop-and-context.md) explains the comparison with claudeconvo.md and the logistics bot's context/media design.

## Local browser and source checks

The v5 browser run completed eight captured turns: casual news, personal drafting, planning, a correction to that plan, current RFQ cards, a follow-up warehouse shortlist, GA4 comparison and Search Console. All eight completed with zero browser errors; v6 also passed two fresh analytics turns. A personal draft took about 14 seconds in the graph and the v5 shortlist about 114 seconds. Delivery revalidation adds time beyond those trace durations. Complex reads still need latency work. No WhatsApp delivery occurred. Final browser counts and measurements are in the [dated results](results/2026-10-02.md).

The pre-adversarial deterministic worker check passed **171 tests with zero skipped**, including disposable PostgreSQL, plus typecheck, build/prompt packaging and formatting. Context Engine passed **1,859 tests with 66 optional tests skipped**, plus typecheck and a production build. These checks and real-source smoke are distinct from the probabilistic response-quality score.

The UI also passed desktop/mobile checks with a long fictional reply: the header and composer remain visible, messages scroll inside the chat, balanced emphasis is rendered using text/strong DOM nodes, multiplication stays literal and HTML-like content is never executed. Source receipts and business text remain in private test rows, not operator logs.

The older 17-case suite was also run on v4: **16/17** under its original checks. Its failed today/Hinglish trial had repaired the query correctly, but the assertion inspected the first call. The evaluator now checks the final search. Three further trials yielded **2/3**; the remaining trial used an unfiltered page and added overdue records to a today-only answer. That result remains a recorded quality failure, not a discarded retry.

## Model and effort comparisons

The conversation runner also accepts `--model`, `--tool-effort low|medium|high` and `--judge-model`. The public evaluator now defaults to `gpt-6-luna`. Earlier runs used fixed `gpt-6.1-sol` after blind calibration (Sol 56/56 versus Terra 54/56). That historical calibration does not validate the new Luna grader; it remains a separate call within the same provider, so human review is still required. Historical comparison/private runners retain their explicitly recorded judge setting. Metadata records effective stage efforts and the judge model. Reports distinguish `agentUsage`, `judgeUsage` and their combined `usage`; reasoning tokens are a subset of output tokens and cached input tokens a subset of input tokens, not additional tokens to add again.

`eval:compare-models` runs a predeclared 12-scenario subset twice for Terra-medium, GPT-6.1-Sol-medium and GPT-6.1-Sol-high. It retains every profile's reports and writes a comparison under `.local/model-comparisons`. Code/prompt/dataset/judge hashes must agree for a matched comparison. The Sol-medium versus Sol-high comparison changes only tool-loop effort; the Terra versus Sol comparison changes the agent model throughout the graph, with its external judge held fixed. Sol ordinary formatting uses low because none is unsupported. Current request clocks keep advancing; this is a repeated screening experiment, not statistical proof or a model leaderboard.

Compare hard tool-contract failures, invalid arguments, completed turns, source/proposal counts, semantic quality, turn latency and agent-only token use. Read failures before selecting a setting. Do not count a polished answer as successful tool use, or a source configuration failure as zero activity. A full 85-scenario production-model release evaluation requires separate explicit approval; it is not the default after every edit. Prompt/fixture fixes during screening require a new comparison, not mixing incompatible runs. Runtime reasoning continuity stays within one model session and is never included in reports.

See [adversarial review](../docs/agent-modules/27-adversarial-review-and-response-contracts.md) and [model/effort specification](../docs/agent-modules/28-model-and-effort-comparison.md) for implementation boundaries and measured follow-up.

## Private real-data outcomes

Run `npm run eval:private -- --base-url http://127.0.0.1:3012 --env-file .local/live-playground-sol-eval.env --case-file .local/private-evals/cases.json`. The localhost server must report capture delivery and no WhatsApp transport. The runner uses the server-configured employee, actual Context Engine/Supabase and an independent Terra judge. It checks employee outcomes against private reference facts and fresh source evidence, without prescribing tool selection or order. Private cases/results cannot run in CI and are never in the CI artifact path.

Each private case has an opaque `private-*` ID, `turns`, `outcomes`, `reference` and `asOf`. Keep questions and facts only under the ignored `.local/private-evals/` directory. Files use mode 0600 and directories 0700. The runner checks the real path and git ignore status. Terminal output contains opaque case IDs and aggregate pass counts only.

The v12 planner split exposed brittle generic date checks. The v13 gates accept semantically equivalent explicit date bounds or supported relative-date filters while still requiring the right report, assignment scope and date field. A changed-record fixture also now withholds that record on direct detail reads, instead of returning contradictory successful data. Original failing reports are retained; changed fixtures/judges require a separate new result, not retroactively improved scores.

The subsequent Sol screen, explicit role split, private outcomes, media and debounce results are recorded in [the graph/media validation record](results/2026-10-02-sol-graph-media.md). Earlier scores remain historical.

## Calibrated per-turn evaluation

`npm run eval:judge` runs 21 generic positive/negative examples twice against the
independent Terra judge. It covers UTC conversion, documented tool semantics,
native versus mirror dates, supported detail enrichment, unknowns, note recency,
verification versus repeated intake, schedule equivalence, grader injection and
bad-first/good-last conversations. Reports are retained in `.local/judge-calibration`.
The CI workflow runs calibration before the full conversation gate.

Each delivered turn gets its own indexed continuity, grounding, formatting and
usefulness verdict. A failing criterion requires a concrete claim/omission and
contradicting source fact or user constraint. The runner validates turn coverage
and findings, then aggregates the trial in code. It captures complete permitted
tool schemas at context admission, including direct turns; a prior turn's tool
catalogue cannot leak into a later denied turn. Timestamp conversions are supplied
as deterministic judge context, while analytics keeps its own reporting calendar.

Synthetic conversations start at `2026-10-02T09:00:00Z`, advancing one minute per
user turn. The same clock feeds the agent, source fixtures, recall and grader. Live
private tests retain real time. Query checks handle equivalent windows and
case-insensitive literals only where the tool contract permits them. Exact query
and URL matches remain case-sensitive. Assigned-only checks reject a broader
accessible query even if another assigned query succeeded.

Outcome journeys may accept equivalent tool routes, such as a current lead search
or a CRM briefing for a useful work brief. A specific tool sequence is not a
universal quality requirement. Security/API regressions retain explicit call
contracts. The missing-date fixture clears both search and detail fields; successful
native detail enrichment is valid in other scenarios. Query/page analytics
fixtures preserve their per-query subtotals.

Run inputs are hashed again at completion. A changed source snapshot exits
nonzero and is labelled invalid for baseline comparison. Never edit runtime,
prompts, fixtures or judge during a measured run. Result Markdown is excluded from
source hashing so results can be documented without changing the evaluated program.
Original failure reports are never rewritten or silently regraded.

See [refinement scope](../docs/agent-modules/33-eval-refinement.md) and
[tool extensibility](../docs/agent-modules/34-tool-extensibility.md). The graph has a
generic planning/model interface, but arbitrary future tools still need registered
execution and evidence adapters; write tools must not reuse read retries or read
receipt replay. Passing this suite does not certify unimplemented capabilities.

## Retained-answer regrading

`npm run eval:regrade -- --source .local/ci-evals/<run-id>` applies the current
calibrated judge to every saved trial in a complete, unchanged public run. It makes
no new agent/tool calls. The separate `.local/regrades` report records the source
report hash, original verdicts, unchanged hard checks and new judge provenance.
Incomplete runs, changed scenario files, private reports and paths outside public
CI results are refused. A regrade is not a fresh validation of newer agent code.

## Voice and STT checks

`npm run eval:stt` compares `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and
`gpt-transcribe` on four fictional generated English/Hindi audio cases, twice per
model. Generating these synthetic fixtures requires ffmpeg and espeak-ng; the bot
and ordinary CI do not require either program. The runner uses an authorized
OpenAI key and saves every
transcript under ignored `.local/stt-evals`. `OPENAI_STT_API_KEY` takes precedence
for audio; `OPENAI_TRANSCRIBE_MODEL` controls runtime transcription independently
of the assistant model. This paid opt-in smoke is not a human-audio accuracy
benchmark. Unit/integration checks cover exact quoted delivery, ordering,
expiration, key routing and the forwarded-audio debounce without WhatsApp.
The current adapter uploads original accepted audio bytes directly. The first
published comparison used the earlier conversion path; its recorded timings
remain historical rather than being relabelled as direct-upload measurements.

The public judge now evaluates one delivered turn per API request. It receives only
preceding conversation and that turn's evidence/permissions, so it cannot read
future user requests. Legacy case descriptions are also withheld, including in
one-turn calibration cases, because they can reveal later corrections or the
expected verdict. The judge helper accepts explicit per-turn, verdict-free rubrics
and reveals only the current entry. Each verdict is reindexed and aggregated in
code; failed earlier turns remain failures.

See the [production evaluation review](../docs/agent-modules/37-production-evaluation.md)
for the primary-source research, remaining holdout/monitoring gaps and proposed
release process.
