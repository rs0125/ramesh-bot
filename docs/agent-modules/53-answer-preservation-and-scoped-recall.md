# 53. Answer preservation and scoped recall

Status: implemented in this checkout with prompt version
`ramesh-chief-of-staff-v33`, reviewed on 5 October 2026. Deployment is a separate
release step. This change needs no new database migration and has not had a new
paid model evaluation.

## Preserve the completed answer

The worker returns final WhatsApp prose, including the requested decision,
selected records, quantities, units and material uncertainty. For a completed
worker answer with accepted Context Engine evidence, no composed personal/write
preview, no repair feedback and at most 12,000 characters, the formatter applies
deterministic styling and native CRM-date handling. It does not ask another model
to rewrite the answer before verification.

Direct replies, unfinished research, oversized drafts and mixed action/read
responses still use the formatter model when needed. A repair asks for the
smallest supported edit. A guard preserves the previous read answer if a model
repair changes its numeric quantities/units or ordered explicit warehouse IDs.
This guard is not a semantic proof; the verifier still checks the answer.

Native Created/Last updated requirements apply to CRM record cards. A client
heading above warehouse options does not itself require a second CRM card.
Short follow-ups retain the requested recommendation rather than replacing it
with owner questionnaires. One shared verification caveat can cover the named
candidates; additional unknown specifications matter when they affect the brief
or decision.

## Review and exact repairs

The verifier distinguishes blocking errors from optional suggestions. An
otherwise supported provisional shortlist does not fail because it omits an
unasked washroom, gate or apron check. A known conflict with an explicit
requirement, an invented fact or an incorrect execution claim remains blocking.

Structured findings carry a kind, exact answer quote, replacement and source
references. Factual and scope references use an accepted `evidence_id`, a JSON
pointer relative to `evidence.result`, an exact JSON-serialized scalar value and
the containing `record_id`. Execution-status references instead use the
application's `execution` source and `/data/tools/<tool>/status` or another
runtime field. Record-specific quotes identify the warehouse ID or CRM source
name; hidden CRM UUIDs are not added to the reply merely to make a patch possible.

The runtime checks that each quoted span is unique and nonoverlapping, the
reference and scalar value match current evidence, and the correction belongs to
the same record. It rejects unsupported IDs, new ungrounded numbers and unit
changes. A complete patch also requires the reviewer to affirm that the remaining
answer is supported. Invalid feedback is not applied as fact.

A valid source reference does not prove a replacement's meaning. Factual, scope
and execution-status patches go directly to another verifier pass as a complete
answer, preserving the rest of the prose. They are **not automatically approved**.
The existing maximum of two reviews remains: a new factual patch on the second
pass cannot earn a third review or bypass approval. Only strictly equivalent
presentation changes can finish without another semantic pass. If no approved
answer remains within the budget, the existing unavailable response still applies.

Personal and business writes retain their full proposal review and application
execution policy. The read-answer patch shortcut is disabled for these flows.
No formatter, source reference or reviewer suggestion can dispatch a write or
turn an uncommitted preview into a successful receipt.

## Runtime context and research limits

Tool results carry remaining total/family call allowances, remaining evidence
bytes and a `research_remaining_ms_at_observation` snapshot. The application
persists each step's observed time budget so replay reconstructs the same model
input; the actual research deadline is still enforced at runtime. Formatter and
verifier inputs receive the same budget context and an application-owned
execution report. Top-level read
attempts distinguish `not_attempted`, `interrupted`, `completed`, `failed` and
`timed_out`, with direct attempt and success counts. A successful retry does not
make a different, unattempted detail read a timeout. Nested recall refreshes also
retain outcomes in recall results and accepted evidence. When there was no direct
graph call, accepted evidence produces `evidence_available`, while recorded
failures remain distinguishable from `not_attempted`. These summaries are not a
new per-record execution ledger.

A compact `working_context` accompanies relevant CRM detail, assessment and
recall results and the finalizer inputs. It keeps up to four current recorded
subjects with source references, recent user directions separately, and selected
groups. Excerpts and omissions are marked. It is an orientation aid built from
fresh authorized evidence, not another cache, access grant or saved CRM update.
The full accepted evidence ledger remains available for review. An omitted or
truncated summary field does not mean that the source field is missing.

The shared planning reference resolves the intended RFQ among same-company
records before using its current bounded brief. It preserves user corrections
and narrative requirements separately from parsed fields, then discovers
warehouses broadly on reliable area/location with unknowns eligible. Structured
shortlist assessment supplements this evidence and does not gate exploratory
recommendations. A brief already returned by detail or assessment is reused.
Public research remains optional for a specific external gap and receives no
private CRM narrative, contacts or budgets.

## Scoped, grouped recall

`recall_business_context` accepts `turn`, `group`, and either `positions` or
`warehouse_ids`. For multiple displayed client lists, an ordinal selection needs
its original `group-N`. These selectors restrict the stored selection; they
cannot introduce another warehouse. New receipts retain group-relative positions
and a source-backed CRM subject where it can be identified.

Recall freshly authorizes the requested properties and any stored CRM subject.
It preserves ordinal gaps and repeated properties across client groups instead
of substituting or renumbering them. Historical prose stays withheld when it
cannot be freshly supported. Old receipts remain readable through the existing
fallback; missing grouping or subject metadata is not invented. Public research
and old assessments are not refreshed merely by reading selected warehouses.

Oversized recall results retain bounded useful source views with evidence IDs
and explicit omitted paths. They no longer discard every evidence body merely
because the combined payload exceeds the limit. An omission is not a null fact;
the accepted source ledger remains the reference for further work.

## Validation and release boundary

Model-free regression coverage includes `answer-review.test.ts`,
`answer-finalization.test.ts`,
`business-recall.test.ts`, `recall-evidence.test.ts`,
`warehouse-fixture-contract.test.ts`, `prompt-composition.test.ts` and the graph
tests. The synthetic source now matches permissive unknown defaults, exact
category filters, bounded narrative fields and production refresh behavior;
cache-specific tests opt into evidence reuse explicitly. Shared fixture guidance
uses the same materiality rule as the live defaults.

These checks validate code boundaries and fixtures, not Luna's adherence to the
new prompts. No paid run was repeated for this pass. Earlier private captures
remain preserved under gitignored `.local/private-evals/`. Any later live/model
evaluation follows the [spending contract](42-evaluation-spend-controls.md).

Runtime changes live in `sales.graph.ts`, `answer-review.ts`,
`working-context.ts`, `business-recall.ts`, `displayed-records.ts` and
`recall-payload.ts`. Context Engine's built-in prompt defaults also align shared
caveats and bounded brief reads; separately saved prompt overrides remain
unchanged. Existing authorization, delivery checks, write grants and migrations
remain prerequisites. This document makes no claim that the checkout has been
deployed.

## 5 October follow-up fixes

The follow-up change adds a regression fix for native WhatsApp
client headings. Recognized client sections preserve their selected properties,
positions and repeated options after formatting. Unknown emphasized or standalone
headings prevent a preceding client from inheriting those properties. Ambiguous
sections retain warehouse identities/order but omit unproven CRM subject links.
Normal property fields and Pro/Con lines remain content rather than new clients.

Context Engine guidance now consistently allows provisional recommendations from
the full available brief, preserving material conflicts and uncertainty without
requiring every optional specification to be known. This applies to assessment
results, REST context/default instructions, discovery context and OpenAPI field
notes. The synthetic assessment fixture carries the same guidance, and its helper
files are now included in evaluation provenance hashes.

Whole-note deletion is recovery-only because the upstream note row and deal links
cannot be guarded atomically. Existing exact operation receipts remain readable;
new note-trash calls stop before source reads, reservation or mutation. RFQ trash
and eligible note creation undo retain their existing contracts. See
[business writes](../business-writes.md) for the boundary. No migration is needed.

The bounded Luna screen and its limits are recorded in
[the review-fix evaluation](../../evals/results/2026-10-05-review-fixes-luna.md).
It ran version `ramesh-chief-of-staff-v34` and passed one of three scenarios. The
failed traces exposed an additional repair-path issue: a fresh worker correction
could be replaced with the old rejected answer when a model formatter added dates.
The graph now consumes each fresh completed draft through deterministic formatting
and independent review; retries without a fresh draft still use synthesis. A
research deadline clears readiness rather than restoring stale draft text.

Version `ramesh-chief-of-staff-v35` also requests actual comparative synthesis
without assuming that larger metrics prove suitability, and allows related checks
within one practical next action. These post-screen changes were checked locally
with deterministic regressions; the paid screen was not repeated or relabelled as
a pass. The existing review cap and scalar/entity patch guards remain in force.
These changes require no migration or new environment settings. Deploy through the
normal main-branch pipeline; the evaluation report does not assert a live health
check.
