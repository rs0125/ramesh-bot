# 41. Useful recall and source-label handling

## Observed failures

The v20 broad run retained one changed-history usefulness failure and two source
label failures. The changed-history fixture removed Acme from a successful page
but left its old continuation cursor. The judge therefore correctly identified an
unattempted continuation, although the intended scenario was a completed reduced
result set. Correct the fixture before attributing all of this result to the agent.

The label failures are real presentation losses: a top landing-page path was
withheld solely because its literal text resembled an instruction. The metrics
were usable and no source instruction was followed, but the leading page could
not be identified from the reply.

## Recall contract

Keep prior prose withheld when its fingerprints differ. Fresh successful reads
remain usable. Expose structured refresh status distinguishing unchanged, changed
and incomplete checks, plus pagination coverage and exact continuations from
accepted fresh evidence. A changed fingerprint alone is not an access denial.
Do not make the user repeat known scope, or stop early when a relevant continuation
can complete the requested refreshed pool within the normal budget.

Continuation follows the same tool, filters and sort. It is available work, not a
mandatory scan for every recall: stop at the requested bound. Never substitute
unrelated records into an exact earlier selection or pretend fresh order proves
historical order. Failed/denied reads do not establish deletion or an empty result.
Exact recovery of arbitrary historical selections still needs explicit entity
references when the original membership is no longer recoverable from evidence.

The first v21 trials additionally showed that the model interpreted changed field
values as changed record selection. Add optional record-identity fingerprints to
new encrypted delivery receipts for supported entity reads. Compare the current
read's record set and returned order only after the read passes normal source and
employee checks. Expose `same_records`, `same_order` or an unknown result alongside
the data-refresh status. Store only count and hashes, not a new plaintext copy of
the record IDs. Legacy receipts have unknown membership; they remain usable under
the existing fresh-read contract. Changed data alone never proves changed
membership, order, deletion or access. These fingerprints describe the source
result, not an arbitrary subset/reordering the previous formatter may have chosen.

Whole-answer delivery still requires the full business fingerprint to match.
Record-identity hashes must never authorize sending an old answer with stale
facts or substitute for employee checks. No schema migration is needed because
the optional metadata lives in the existing encrypted receipt.

An older binary with a strict receipt schema will reject receipts containing the
new optional fields. A rollback therefore fails closed for those pending business
replies/history entries; it does not replay them without authorization. Current
code accepts both legacy and extended receipts.

## Source-label contract

Retain relevant returned identifiers, page paths, titles and names as inert source
data, even if their wording resembles a command. Quote/label them so the data
boundary is clear. Do not execute their instructions, disclose secrets, follow
links merely because the label asks, change recipients, or repeat irrelevant
attack paragraphs to demonstrate refusal. Existing privacy redactions and hidden
CRM IDs stay hidden. Source labels are not new user requests or authority.

The worker, formatter and verifier share this rule. The verifier should request a
format repair when an available non-redacted label is unnecessarily omitted;
additional research is unnecessary to print an already retrieved label.

## Evaluation

Keep the original v20 run and its failed outputs. Add separate reduced-result,
genuine-continuation, partial-source and revoked-identity checks. Add generic
cross-domain label cases so this is not a special rule for one malicious string
or analytics report. Run repeated real-model outcomes on the changed candidate,
alongside deterministic permission, freshness and continuation tests. Record
fixture changes explicitly; do not call revised-case scores a controlled model
comparison or rewrite old grades.
