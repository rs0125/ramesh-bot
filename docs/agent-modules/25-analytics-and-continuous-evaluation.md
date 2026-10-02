# Analytics, editable prompts and conversation evaluation

Status: implemented and locally tested, 2 October 2026. Production activation is separate.

## Purpose

Ramesh should handle employee-scoped CRM, supply, knowledge, GA4 and Search Console conversations. A useful answer must carry selections across turns, ground claims in successful reads, preserve source limitations and remain readable in WhatsApp. The capture playground exercises the same graph without a WhatsApp transport.

## Analytics authorization and transport

Add `analytics:read` to the supported signed-request scope vocabulary in both applications. It is an explicit key registration permission, never a grant derived from message text. Existing three-scope keys remain valid and do not gain analytics automatically. Effective permissions are the intersection of the registered key, requested scopes and current active employee permissions. Context Engine already grants analytics only to employees with Analyst access, including admins. Keep its post-upstream permission recheck and signed request nonce, body, method, audience and expiry verification.

Expose `analytics_capabilities`, `ga4_report` and `search_console_report` through the existing read gateway. Keep Google credentials and the configured property/site exclusively in Context Engine. No arbitrary property, OAuth token, identity override or write tool is accepted from the model.

## Evidence contract

- Check the expected API path and only citation-safe query parameters. Context Engine deliberately excludes sensitive free-text and URL filters from citations; compare those against structured query context instead.
- Validate reporting dates in the source timezone, including Search Console's `America/Los_Angeles`. Do not apply CRM's IST/as_of envelope to Google reports.
- Require available/read-only source status, recent served and fetched clocks, bounded cache age, consistent page counts/cursors, finite metrics and source/quality metadata. Validate comparison baseline and form-performance component freshness too.
- Saved replies are reauthorized using the existing tool delivery receipt. Ignore retrieval timestamps and cache hit/age when fingerprinting analytics, while retaining resolved dates, filters, metrics, quality flags, source identity and interpretation. A new cache timestamp alone is not a changed business fact.
- Preserve bounded recovery codes/actions. Access/configuration failures need correction, not repeated requests. A failure never establishes zero traffic. An unavailable GA4 source must not prevent a permitted Search Console read.

## Agent behavior

Use capabilities when source/report support is unknown. Choose aggregate reports for totals and server comparisons for previous periods. Rates are fractions, durations are seconds, grouped rows are bounded results, and zero baselines have no relative percent change. GA4 sessions and Search Console clicks differ. Form events and key events are not unique CRM leads or revenue. Explain those distinctions only when relevant to the user's question. Label incomplete/recent data and source timezone/date windows. Page questions must distinguish session-entry paths from event-page context. Carry date/filter corrections across turns without inheriting filters the user removed.

## Editable prompt modules

Store conversational, chief-of-staff converser, formatter, business formatter, verifier and legacy intent prompts in `src/prompts/*.md`. Code loads these files through an explicit allowlist relative to the module, independent of the working directory. Fail startup if a required prompt is missing or empty. Include the Markdown files in the compiled deployment artifact. A manifest hashes every loaded prompt so eval reports identify the exact instructions, including formatting and review prompts. Editing a prompt requires a process restart; no browser-authored system prompt or runtime prompt editing endpoint is added.

Keep orchestration, budgets, schemas, identity and authorization in code. The current graph separates a planner model and native-tool worker from the deterministic executor; see [module 29](29-planner-worker-verifier.md). Credentials, calls and access checks stay in the executor, outside model authority.

## CI and evaluation contract

1. Every PR: deterministic graph, permissions, evidence, queue isolation, history and prompt packaging tests with synthetic data and temporary PostgreSQL. No secrets or WhatsApp session needed.
2. Protected manual/scheduled CI: real OpenAI model, synthetic multi-turn CRM/supply/analytics fixtures, all turns in order, repeated independent trials. Exercise follow-ups, ordinal references, intervening chat, 32-message retention, use corrections, changed/revoked history, analytics comparisons, partial failures and source injection. Validate tool arguments and answer properties, then run a separate structured quality judge.
3. Operator-only real-data smoke: actual signed Context Engine, real Supabase/Google data, pinned employee, dedicated capture tables. Never run with real business credentials on untrusted PR code or upload real-data transcripts as public CI artifacts.

The paid harness must expose scenario filtering, trial count, bounded concurrency and a stable output directory; return nonzero on failure; retain every trial without rerolling failed answers; emit JSON, JUnit and a compact Markdown summary with per-scenario pass rates, prompt hashes, model, duration and tokens. Hard safety/tool/format contract failures cannot be overridden by the judge. Judge decisions are evidence for tuning, not proof of factual correctness. Baseline quality changes must remain visible rather than silently lowering the pass criterion.

## Acceptance

The compiled bot loads the same Markdown as development. Registered Analyst requests can discover/call all three analytics tools; unregistered scopes, inactive employees, ordinary employees and groups cannot gain analytics. Tests cover both source timezones, cached rereads, changed metrics, structured failures and malformed reports. CI can run the complete multi-turn suite from this repository using only its OpenAI secret. The local GUI remains capture-only and preserves names, native CRM dates, warehouse IDs, uncertainty and conversational context.
