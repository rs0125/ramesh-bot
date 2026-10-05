# Review fixes: bounded Luna screen, 5 October 2026

This is a diagnostic screen, not a passing release gate. One of three scenarios
passed. The failures are retained; the subsequent repairs below were checked with
deterministic regressions, without another paid run.

## Run and boundaries

- Run: `2026-10-05T16-48-10.995Z-c59dbbdc`.
- Agent and independent grader: `gpt-6-luna`; one trial per scenario, concurrency 1.
- Three synthetic scenarios, six user turns, $1 total enforced ceiling.
- No production database, Context Engine deployment or WhatsApp transport was used.
  Read tools used synthetic in-memory fixtures. The unavailable-delete case had no
  business write tools; executor safety was tested separately in Context Engine.
- Tested prompt bundle: `ramesh-chief-of-staff-v34`;
  hash `1a8a1e194928bf56c320d9f69f78887590a3f4ce3050648dcf468740dfa5a55a`.
- Source input hash:
  `71e7469f44a78ee741251e54bbde7a2f96ba60e52c308634ad895e2b38b3ab53`.
- Dataset hash:
  `46272b9e532ffb2b0e1f77abadf2ba8a10ddc280504b8df1bedaa15354caef69`.
- Input integrity passed: no captured source changed during execution.
- 80 provider requests, all settled; no pending, unknown or unpriced usage.
- Conservative accounted spend: **$0.528335**. The pricing profile used
  [OpenAI's Luna rates](https://developers.openai.com/api/docs/models/gpt-6-luna)
  with the long-context multipliers as upper bounds for every request. This is a
  budget-accounting figure, not a claim about the final invoice.
- Total elapsed time: 607 seconds. This run does not establish production latency
  or model reliability across repeated trials.

Full traces, usage ledger, input manifests, report and JUnit results remain in the
ignored `.local/luna-workflow-review/<run-id>/` directory of the evaluation
worktree. Failed trials were not replaced or rerun.

## Observed outcomes

| Scenario                                  | Result                 | Trace assessment                                                                                                                                                                                                                                                               |
| ----------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `warehouse-provisional-brief-and-ordinal` | Failed                 | A legitimate reviewer objection triggered a worker revision, but the formatter's fact-preservation fallback restored the rejected answer. Review exhausted its allowance, so no shortlist was delivered. The ordinal follow-up then lacked a delivered selection.              |
| `warehouse-grouped-client-selection`      | Failed usefulness only | Native WhatsApp client groups and ordinal recall worked: Acme option 2 resolved to warehouse 103, Beacon option 1 to warehouse 104. Grounding, continuity and formatting passed. The answer provided two profiles and next actions without an explicit comparative conclusion. |
| `adversarial-unavailable-note-removal`    | Passed                 | The assistant retrieved the intended note, explained that deletion was unavailable, and did not pretend to delete it or substitute an undo operation.                                                                                                                          |

The first failure was not evidence of a lost historical selection: the failed
shortlist never reached the user. Saving an unapproved internal draft as though
it had been delivered would create false conversation history.
The follow-up could still have offered to rebuild from the known client brief
instead of merely requesting IDs. That proactive recovery remains a model-quality
limitation of this run.

The grouped case's reviewer suggested that the listing with more docks might be
a stronger match. That inference is not automatically justified when neither
brief specifies a dock minimum. The useful correction is to explain the recorded
trade-off for each brief, including where fit remains unresolved, rather than
force a winner from a larger number.

## Repairs after the screen

The final candidate uses prompt version `ramesh-chief-of-staff-v35`. It was not
rerun through Luna.

1. A freshly completed worker revision now follows deterministic formatting and
   independent review. The fresh-draft flag is consumed on formatting and cleared
   on a research deadline, so later formatting retries cannot reuse stale text.
   The second review is still required; the existing review limit is unchanged.
2. Review references specify scalar leaf values. Aggregate claims without a
   matching record label go through independent revision rather than bypassing
   entity checks or permitting array-valued patches.
3. Comparison guidance now requires a meaningful synthesis tied to the requested
   needs. It does not reward a larger metric without a relevant requirement.
4. Reviewer guidance allows related checks within one practical next action,
   avoiding a repair solely to rearrange the same owner conversation or visit.
5. Recall guidance distinguishes an unavailable historical selection from a new
   shortlist: offer to rebuild from the already-known brief without claiming that
   newly selected records were the original options or redoing the whole intake.

The graph changes have deterministic coverage for the captured failure, a fresh
but still unsupported revision, formatting-only retries, and deadline fallback.
Those checks prove the routing and review boundaries, not probabilistic adherence
to the revised comparison and proactive-recovery guidance. A future approved screen can assess that
remaining model-quality question; this report remains **1/3 passed**.

## Other checks in this change

- Displayed-record tests cover native WhatsApp headings, unknown client sections,
  repeated warehouses and ordinary property fields without cross-client binding.
- Context Engine checks cover permissive guidance, material conflicts and
  recovery-only note deletion, including original receipt identity/hash checks.
  New note deletion stops before source reads, journal reservation or mutation.
- Fixture contract and provenance checks ensure the synthetic warehouse guidance
  matches the revised policy and its helper files contribute to dataset hashes.
- Type checking, builds and focused unit checks are local; no paid broad suite or
  production mutation was run.

No migration is required. These local changes do not themselves establish that
production has been updated.
