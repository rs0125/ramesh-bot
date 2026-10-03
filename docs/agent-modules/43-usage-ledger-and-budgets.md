# Usage ledger and currency budgets

Status: implemented locally with deterministic provider fixtures and disposable
PostgreSQL tests. Those checks made no paid model request and applied no production
migration or environment update. Deployment is a separate operation. Runtime metering
defaults to **off**; production spending controls are not active merely because
these files exist.

The ledger reserves an allowance before each supported OpenAI HTTP attempt and
settles it from reported usage. It covers conversational and business graph
stages, repairs, media extraction, transcription and evaluation graders when they
share the configured meter. Existing token limits, graph deadlines, tool budgets
and [evaluation approval policy](42-evaluation-spend-controls.md) still apply.

## Runtime modes and configuration

| Setting                     | Meaning                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `USAGE_MODE`                | `off` by default; `observe` records requests; `enforce` checks configured currency caps before requests |
| `USAGE_PRICES_JSON`         | Versioned, operator-reviewed rates and safe model ceilings, keyed by exact requested model ID           |
| `USAGE_RUN_MAX_USD`         | Optional cap shared by requests attributed to one run                                                   |
| `USAGE_SUBJECT_DAY_MAX_USD` | Optional cap shared by one trusted subject within a UTC date                                            |
| `USAGE_ACCOUNT_DAY_MAX_USD` | Optional cap shared by the configured account within a UTC date                                         |

There are no built-in rates or currency allowances. Omit unused caps; an empty
value is invalid. USD values are nonnegative decimal strings with at most six
fractional digits. Scientific notation and unsafe integer amounts are rejected.
Zero is an explicit zero allowance, not an unlimited cap. Internally, all amounts
are integer millionths of USD.

`off` adds no metered provider wrapper and cannot be combined with configured
runtime caps. `observe` records usage even when a configured cap would be
exceeded; it can record unpriced requests. `enforce` requires a price profile,
at least one configured cap and a stable run or campaign identity. Unknown model
pricing or an unsafe reservation stops the request before the provider is called.
Observation still requires working accounting storage; it is not a promise to
continue silently when ledger writes fail.

The production worker requires its durable Supabase connection for either enabled
mode. The real-data playground uses its dedicated Supabase capture login and
tables. Their account and purpose partitions are separate. A production account
cap does not also cap an independent evaluation campaign, another account ID or
another application's use of the API key.

The legacy SQLite playground does not supply a persistent meter. Adapter
construction rejects `USAGE_MODE=observe` or `enforce` without an injected meter
with `USAGE_METER_REQUIRED`; use the live Supabase playground for persistent caps.

## Reviewed pricing profile

`USAGE_PRICES_JSON` has a `version` string and a `models` object keyed by exact
model ID. Version and model IDs use letters, numbers, dots, underscores and
hyphens. Each model entry has these fields:

| Field                             | Unit and responsibility                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `inputMicrosPerMillion`           | Integer USD micros per million uncached text input tokens; required                                         |
| `outputMicrosPerMillion`          | Integer USD micros per million output tokens; required                                                      |
| `cachedInputMicrosPerMillion`     | Explicit rate for reported cached input tokens, when applicable                                             |
| `cacheWriteInputMicrosPerMillion` | Explicit rate for reported cache-write input tokens, when applicable                                        |
| `audioInputMicrosPerMillion`      | Explicit rate for reported audio input tokens, when applicable                                              |
| `durationMicrosPerSecond`         | Explicit rate for reported transcription seconds; see the enforcement limitation below                      |
| `maxInputTokens`                  | Reviewed upper bound for billable input of this model/request path; needed for a safe reservation           |
| `maxOutputTokens`                 | Reviewed upper bound used when a request has no explicit output limit, including token-billed transcription |

Rates must match the actual provider, requested model, service tier and billing
categories used by this application. Check current provider documentation and
account-specific terms before enabling enforcement; record a new profile version
when changing them. The profile is deliberately not populated with guessed prices.

Responses adapters explicitly request `service_tier: 'default'`. Enforced
metering refuses automatic, priority or flex tier selection, background/streaming
requests and hosted provider tools because those additional billing paths are not
priced here. A response reporting a different service tier retains unknown usage
and stops subsequent spending through that meter. Token-billed transcription
requires its explicit audio input rate before enforced admission.

For token-priced requests, admission reserves the configured maximum input at the
highest applicable input rate, plus the request's output limit or configured
output ceiling. This is conservative and can reject a request whose eventual
usage would have been smaller. It uses no character-to-token estimate or estimate
derived from compressed media size. Its usefulness depends on accurate operator
ceilings and pricing. It is an application admission control, **not a hard
guarantee about the provider's eventual invoice**. Provider charges, unsupported
billing categories, requests made outside this wrapper and inaccurate profiles
require separate operational accounting.

Reasoning tokens are part of reported output usage, so they are not added to
output tokens a second time. Incomplete responses can still incur usage before
producing visible text. See the official [OpenAI reasoning documentation](https://developers.openai.com/api/docs/guides/reasoning).
Cached reads, cache writes and audio counts are disjoint subsets of total input.
Each is charged at its explicitly configured rate; the remaining input uses the
ordinary input rate. Their sum cannot exceed reported input. Missing rates or
inconsistent usage produce an unknown amount, so positive cache-write usage
without `cacheWriteInputMicrosPerMillion` retains the reservation. Configuring this
optional rate also includes it in the maximum input rate used for admission.

The transcription adapter reads the returned usage structure, including its
reported text/audio split; see the official [Create transcription reference](https://developers.openai.com/api/reference/cli/resources/audio/subresources/transcriptions/methods/create).
Duration-priced responses can be observed when the provider reports seconds.
**Duration-priced transcription is refused by enforced admission** because this
implementation has no trusted maximum-duration reservation. A compressed file's
size is not a safe duration ceiling. Supplying token ceilings does not bypass
this restriction.

## Request lifecycle and accounting

1. Bind the server-owned run, stage, account, purpose and subject. The model cannot
   select budget identities through tool arguments.
2. Reserve before each actual HTTP attempt to `/v1/responses` or
   `/v1/audio/transcriptions`. SDK retries are separate attempts against the same
   applicable caps. Valid SDK retry metadata is recorded as a zero-based attempt.
3. Check every configured bucket atomically. PostgreSQL takes a short account and
   purpose transaction lock; no lock is held while waiting for the provider.
4. Replace the reservation with the amount calculated from valid provider usage
   and the reviewed profile. Retain request/response references and numeric usage.
5. If usage is missing or the request's result is ambiguous, record an unknown
   settlement and retain the reservation. A process crash leaves its pending
   reservation held as well.

Budget consumption is settled known amounts plus held reservations. An unpriced
entry with neither a known amount nor an allowance blocks later enforced
admission into the same tracked bucket. If reported cost exceeds a reservation,
the ledger retains that overage and applies it to subsequent admissions. It
cannot reverse a request that has already spent money.

Repeated identical reservation or settlement records are idempotent. Conflicting
records are rejected. Unknown settlements have **no automatic reconciliation or
expiry** and cannot be overwritten with a zero charge. A future reconciliation
workflow needs provider evidence and an audited adjustment contract; deleting
ledger rows to restore an allowance is not that workflow.

Run summaries expose `knownActualMicros`, `heldMicros`, `pendingRequests`,
`unknownRequests`, `unpricedRequests` and `costComplete`. Known amounts alone are
not the total when `costComplete` is false. Even a complete summary is priced
reported usage under the configured profile, not an invoice reconciliation.

## Identity, dates and capture uploads

Daily buckets use the **UTC date at request admission**. A request settled after
midnight still belongs to the date in which it was reserved. This accounting
calendar is separate from the employee-facing IST dates used by CRM conversations.
The server independently resolves the active roster identity for billing, before
extraction or model calls. Verified users receive an employee reference; ordinary
unknown senders receive a deterministic server-derived sender hash. Missing
subject scope uses the explicit unresolved bucket. A roster lookup failure logs
only a fixed code and falls back in observe mode; enforce mode blocks the request.
Neither the model nor a browser can select an employee billing identity.

Capture media uploads are separate upload runs from subsequent chat runs. A
per-run cap therefore does not represent the combined cost of uploading several
files and later asking a question. Subject/account buckets, and an authenticated
campaign bucket where available, are the shared controls across those operations.
The interactive capture server does not yet accept a remote evaluation campaign
allowance; that remaining gap is why remote paid evaluations are blocked.

Buckets are recorded only when configured for that request. Changing a cap for
an existing bucket changes later admission checks against its recorded
consumption. Adding a newly configured subject/account/campaign bucket **does not
backfill previously untracked requests**. Plan activation against a reviewed
accounting boundary; do not assume switching from untracked operation reconstructs
earlier spend. New price versions likewise do not reprice earlier settled rows.

## Supabase migrations and role isolation

| Runtime    | Migration                                           | Tables                                                    | Runtime login       |
| ---------- | --------------------------------------------------- | --------------------------------------------------------- | ------------------- |
| Production | `supabase/migrations/202610020006_usage_ledger.sql` | `ramesh-usage-requests`, `ramesh-usage-buckets`           | `ramesh_worker`     |
| Capture    | `supabase/playground/202610020003_usage_ledger.sql` | `ramesh-test-usage-requests`, `ramesh-test-usage-buckets` | `ramesh_playground` |

Apply each migration through its existing provisioning command and checksum
registry. `npm run db:messages` owns production message migrations;
`npm run db:playground` owns capture provisioning. These are separately initiated
database mutations, not actions performed by this documentation or an ordinary
test. Keep the application on the restricted runtime login.

The roles cannot read each other's ledger tables. PUBLIC, `anon`, `authenticated`
and `service_role` have no ledger grant. RLS requires transaction-local account
and purpose settings; absent scope sees no rows. The application validates its
fixed scope before setting them. These settings are service-owned context, not
authentication tokens accepted from a browser. Runtime grants permit insertion,
reading and settlement-column updates, with no deletion or rewriting of original
reservation columns.

Ledger records contain internal references, model/stage names, versioned pricing
references, numeric usage, amounts and timing. They contain no prompt, source
records, transcript, media bytes, API key or signed credential. Local evaluations
use the same admission rules in memory and persist private accounting artifacts;
they do not introduce a SQLite production ledger.

## Evaluation allowance and retained evidence

Every paid runner requires the amount actually approved for that run through
`--max-usd` or `EVAL_MAX_USD`, plus `EVAL_USAGE_PRICES_JSON` or its
`USAGE_PRICES_JSON` fallback. One campaign allowance covers agent, grader,
transcription, repairs and SDK retries. Missing allowance or pricing fails closed.
The existing three-trial limit counts scenario executions and does not replace
this currency cap. Luna remains the routine text-agent and grader default.
Every Sol agent or grader test still requires explicit user approval before it
starts; recording an approval reference is not itself permission.

Evaluations preserve `usage-policy.json`, append-only `usage-ledger.ndjson` and
`usage-summary.json` alongside their normal reports. Interrupted/failed runs stay
retained. Reusing their output directory cannot silently create a fresh allowance.
The comparison runner divides one approved amount into disjoint profile budgets.
An independent later process is a new campaign and requires its own accounting
decision; existing files do not implement automatic resume.

`eval:private` currently fails with `REMOTE_EVAL_BUDGET_UNSUPPORTED` before
contacting the capture server. A local grader allowance cannot enforce spending
inside a separate server. Re-enable private HTTP evaluations only after a trusted
campaign allowance covers both processes. The in-process live-playground smoke
injects the campaign meter into the server and is metered; it still requires an
explicit allowance, reviewed rates and any applicable Sol approval. Intentional
interactive playground usage remains distinct from automated evaluation.

See the [evaluation guide](../../evals/README.md) for runner options and artifact
contracts. Case listing, deterministic provider fixtures and local database tests
need no model API call. The related [capability readiness probe](44-capability-readiness.md)
checks the employee-bound source path without a model or WhatsApp session; it is
separate from both process liveness and paid response-quality evaluation.

## Implementation and focused verification

- `src/config/usage.ts`: explicit policy, rates and decimal USD validation.
- `src/modules/usage/usage-scope.ts`: trusted asynchronous attribution.
- `src/modules/usage/usage-meter.ts`: HTTP admission and settlement.
- `src/modules/usage/usage-pricing.ts`: reported usage and conservative reservation.
- `src/modules/usage/usage.types.ts`, `memory-ledger.ts`: storage contract and local accounting.
- `src/infrastructure/database/usage-ledger.repository.ts`: atomic durable accounting.
- `tests/unit/usage-ledger.test.ts`: concurrency, all caps, unknowns, overage,
  idempotency, isolation and safe integer validation.
- `tests/integration/usage-ledger.test.ts`: disposable local PostgreSQL admission,
  persistence, RLS and production/capture role isolation.

The integration fixture accepts only a local `ramesh_queue_test` control database
and creates temporary databases for each suite. Run targeted deterministic checks
for changed behavior; this module does not authorize a broad paid suite.
