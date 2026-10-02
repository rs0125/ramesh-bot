# Sol comparison and Responses reasoning

Specification written before implementation, 2 October 2026. The user requested trying Sol against Terra and checking Responses reasoning effort. This is a local comparison, not permission to deploy.

## Controlled experiment

Use the existing Responses API adapter, the same v11 prompts, employee tool catalogue, fictional cases and original budgets. Compare `gpt-5.6-terra` with `gpt-6.1-sol`, which the existing account's model catalogue advertises. A model name in the catalogue is not proof of a successful tool call; run the actual journeys.

Keep the external judge fixed to `gpt-5.6-terra` at medium effort. Compare the Sol tool loop at medium and high; keep the runtime reviewer at medium and the business formatter at low. Simple formatting on Sol must use low because GPT-6.1 Sol does not support none. Preserve Terra's existing none setting for that stage. These are explicit compatibility settings, not a hidden retry after an invalid request.

First use a representative, predeclared subset covering recall, corrected requirements, pagination, analytics, source failures, injection, personal assistance and unsupported actions. Run two independent trials per case/configuration. Then run every scenario twice on the selected configuration. Preserve every failure and compare tool-contract failures separately from semantic quality, latency and token usage. Judge calls must be accounted separately from agent calls.

## Adapter and report contracts

- Configurable tool effort, validated as low/medium/high, defaults to the existing medium.
- No Chat Completions migration, temperature/top-p override, parallel tool calls or additional authority.
- Keep full Responses continuation, including encrypted reasoning and correlated function outputs, with store=false. Do not store encrypted reasoning or summaries in eval artifacts.
- Record returned reasoning tokens and cached input tokens as counts only, plus effective stage efforts and judge model in run metadata.
- Model/effort selection affects only newly constructed sessions. No encrypted reasoning is replayed between models or employees.
- Correct mechanical punctuation defects before comparing models: date ranges such as 25 Sep–1 Oct must remain ranges rather than becoming comma-separated dates. Keep the exact corrected code/prompts/fixtures fixed across compared runs.

Official references: [GPT-6.1 Sol capabilities](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Responses reasoning and continuation](https://developers.openai.com/api/docs/guides/reasoning). Effort is a requested configuration; reasoning-token counts measure returned usage. Neither alone establishes quality.

The adapter and screening results are implemented; [the graph/media validation record](../../evals/results/2026-10-02-sol-graph-media.md) separates the controlled screen from later graph changes.

The user also requested adequate planning references. In the v11 screening baseline, the planner role remained inside the LangGraph converser; `planning-reference.md` and an application-owned runtime catalogue/recall brief make its context explicit without introducing a separate planner LLM or granting tools from prose.

## Completed v11 screening baseline

A matched 12-scenario, two-trial screen produced Terra medium 21/24, Sol medium 23/24 and Sol high 23/24. Tool-contract failures were 1/0/0 and invalid argument counts 0/0/0. Median/p95 turn latency was 11/42.9 seconds, 18.6/60.4 seconds and 21.2/61.7 seconds respectively. High effort added latency with no measured quality gain in this small sample. The local playground therefore uses Sol medium. This is a screening result, not statistical proof or a score for the later separate-planner graph. Both Sol profiles hit a native-date parser false rejection that was corrected subsequently. Keep final graph evaluations separate.

The subsequent graph split is implemented in module 29 and is evaluated independently; the v11 comparison does not measure the new routing/planning calls.
