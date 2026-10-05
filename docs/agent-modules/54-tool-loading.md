# 54. Eager and deferred tool loading

Context Engine owns the business tool catalogue. Ramesh consumes ordinary MCP
discovery and optional `_meta["wareongo/tool-discovery-v1"]` presentation hints.
No tool-name registry is added to Ramesh. Existing legacy contracts remain usable.

`AGENT_TOOL_LOADING=eager|deferred` selects loading at runtime. Eager remains the
default for rollout compatibility. It keeps the existing full function catalogue.
Deferred mode groups discovered business tools into provider namespaces of at
most eight functions and enables OpenAI hosted `tool_search`. Local tools and
explicitly eager tools remain available immediately. Use a provider model that
supports native tool search, such as GPT-6 Luna. There is no silent mode fallback.

The planner receives names and short descriptions in deferred mode, because its
validated plan refers to tool names. It does not receive every deferred parameter
schema. The worker receives the namespace summaries and searches for definitions.
The API request still carries definitions for hosted search; deferral concerns
model context, not MCP network transfer. Review stages retain the definitions
needed to assess actual evidence and write proposals.

The adapter checks namespace/name bindings and returned search schemas against
its original catalogue. Search cannot invent permissions, tools or schemas. It
handles completed server search items, preserves them in continuation/replay,
and aggregates usage across search-only responses. Client-executed search is not
implemented and is rejected. Search is bounded to eight calls per tool session.
Current callable subsets are applied to deferred declarations; dispatch is checked
again locally. A new run gets a new snapshot. Source execution reauthorizes live.

Writes still flow through `BusinessWriteRun`: same policy, independent review,
confirmation, idempotency and recovery in both modes. Provider search never calls
the MCP write endpoint itself.

## Verification

Offline checks cover unfamiliar capabilities, eager compatibility, schema and
namespace substitution, withdrawn tools, search limits and durable replay. Run
`npm run check` for the full local checks.

`npm run eval:tool-loading -- --dry-run` lists the focused three-scenario campaign.
For a paid run, provide `--catalogue /path/to/ordinary-mcp-tools.json`, an approved
`--max-usd` allowance and the reviewed `EVAL_USAGE_PRICES_JSON` profile. The runner
uses Luna and the production AssistantService/graph with synthetic business data.
It checks the eager/deferred pair and an unfamiliar capability among distractors.
It retains native search events, usage, traces and failures under `.local` and
never constructs WhatsApp transport or production writes. Three scenarios are a
compatibility screen, not a statistical accuracy study.

Use `--case deferred-crm-summary,deferred-unfamiliar-tool` for an explicitly
authorized focused follow-up and `--continuation-of <previous-run-id>` to retain
its relationship to the original results. A new allowance must fit the remaining
approved total; a new output directory never grants more scenario executions.
`evals/lib/tool-loading-checks.ts` can regrade saved outcomes without model calls.

The shared HTTP usage meter accepts function-only namespaces and hosted tool
search under token pricing. Fee-bearing hosted tools remain unsupported in
enforced campaigns, including attempts to put them inside a namespace. Search
continuations and SDK retries consume the same campaign allowance.

Provider behavior follows the [OpenAI tool search guide](https://developers.openai.com/api/docs/guides/tools-tool-search).
