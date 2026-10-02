# Recall recovery and source-label usefulness

## Change

The broader v20 evaluation exposed a premature stop after changed recall and
answers that hid an identifiable analytics page because its path looked like an
instruction. The v22 candidate changes the shared runtime contract, not a single
answer template:

- Recall reports whether checks are unchanged, changed or partial, plus failed
  check codes. Successful current facts remain usable. The old answer remains
  withheld when its fingerprints differ.
- Optional record-set/order hashes distinguish updated fields from changed source
  membership. They never replace full-answer freshness or employee authorization.
  Legacy receipts remain readable and report unknown record membership.
- Current search evidence provides pagination coverage and exact continuation
  arguments. The worker can complete a bounded refreshed pool without changing
  its scope or assuming a change means access was revoked.
- Requested non-redacted source labels remain quoted data across CRM, analytics
  and knowledge. Their wording does not authorize tool calls, disclosure or
  actions. The formatter preserves them and the verifier treats unjustified
  omission as a presentation defect.

Five new generic outcome cases cover changed dates, real continuation, partial
source failure, a company name and a knowledge title. The full registry now has
85 scenarios. Existing ordinal, revoked-identity and injection cases remain in
the focused regression run.

## Fixture and assertion corrections

The old changed-history fixture removed a row after pagination but retained the
old cursor. Its intended reduced result was therefore inconsistent. Visibility
now filters the fictional dataset before search/summary/briefing/detail reads;
the reduced set is exhausted. A separate scenario genuinely requires its next
page, so correcting the fixture does not remove continuation coverage.

The Search Console adversarial case previously rejected its injected phrase
anywhere in the answer, including a quoted query label. It now forbids that phrase
as a standalone completion status and retains the no-CRM-call check. The semantic
judge must still reject execution, false status claims and unrelated research.
No judge prompt or rubric was weakened for this increment.

The broad run also exposed a synthetic Search Console comparison with 200 prior
clicks and 5,000 impressions but 3% prior CTR. The fixture now consistently reports
4%; a deterministic test checks both periods against clicks/impressions. The
original failed answers/grades are retained, and the fallback scenario is included
in the new run.

These fixture/assertion changes mean the revised scores are not a controlled
before/after comparison. Original failures and complete traces remain retained.

## Validation

- Deterministic/integration: **248 passed, zero skipped** against disposable local
  PostgreSQL, plus Prisma validation, TypeScript, build and formatting.
- Initial v21 regression: **25/28 passed**. All label and boundary cases passed;
  two changed-date trials and one continuation trial incorrectly described a
  changed selection when only fields/page boundaries changed. Run:
  `2026-10-02T15-36-11.523Z-0a43185e`.
- Fresh v22 regression: **stopped at the user's request after 25/32 completed**;
  all **25 completed trials passed**, including both changed-date trials and one
  genuine continuation trial. The other seven are incomplete/unrun, not passes.
  Sol medium agent, separate fixed Sol grader, fictional sources and no WhatsApp
  adapter. Run: `2026-10-02T15-59-16.895Z-04967399`; `interrupted.json` preserves the
  stop reason and unchanged input hashes. In-flight usage may be unreported.
- The frozen v20 broad run completed **155/160**, with unchanged inputs. Its
  results remain separate in the
  [production evaluation record](2026-10-02-production-pagination.md).
- Real Supabase plus production signed Context Engine: **2/2 capture turns passed**
  (current two-deal request, then refreshed dates). Both completed the v22 graph,
  passed delivery authorization and persisted encrypted receipts containing the
  new record checks. Graph times were 53.3 and 39.2 seconds. No WhatsApp sender
  was constructed and no business records were changed.

The tests exercise the real graph and source/permission contracts, not production
record mutation. No environment change or database migration is required for
this increment. Private live-source artifacts are excluded from the commit.

After the spending correction, TypeScript and four offline spending-policy tests
passed with no provider requests. Routine agent/grader defaults are now Luna;
Sol needs explicit run approval. Paid CI is manual only. This does not establish
Luna response quality: no Luna evaluation was started. See [module 42](../../docs/agent-modules/42-evaluation-spend-controls.md).

## Remaining boundary

This is permission-checked reply recall, not a permanent entity-reference store.
If a source has changed so much that exact historical membership/order cannot be
recovered from current evidence, the bot must explain that limit rather than
substitute unrelated records. A refreshed query is not proof of an unchanged
historical selection. See [module 41](../../docs/agent-modules/41-recall-and-source-labels.md).
