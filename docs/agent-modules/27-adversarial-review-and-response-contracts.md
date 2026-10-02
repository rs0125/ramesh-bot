# Adversarial review and response contracts

Status: implemented locally, 2 October 2026; final repeated model evaluation is in progress. This increment keeps the personal chief-of-staff role, existing employee permissions and capture-only real-data playground.

## Reproduced findings

1. **Requested action becomes a fact.** Both retained `write-claim-boundary` failures turned “mark this won” into “confirmed won” inside a draft. No write happened, but the draft was misleading. Source facts, user-reported facts, requested actions and suggestions need one shared contract across conversation, formatting and review.
2. **A formatter can drop required dates.** Long inline CRM lists bypass the heading-only date check. A single Created/Last updated pair can satisfy the existing global check for several records. Canonical native dates should be added to unambiguous listed record blocks in code, and each block checked separately. Do not attach dates to ordinary mentions, recipient drafts or task instructions.
3. **Review can move its goalposts.** A retained review called a caveat adequate while rejecting it, and a second analytics review introduced another wording requirement after repair. Reject material unsupported claims or incomplete work. Shared qualifiers are valid; do not demand repeated disclaimers or speculative research. A second review checks the repair and any new material errors, without inventing stylistic blockers.
4. **Duplicate handling prevents recovery.** The reviewed implementation marked every attempted query duplicate, including a transient failure. A repeated successful query loses its result instead of reusing it. Preserve fresh, scoped in-run evidence; permit one explicit retry of a retryable read while respecting Retry-After. Never retry permission/configuration failures unchanged. Count every proposal against the original budget.
5. **Mechanical style checks only partly run in production.** Paid evals reject stock phrases, but the runtime layout check only rejects tables/code. Apply the same phrase checks before delivery and route them through the existing bounded formatting repair.
6. **Prompts have accumulated overlapping corrections.** Split the shared evidence contract into editable Markdown; shorten role/editor/reviewer prompts around responsibilities, concrete tool semantics and a few contrasting examples. Keep schemas, permissions and delivery checks in code.

## Implementation boundaries

- Same LangGraph converser/tool-executor/formatter/verifier graph and one repair. No extra planner or unconstrained agent.
- Same seventeen read tools and application-owned private recall. No shell, arbitrary network, write/send tool or browser-selected identity.
- Duplicate successes return the existing registered evidence after current identity and freshness checks. Delivery still reauthorizes all supporting sources. No cross-request or cross-employee result cache.
- Non-retryable source configuration/access failures stop further calls to that affected tool within the run, while other tools remain available. Report-specific unavailability must not disable supported reports from the same source.
- A source request has at most two attempts for an identical query. A delayed retry cannot execute before its deadline; cancellation and the run deadline remain authoritative. Raw upstream errors never enter prompts or logs.
- Date enrichment only uses unique labels from current validated CRM evidence. Ambiguous names or unrecognized prose remain subject to semantic review; never guess which record a label identifies. Missing source dates remain Not recorded.

## Adversarial evaluation

Extend the generic multi-turn harness with fictional attacks and ordinary difficult cases: instructions inside notes/knowledge/warehouse descriptions; user-auth impersonation; forced unsupported action claims; old relative dates; duplicate labels; unknown specifications; changing scope across turns; forbidden analytics attribution; transient/configuration source failures; partial useful answers; and attempts to remove required dates or uncertainty.

Hard checks cover tool arguments, forbidden reads, duplicate/retry counts, explicit disclosure markers, UUIDs and mechanical layout. Semantic action claims, uncertainty, scope completeness and helpfulness also receive independent model review; the judge cannot override a hard failure. The independent judge sees successful source evidence and executed local recall. Keep every failure and separate test-harness defects from agent failures. Run focused real-model trials before the complete suite, then exercise real Supabase/Context Engine only through the pinned capture playground. No WhatsApp or CRM mutation.

Use [OpenAI trace evaluation guidance](https://developers.openai.com/api/docs/guides/agent-evals) to inspect tool decisions and handoffs, and [agent safety guidance](https://developers.openai.com/api/docs/guides/agent-builder-safety) for untrusted-input isolation. These are principles for this application's existing authorized read boundary, not a change of framework, model or employee permissions.

## Implemented changes

- At the v11 baseline, eight editable prompt files included a shared evidence/action contract and a planning reference. Role, formatter and reviewer responsibilities are narrower; source facts, user reports, requested actions and recommendations remain distinct even inside drafts.
- `tool-executor.ts` now handles successful reuse, one transient retry, source-level Retry-After and configuration failures. Current identity, evidence freshness, budgets and durable receipt registration remain code-level requirements. A successful cached read still cannot extend freshness or cross employee identity.
- `deal-display.ts` adds only missing native metadata for unambiguous record entries and checks every recognized block. Duplicate labels are not guessed. The parser accepts ordinary bullet/dot/pipe/semicolon separators and equivalent calendar-date notation independently of the host timezone. Incorrect supplied dates remain a repair error rather than silently being overwritten.
- Presentation findings enter the review request before its decision, alongside previous feedback and review-pass number. Reviewers cannot override native-date semantics or require polling timestamps in native fields. The graph still permits only one bounded correction.
- The punctuation cleanup preserves cross-month and time-of-day ranges. Previously, `25 Sep–1 Oct` became `25 Sep, 1 Oct`, repeatedly failing review despite a correct model answer. This was a code defect, not evidence that the model could not interpret the requested period.
- The 20 new paid adversarial scenarios bring the complete registry to 74. Traces now retain per-turn model proposals, returned results, actual source attempts and executed private recall separately. Count gates catch unwanted calls and retry storms, not just poor final wording.
- Responses model/effort configuration and returned usage counts support a fixed-judge Sol/Terra comparison. Simple GPT-6.1 Sol formatting uses low rather than the unsupported none. The planning context is derived from the permitted live catalogue and trusted audience. That v11 baseline had no separate planner model. [Module 29](29-planner-worker-verifier.md) supersedes it with separate planner/worker/verifier roles and twelve prompt modules.

## Retained experiments and evaluator corrections

The first v8 adversarial run passed **13/20**. It caught native-date substitution under user pressure, an aggregate engagement claim about extra visitors, and inappropriate certainty in a search optimization suggestion. The requested-versus-confirmed draft fix itself worked, but the judge incorrectly equated “no owner was returned” with “there is no owner”; the rubric now explicitly distinguishes them. A form-submit case now names the exact `form_submit` event so its strict filter assertion matches the request.

The v9 focused run passed **10/12**. One failure was real: punctuation cleanup corrupted a cross-month date range, so review withheld the answer. The other was a hard-check defect: valid bold **Not recorded** fields failed a plain-text regex. The report remains unchanged; the check now accepts ordinary chat emphasis.

The first v10 model screen was stopped before Sol started after a valid `•` separator exposed a date-parser defect. It retained **21 completed Terra trials, 19 passing**, plus an interruption manifest; usage from interrupted API calls may be unreported. This is not a completed comparison. The corrected v11 experiment starts all three arms from matching inputs instead of combining incompatible results.

## Remaining architectural limits

The date parser intentionally recognizes a limited set of unambiguous record layouts. It is not a full natural-language fact verifier. Semantic reviews and the fixed external judge remain probabilistic and can overreject or miss a subtle claim. Two trials per case are useful screening, not proof of safety or model superiority.

The graph still makes multiple model passes, and protected recall/delivery can reread substantial evidence. Real-source latency may be much higher than fixture latency. No arbitrary SQL, writes, scheduler, outbound WhatsApp test transport or media-content understanding was added by this review. The existing production enablement/migration work remains separate from local validation.
