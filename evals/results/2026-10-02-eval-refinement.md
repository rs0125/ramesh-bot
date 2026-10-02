# Evaluation, voice and harness refinement, 2 October 2026

The current assistant is `ramesh-chief-of-staff-v19`, tested locally with
`gpt-6.1-sol` and medium tool reasoning. The application checks pass **223/223**
with no skipped tests. Voice batching passes the API and browser capture checks.
The full stochastic release gate is **not claimed green**: the latest complete
agent execution is v18, and v19 has targeted validation only. Judge-only scores
below do not represent new agent executions.

This follows the [graph/media baseline](2026-10-02-sol-graph-media.md). Runtime,
fixtures and grading changed during refinement, so these runs are not a controlled
trend in model quality. Every failed, interrupted and superseded run is retained.

## Runtime and tool fixes

- Reserve up to 60 seconds, at most one quarter of the request deadline, for
  formatting and verification. Retain successful evidence and completed-stage
  metrics when research exhausts its budget. Hard cancellation remains effective.
- Preserve scheduling cutoffs, work duration, latest supported notes and useful
  provisional advice. Verification flags do not prove the client never confirmed
  a requirement. Offer a useful first step before asking an overwhelmed user for
  more information.
- Correct native-date parsing when a valid date ends a sentence, including month
  abbreviations with periods. Wrong dates and ambiguous alternatives still fail.
- Make group refusals point to DM without asserting an unverified identity solely
  because the request arrived in a group. Bound manual analytics observations to
  the returned rows. Knowledge citations use readable titles and source dates;
  internal API paths are not user-facing links.
- Document generic [tool extension boundaries](../../docs/agent-modules/34-tool-extensibility.md).
  New reads and document tools need execution/evidence adapters. Writes need
  authority, idempotency, reconciliation and postcondition checks; replaying a
  write as though it were a read would repeat its effect. No write tools enabled.

## Evaluation fixes

The synthetic clock is fixed, and date-query equivalence uses the source calendar
and intended date field. Case-insensitive filters are accepted only where the tool
schema documents that behavior. Assigned scope stays strict. Missing-date and
query/page fixtures now give consistent results across retrieval routes. Outcome
cases accept legitimate alternative tools while security contracts remain exact.

Every delivered turn has indexed continuity, grounding, formatting and usefulness
verdicts with concrete findings. A good final answer cannot erase an earlier bad
answer. Run metadata hashes prompts, fixtures and source inputs before and after
execution; source mutations invalidate a run.

Review exposed two grader leaks. A whole-conversation judge demanded future work
in earlier replies. Even isolated-turn calls leaked later corrections through the
shared journey description. Some calibration descriptions also hinted at the
expected verdict. The current public judge receives only preceding dialogue,
current evidence/permissions/schemas and the shared rubric. Legacy case
descriptions and expected labels stay outside the model call. Explicit per-turn,
verdict-free rubric arrays are supported by the helper. Unit tests verify those
boundaries and aggregation of earlier failures.

Blind calibration compared the same 28 cases twice: **Terra 54/56; Sol 56/56**.
The public conversation, calibration and regrade runners now default to Sol.
Historical model-comparison and private runners preserve their recorded judge
settings. Sol judging Sol is a separate call, not an independent model family;
human calibration and a held-out set are still needed.

## Retained runs

| Run                                     | Result                       | Meaning                                                                           |
| --------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| Initial v17 focused                     | 18/22                        | Four failing trials retained; filter/tool-contract and grading defects reviewed   |
| Initial calibration                     | 36/36                        | 18 authored examples, two trials each                                             |
| Expanded calibration                    | 42/42                        | Added bounded row inference, unseen-variant overclaim and schedule equivalence    |
| Refined v17 focused                     | 6/6                          | Three repaired scenarios, two trials each                                         |
| Interrupted v17 full                    | 17/18 completed; 148 planned | Stopped for deterministic native-date parser defect; not a full-suite score       |
| **Complete v18 agent run**              | **138/148**                  | 74 scenarios, two trials each; frozen inputs                                      |
| Private v17 real-data run               | 10/10                        | Actual Supabase/Context Engine; isolated captured delivery                        |
| Expanded whole-conversation calibration | 52/52                        | Did not establish general judge reliability                                       |
| First v18 judge-only regrade            | 137/148                      | Same agent answers; prompt changes alone did not fix temporal grading             |
| Fresh v19 targeted agent run            | 15/18                        | Nine selected scenarios, two trials each; three original judge failures retained  |
| Private v19 targeted case               | 1/1                          | Current native dates and ordinal follow-up; not a fresh complete private suite    |
| Initial isolated-turn calibration       | 52/52                        | Shared journey descriptions still reached the judge                               |
| Initial isolated-turn v18 regrade       | 140/148                      | Same retained answers; future-rubric leakage still found                          |
| Initial isolated-turn v19 regrade       | 18/18                        | Same 18 targeted answers                                                          |
| Intermediate scoped-rubric calibration  | 55/56                        | Exposed a remaining hint in a one-turn calibration description                    |
| **Blind Terra calibration**             | **54/56**                    | Legacy descriptions and expected labels withheld                                  |
| Blind Terra v18 regrade                 | 136/148                      | Diagnostic; grader disagreements remain                                           |
| Blind Terra v19 regrade                 | 18/18                        | Targeted retained answers only                                                    |
| **Blind Sol calibration**               | **56/56**                    | Same blind cases/rubric as Terra                                                  |
| **Blind Sol v18 regrade**               | **142/148**                  | Selected judge, unchanged v18 answers; not a new v19 full run                     |
| **Blind Sol v19 regrade**               | **18/18**                    | Selected judge, unchanged targeted v19 answers                                    |
| Repository checks                       | 223/223                      | Disposable PostgreSQL 17; none skipped; Prisma, typecheck, build, formatting pass |

All completed main runs and regrades in this table have their retained input
integrity results. The final Sol regrades have `inputIntegrity: true` and input
hash `aab9cb9f4f737ea9e7f6d7d429bc17736dee2c28e39960b1269fe8fa55b87672`.
The blind judge prompt hash is
`cdddc70d39227e8e02ecdf295bd23b74f86de33238e82165e81506a30f3c957c`.

The final v18 regrade flags six trials: changed-history usefulness, one
partial-source analytics answer, two injection-containing landing-page labels,
warehouse-list formatting, and the old group identity wording. These require
adjudication, not automatic claims of six confirmed application defects. For
example, the warehouse verdict demands native CRM dates on warehouse cards,
although that rule applies to CRM listings. The group wording was repaired in v19
and passes its targeted trials. Source/permission gates are never overridden by a
judge's preferred answer.

### Artifact identifiers

All paths below are relative to ignored `.local/`; raw reports are not pushed.

- `v17-focused/2026-10-02T10-02-59.010Z-82bee847`
- `judge-calibration/2026-10-02T10-02-56.952Z-329a916d`
- `judge-calibration/2026-10-02T10-15-40.788Z-0cad146e`
- `v17-refined-focused/2026-10-02T10-15-41.170Z-c99fc7cf`
- `ci-evals/2026-10-02T10-18-48.058Z-cf60e4d5` (`interrupted.json` retained)
- `ci-evals/2026-10-02T10-30-32.209Z-49c60de2`
- `private-evals/runs/2026-10-02T10-16-45.102Z`
- `judge-calibration/2026-10-02T11-18-23.627Z-abb83550`
- `regrades/2026-10-02T11-21-11.300Z-292c6ae9`
- `v19-focused/2026-10-02T11-21-10.991Z-55c2a8aa` (unchanged public copy under `ci-evals` for regrading)
- `private-evals/runs/2026-10-02T11-23-35.419Z`
- `judge-calibration/2026-10-02T11-31-03.587Z-750cc6a8`
- `regrades/2026-10-02T11-40-07.573Z-508c097a`
- `regrades/2026-10-02T11-40-12.023Z-58053291`
- `judge-calibration/2026-10-02T11-51-50.625Z-4f125fd7`
- `judge-calibration/2026-10-02T11-55-12.979Z-e265228d`
- `regrades/2026-10-02T11-56-41.771Z-115a789f`
- `regrades/2026-10-02T11-56-46.007Z-0e5b7022`
- `judge-calibration/2026-10-02T12-02-20.894Z-bded1cb8`
- `regrades/2026-10-02T12-06-07.568Z-fd1cce2b`
- `regrades/2026-10-02T12-06-12.339Z-efad3c60`

## Voice delivery and model comparison

The old logistics bot's OpenAI STT credential is reused through independent
`OPENAI_STT_API_KEY` configuration. The Responses credential remains separate.
`OPENAI_TRANSCRIBE_MODEL` selects the transcription model independently of chat.
No key is stored in tracked files or browser configuration.

Delivery reads the exact STT text from encrypted, same-owner, unexpired media and
quotes it in italics before the assistant answer. Multiple voices are labelled in
inbound order and followed by one common response. Generated-answer style cleanup
does not rewrite the transcript. Exact quotation means exact STT output, not a
guarantee that recognition matched the original audio. Long transcripts are
explicitly labelled excerpts; missing/expired transcripts are not fabricated.

Durable message payloads store references and the answer, not a second permanent
copy of the transcript. Normal later replies can use eligible media context
without quoting the same notes again. Forwarded audio uses the existing sliding
3-second burst window and 8-second maximum collection time.

The final API smoke passed **10/10 checks**: one captured batch, three exact
ordered quotes, common response, no private owner metadata, no repeated quote on
follow-up, and successful follow-up use of media. The browser passed **8/8 checks**
with four user messages, one assistant reply, three actual italic DOM elements and
zero browser errors. All test delivery stayed in Supabase capture queues; Baileys
was not instantiated. Artifacts remain in `.local/media-smoke/`.

The first live smoke exposed an API serializer dropping transcript metadata; that
boundary was fixed and has an integration regression test. The original failed
smoke log was retained before the successful rerun.

The [STT comparison](2026-10-02-stt-comparison.md) retains all 24 API trials across
three models. Every model passed English checks and failed the poor synthetic
Hindi/mixed cases. This does not rank accuracy on real Hindi/Hinglish audio.
`gpt-transcribe` is a compatible, lower-priced candidate based on current published
features/rates, but runtime STT remains `gpt-4o-transcribe` pending representative
human-audio evaluation.

## Production evaluation follow-up

The [primary-source review](../../docs/agent-modules/37-production-evaluation.md)
compares Anthropic, OpenAI and LangSmith guidance with this implementation. The
next investments are employee-labelled holdouts, adjudication of judge errors,
required release decisions and sampled production review. The existing paid
workflow is manual/opt-in weekly and does not block every deployment. The code
checks, private capture tests, calibration set and fictional journeys measure
different risks; none alone certifies production quality.
