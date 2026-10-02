# Evaluation harness

Status: **Personal-assistant evals, real-data smoke and regression suites implemented.**

**Implemented:** `evals/conversation-run.ts` runs 74 multi-turn scenarios with repeated real-model trials, actual tool schemas and fictional records; protected CI emits JSON, JUnit and Markdown with start-time input/prompt manifests. See [evaluation operations](../../evals/README.md). The earlier evals/sales-run.ts keeps seventeen single-request regression scenarios without a delivery adapter. Reports retain outputs, actual arguments, checks and prompt/catalogue/dataset hashes. smoke:chat:live uses real Supabase/MCP with captured delivery. Unit and PostgreSQL tests verify hard boundaries; historical chat/preset evals remain available. See the [personal-assistant runbook](../sales-manager-agent.md) and [module 22](22-sales-manager-tool-loop.md) for the current contract. Production enablement remains separate. The richer role/task contracts below remain target design unless explicitly identified as implemented.

## Responsibility and test layers

| Layer                        | Environment                                                 | Establishes                                                           |
| ---------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| Module checks                | Fake models, gateways and clocks                            | Validation, routing, denial, date/unit handling and state transitions |
| Storage/recovery integration | Isolated PostgreSQL, fixture MCP server and captured sender | Transactions, leases, duplicate prevention, restart and encryption    |
| Conversation integration     | Existing isolated SQLite fake chat                          | Natural dialogue, history/audience separation and transport capture   |
| Repeated model evaluation    | Real configured model with synthetic tools/data             | Task completion, grounding, clarification, tone and variability       |

The existing CLI permits one to five trials, defaults to three, and has core/holdout splits. Preserve those semantics unless explicitly extended. Add business fixtures through dependency injection; production credentials or database environment variables must not silently select live adapters.

## Scenario contract

Each scenario specifies synthetic actor/audience, input turns, fixture data/version, tool behavior, expected allowed/denied operations, required outcome assertions and grading rubric. Include a controlled clock and deterministic source freshness. Do not require exact wording or one exact tool-call sequence when several are valid.

Keep preset lookup, explicit planning and independent-review variants comparable on the same held-out objectives. Record prompt/schema/model versions, dataset hash, budgets, outputs, operation receipts, verification findings and captured delivery outcome for every trial.

## Required cases

- Assigned follow-ups today: authorized employee, admin with broader visibility, empty result, bounded page and correct IST day semantics.
- Identity: unknown/inactive employee, ambiguous number, valid/invalid LID, changed identity on resume and group business denial.
- Evidence: stale mirror, degraded related stream, missing fields/units, source outage, forged receipt and unsupported worker claim.
- Language: Hinglish intent, ambiguous references, factual negations, concise response and no em dash or canned AI phrases.
- Adversarial content: instructions inside CRM notes, malicious tool text and actor/destination override proposals.
- Recovery: restart before/after receipt or finalization, expired lease, cancelled run, access revoked before delivery and uncertain send.
- Later milestones: reminder edits, resolved SLA episodes, confirmation binding and write reconciliation.

## Grading and pass rules

Code graders enforce identity/scope, no prohibited effects, stable deduplication, required evidence/coverage and output bounds. Any unauthorized disclosure or action is a failing trial, regardless of model judge scores. Model graders evaluate nuanced completeness, supported interpretation and tone, with periodic human calibration.

Keep model-judge context independent of the worker's reasoning. A same-model judge is a quality signal with correlated-failure limitations. Retain disagreements and failures for review; do not rerun until the desired score appears. Report pass rates per case and trial counts, not just an aggregate percentage.

Latency, tool/model calls, tokens, repair frequency, source failure rate and cost estimates are measured separately. Improvements must be judged against a baseline at comparable budgets. Define rollout targets from pilot measurements rather than inventing performance guarantees in the spec.

## Execution and artifacts

Ordinary CI remains offline and deterministic. Live-model evaluations are opt-in and may spend API credits. Reports stay in the existing ignored local eval directory with restricted permissions and synthetic content. Local PostgreSQL verifies Supabase-compatible SQL; the dummy GUI stays SQLite/capture-only by default.

The separately requested [real-data harness](21-live-data-playground.md) deliberately connects to live Supabase and signed Context Engine as a server-configured employee. `smoke:chat:live` checks current source evidence, replay authorization, unknown/group denial and capture completion without asserting a fixed lead count or saving CRM bodies to reports. It is an explicit live integration check, separate from repeatable fixture evaluation and ordinary CI. `dev:chat:live` uses the same capture boundary in the GUI.

The first implementation must run focused module and integration checks, plus repeated synthetic model trials when the configured key is available. No automated evaluation needs to send a real WhatsApp message or retrieve actual employee CRM records.

## Implemented multi-turn regression suite

`evals/conversation-cases.ts` and `evals/conversation-run.ts` add paid real-API trials with synthetic source fixtures. The suite checks conversation continuity, the last 32 messages, latest-created RFQs, native dates, deal-UUID exclusion, warehouse pros/cons, client-use corrections, per-owner questions and revoked/changed history. Deterministic assertions accompany an independent structured model quality rubric; all failures remain in private reports. Real Supabase smoke checks use capture-only queues separately. See [module 24](24-business-recall-and-deal-display.md).

## Per-turn grading and calibration

The implemented refinement in [module 33](33-eval-refinement.md) grades every
actually delivered reply. The judge supplies indexed criterion verdicts and
specific evidence-backed findings; code validates coverage and aggregates the
result. A good final reply cannot erase a poor earlier reply. Full current tool
schemas and mechanically converted timestamp context prevent unsupported
assumptions about filter semantics or UTC versus source-local calendars.

`npm run eval:judge` exercises 21 generic positive/negative calibration examples
twice. CI runs calibration before the conversation gate and retains its reports.
Public conversation scenarios use a fixed synthetic clock, advancing one minute
per user turn; private live scenarios retain real source time. Source and prompt
hashes are checked at the start and end of each run. Changed inputs invalidate a
frozen-snapshot claim; failed trials and earlier reports remain untouched.
