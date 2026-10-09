# Model runtime and prompt configuration

Status: **Native Responses tool sessions and structured review implemented.**

**Implemented subset:** OpenAITextModel.startToolSession preserves correlated function outputs and complete continuation items with store:false. Tool declarations use strict:true through a provider-only schema adapter; decoded arguments still pass the original contract. Optional values remain optional for users, including a distinct encoding for explicit clearing. Writes remain serialized. Production and the live harness use Sol/medium, 240 seconds and 6,000 output tokens per response. Native tool reasoning and semantic review use medium reasoning; formatting uses low on Sol (the adapter raises unsupported none to low). All role instructions load from explicit `src/prompts/*.md` assets, are copied into the compiled build and are hashed in eval reports. Unconfigured repository chat defaults remain Terra/45 seconds/800 tokens. Per-person daily spend enforcement remains future work. See the [personal-assistant runbook](../sales-manager-agent.md) and [module 22](22-sales-manager-tool-loop.md). The richer task/checkpoint contracts below remain target design unless explicitly identified as implemented.

## Responsibility and existing behavior

Provide model generation through an injected port, keeping provider credentials outside the graph and tools. The existing `TextModel.complete` supports stage instructions, user/assistant messages, optional JSON schema, cancellation, response text and usage counts.

The inspected adapter uses OpenAI Responses, the configured model (default `gpt-5.6-terra`), `store: false`, bounded output and one SDK retry. Current ordinary-chat defaults are 45 seconds for the whole run and 800 output tokens per response. These are repository facts, not recommendations about the newest available model.

The Sol experiment adds `AGENT_TOOL_REASONING_EFFORT=low|medium|high`, retaining medium by default. GPT-6.1 Sol maps a requested none for simple formatting to supported low; business formatting stays low and runtime review stays medium. Returned reasoning-token and cached-input counts are included as numeric usage, without persisting reasoning content. The eval judge is pinned separately so a model change does not also silently change grading. See [the comparison contract](28-model-and-effort-comparison.md). Existing Responses continuation is retained in full within a single model session, including encrypted reasoning and correlated outputs.

## Role requests and structured decisions

Extend stage identifiers deliberately for routing, planning, worker decisions and verification. Each role uses a versioned prompt and local output schema. The current schema-output mechanism can represent a tool proposal; no provider-side tool execution is required for the first implementation.

Parse and validate structured text locally. Valid JSON alone is insufficient: tool names, evidence references, actor restrictions and budgets are checked by application modules. A provider refusal, truncated output or schema failure is a typed generation failure, not an executable command.

Structured decisions use SDK-generated strict JSON schemas. The adapter selects one final response message (or the sole unphased message), excluding explicitly marked commentary. It never parses the SDK's concatenated `output_text` for these decisions. Multiple candidate answers, multiple content parts, refusals, incomplete responses, invalid JSON and schema mismatches fail without an application formatter retry. Traces retain fixed categories and message/content counts, never the rejected text. Ordinary free-form replies remain text.

Strict function schemas close objects and require every provider property. For an optional nonnullable argument, provider `null` decodes to omission. For an optional nullable argument, `null` still omits it, while `{ "value": null }` supplies an explicit null and `{ "value": ... }` supplies a value. Nested objects, arrays and unions follow the same rule. Original MCP schemas, business argument hashes and durable operation payloads stay unchanged. Unsupported schema constructs fail before generation; there is no silent non-strict fallback. Provider-compatible relaxations such as `oneOf` to `anyOf` retain original local validation before execution.

A plain RFQ save may use `responseMode=receipt_only` to skip supplemental prose generation. Independent factual review still checks the original request and exact proposal, and execution rechecks authenticated authorization before submission. Only the application's verified write receipt establishes success. Mixed requests and reviewer-requested repairs retain composition; the plan hint cannot authorize a write or silently omit a requested answer.

Role instructions are authored/versioned application assets. A planner may supply task-specific requirements but cannot rewrite system policy or install arbitrary skills. Separate role contexts preserve the worker/verifier boundary even when they use the same model.

## Budgets and retries

The orchestrator supplies the remaining deadline and output allowance. Count provider retries, JSON-repair calls and verifier passes toward the same usage budget. Do not stack an unbounded application retry around the SDK's retry. Cancellation propagates to in-flight requests, and late results cannot finalize an old run epoch.

Budget configurations should include model-call count, input/output token allowance and an optional spend ceiling based on a maintained pricing configuration. Do not hardcode assumed current API prices in business logic. Report usage unknown rather than zero when billing usage is unavailable after a failed request.

Keep ordinary-chat defaults until measured changes justify altering them. Structured plans may need a different output limit; validate that per-role configuration against the pinned client/model before enabling it. Prompt/model changes run through the same held-out eval dataset.

## Privacy and failure behavior

Never log API keys, authorization headers, raw prompts or private source bodies in normal telemetry. `store: false` is an API request setting, not a claim of zero provider retention under every account policy. Source selection and redaction still matter.

Return safe categories for timeout, cancellation, provider unavailability, refusal, incomplete output and invalid structure. Ordinary chat may use the existing safe unavailability response. Business generation failure cannot fabricate a source-backed answer; deterministic rendering of already verified facts may remain available.

## Acceptance cases

Inject fake models for deterministic CI. Test cancellation, missing usage, malformed structured output, refusal, oversized output, retries under a shared deadline and accidental credential inclusion. Opt-in paid evals use synthetic cases and captured transport; they must not enable live Context Engine or WhatsApp by loading a production environment.

This module does not need a model/provider migration for the first CRM slice. Additional model configurations are optional optimizations after outcome-based evaluation.
