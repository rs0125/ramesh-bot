# Tool extensibility without changing the agent graph

Status: dynamic first-party read discovery is implemented; writes and arbitrary
third-party tools remain future work. Advertising a tool does not grant permission
to run it. See the [live read contract](45-dynamic-tool-discovery.md).

## Implemented harness utilities

The employee DM tool loop now has a small application-owned utility adapter,
separate from `CONTEXT_READ_TOOLS` and the Context Engine server. No database
migration is needed. It is available only when the existing business-read loop
opens for an eligible active employee in a DM. Groups, unknown users, and the
ordinary two-node synthetic chat do not receive these tools.

| Tool           | Inputs and behavior                                                                                                                                                                    | Configuration                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `calculate`    | Bounded decimal arithmetic, integer powers, parentheses and compatible area/length conversions. Returns a decimal string with explicit rounding. No executable code or network access. | Always present in the eligible DM loop.     |
| `web_search`   | A public query, optional news/general topic, time range and up to five results. Snippets include their source URLs and optional publication dates.                                     | Non-empty `TAVILY_API_KEY`.                 |
| `read_webpage` | One public HTTP(S) URL and an optional text limit. Extracted text includes its source URL and truncation state.                                                                        | Same `TAVILY_API_KEY`; Tavily Extract only. |

Set `TAVILY_API_KEY` in the worker's private `.env`, the live playground's separate
`.local/live-playground.env`, or the production worker environment. Restart the
corresponding process after changing it. `.env.example` and the EC2 environment
template include an empty placeholder. Blank leaves ordinary chat, Context Engine
reads and calculation operational, and removes both web tools from discovery.
No key is included in model instructions, tool arguments, trace summaries or
provider error messages. This configuration does not enable an installation whose
business-read feature or signed Context Engine access is unconfigured.

Calls share the existing 24-proposal budget and 28-step graph limit. Every utility
call checks the current employee binding, including before accepting a new or
cached result. Tavily additionally has a four-request limit per run, a 15-second
request deadline and a 1 MiB response cap. Search uses basic depth with automatic
parameter upgrades disabled; extraction uses basic depth, one URL and a 10-second
provider timeout. Identical calls reuse their result/failure within a run. There
are no automatic provider retries or fallback providers. Quota, authentication or
rate-limit failures stop further uncached web requests for that run.

Search snippets are capped at 1,800 characters each. Page text defaults to 12,000
characters and can be requested up to 20,000; truncation is explicit. Each utility
result is limited to 80,000 bytes, with a 100,000-byte cumulative utility evidence budget.
The worker only connects to the fixed Tavily API origin. URL validation rejects
local/IP targets, non-web schemes, embedded credentials, nonstandard ports and
recognized credential query parameters. This is a public-source adapter, not an
authenticated browser. Returned source text cannot authorize tool calls or writes.

Both formatter and verifier receive accepted utility evidence and failures.
Private Context Engine evidence keeps its existing encrypted delivery receipts
and current-access checks. Utility calls are never replayed as MCP reads during
delivery. A private answer that also used public web data marks its receipt with
`publicWebUsed`; later business recall refreshes the private reads but withholds
the old combined answer and instructs the worker to refresh relevant web sources.
Public-only tool results do not acquire private source permissions.

Tavily's returned `credits_used` is recorded in the in-run result when present;
missing usage stays unknown. The OpenAI USD ledger does not account for Tavily
credits. Keep paid upgrades/automatic billing disabled in the Tavily account if
the intended policy is free-tier-only. The per-run call bound is not a monthly
provider quota or a guarantee of zero total inference cost.

Implementation: `calculator.ts`, `utility-tools.ts`,
`src/infrastructure/tavily/client.ts` and the existing graph/executor. Deterministic
checks in `utility-tools.test.ts` and `utility-agent.test.ts` use synthetic models
and mocked HTTP, including quota errors, cancellation, denied identities, source
projection, shared budgets and mixed-answer recall. No live Tavily or model call
is required to run them. Provider integration follows the official
[Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) and
[Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract) APIs.

## Current compatibility

| Layer                    | Current behavior                                                                                          | New tool impact                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Converser/planner/worker | Plan from the permitted live catalogue and JSON Schemas; graph stages do not enumerate business workflows | Same graph can plan a different capability                                                    |
| Model adapter            | Native Responses function calls with generic names, schemas and outputs                                   | No new agent or provider implementation required                                              |
| Context executor         | Admits current employee-permitted read contracts, validates schemas and evidence                          | New conforming reads need server registration; no bot name-list edit                          |
| Evidence/delivery        | Domain-aware source paths, freshness checks and encrypted read receipts; replays reads before delivery    | Generic reads use request binding and full evidence replay; domain checks remain specialized  |
| Media                    | Same-owner image/PDF extraction and audio transcription; 24-hour private retention                        | Useful input today; extraction is bounded and potentially lossy, not a general document index |
| Writes                   | No write transport, confirmation state, idempotent command lifecycle or write receipt                     | Requires an effect adapter and the action lifecycle in module 17                              |

Implementation references: `src/modules/assistant/task-plan.ts`, `sales.graph.ts`,
`tool-executor.ts`, `tool-evidence.ts`, `business-reads.ts`,
`src/modules/context-engine/context.types.ts`, and `src/modules/media/`.

## Extension contract

Keep the shared graph concerned with intent, outcomes, execution, evidence and
response quality. Context Engine owns read registrations and domain authority.
Its live read contract carries schemas and minimum scopes; future effect adapters
should also describe each capability with:

- Stable name/version and discovered input schema.
- Effect class: read, private artifact analysis, proposal, or write.
- Trusted actor/audience policy, scopes and backend binding, never model-supplied credentials.
- Execution deadline, output-size/call budget, cancellation and retry policy.
- Result validator, evidence projection, retention and display requirements.
- Read freshness/revalidation, or write idempotency/reconciliation and authoritative
  postcondition checks. These are different contracts.

First-party read tools are discovered from the authenticated Context Engine at
runtime. They need the versioned read contract and current employee permission,
not a matching bot-side registration. New effects remain unavailable until their
adapter is implemented. Neither an MCP annotation, source document nor a
model-generated label may authorize a write.

Context Engine also requires an explicit platform list for every tool. Its admin
**Prompts → Available on** selector controls `claude` and `whatsapp` independently;
the authenticated `/mcp/ramesh` endpoint selects WhatsApp on the server. Keep this
selection separate from employee permissions: platform selection decides which
tools the server offers, while current permissions and the read contract decide
which offers Ramesh can use. The worker refreshes discovery before every call and receipt
replay. A tool removed during an in-flight read produces a non-retryable
`TOOL_UNAVAILABLE`; there is no fallback to the Claude endpoint.

Do not run a write through current read receipt replay: that would execute the
mutation again during recall or delivery. A committed action has a persistent
operation receipt; verification reads its postcondition or operation status. The
user's clear request can authorize a permitted low-impact action under policy;
confirmation, when required, binds a concrete payload and current actor. See
[17. Business actions](17-business-actions.md).

A document-analysis tool should accept authorized opaque artifact IDs, scoped
questions and bounded page/section requests. It should return page/section
references, extraction coverage, unread/failed parts and uncertainty. It must not
accept arbitrary file paths or public URLs supplied by the model as authority.
Reuse the media owner/expiry checks, and distinguish a derived extract from a
complete reading of the original document. The worker can then request additional
sections through the same tool loop rather than relying on one lossy extraction.

## Avoiding use-case overfitting

General behavioral evals judge outcomes and use the current advertised schemas;
they should accept different valid tool paths, supported interpretation of visible
facts, and equivalent query spellings. Exact call requirements belong to explicit
API/security regression tests, such as refusing unauthorized writes or preserving
an assigned-only query. They are not the universal definition of intelligence.

Use separate evaluation layers:

1. Domain-independent behavior: continuation, corrections, constraints, clarification,
   uncertainty, partial completion, tool failure and response quality.
2. Adapter contracts: schema validity, identity, scopes, input/output limits,
   idempotency or read freshness, and artifact ownership/expiry.
3. Outcome journeys: a user goal with reference facts, without prescribed tool order.
4. Held-out variations when a new capability is added: unfamiliar names, different
   schemas, reordered results, absent fields and multi-tool dependency chains.

The present public suite covers personal work, CRM, supply, knowledge, analytics
and boundaries; private real-data cases prescribe employee outcomes. This is
useful evidence for these capabilities, not proof of arbitrary future tools. The
new grader-calibration suite tests semantic equivalents and known bad neighbors.
Do not tune prompts to private record names or promote fixtures into product rules.

Keep new domain rules in adapter-specific guidance. Avoid adding another permanent
agent, an intent regex or a universal prompt paragraph for every endpoint. Review
common-versus-domain prompt separation again when the next actual capability is
registered, with measured held-out cases before enabling it.
