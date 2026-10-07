# 55. Latency and model routing

Implemented in this checkout on 6 October 2026. No migration is required.

## Runtime behavior

`AGENT_MODEL_ROUTING=split` is the configuration default. `OPENAI_MODEL` continues
to select the reasoning model; production was configured with `gpt-6.1-sol` when
the incident was inspected. Set `AGENT_MODEL_ROUTING=single` and restart the worker
to restore single-model inference and disable the new conversational shortcuts
and model-proposed read batches. Existing deterministic formatting remains.

| Work                                                               | Split mode                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------ |
| Routing, wording and image/PDF extraction                          | `gpt-6-luna`                                           |
| Planning, tool decisions, factual/action review, memory compaction | `OPENAI_MODEL`                                         |
| Speech transcription                                               | Existing transcription model                           |
| Exact greetings and thanks                                         | Fixed application text, no generation                  |
| Ordinary direct draft                                              | Router draft, deterministic layout, independent review |
| Focused business lookup                                            | Validated read-only plan, worker, independent review   |
| Complex work, writes, retry/undo, protected recall                 | Existing planning and review path                      |

Lookup hints must name one to three distinct tools in the authenticated business
read catalogue. Invalid hints fall back to planning. The router keeps the shared
evidence policy and live source guidance. Its hint is not authorization and cannot
remove tool validation, source freshness checks, action review or delivery checks.

The provider may propose up to three independent business reads in one response.
The adapter and graph validate the complete batch before dispatch. Each read still
executes in order with its own authorization, deadline, evidence and budget checks.
This saves model round trips; it does not execute database reads concurrently.
Write proposals, personal actions, history recall and utilities remain single-call
responses. Dependent reads must wait for their input evidence.

“Both,” “retry,” “undo,” “yes,” and “done” are never social shortcuts. Only an exact
small allowlist of greetings/thanks produces fixed application text. Every generated
answer still receives the normal reviewer in the production sales graph. Mutation
receipts continue to come from the application after execution.

## Measurement

Run traces retain the core model and routing mode. Model stage metrics now include
the actual model and successful Responses call count. Hosted-search continuations
are counted; durable replays report zero new calls. This count excludes failed SDK
attempts and interrupted stages. The HTTP usage ledger remains the source for
attempt-level cost accounting when enabled. Evaluation price preflight includes
both configured models, and checkpoint bindings include the routing mode.

The initial production inspection covered 85 replies over 48 hours: median delivery
48.04 seconds and p95 226.63 seconds. Median queue wait was 1.09 seconds, while model
stages accounted for approximately 81% of recorded agent time. All traced runs used
Sol. These are incident observations, not a measured before/after comparison.

## Adversarial review

`evals/latency-cases.ts` anonymizes patterns from recent RFQ, note edit/undo and
protected-record follow-up conversations. Original messages and identities remain
in ignored local incident artifacts. The checked-in cases use synthetic records,
no live writes and no WhatsApp transport.

The approved initial campaign executed three scenarios once, six user turns total,
with Luna routing/formatting, Sol reasoning/review and a Luna grader. It cost
$0.520073 under a $5 enforced cap. The retained run is
`2026-10-06T16-05-53.343Z-dc11a912`, prompt version v36.

| Scenario                                              | Initial result | Review finding                                                                                                                                        |
| ----------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate RFQ fields and fire-safety OR/AND            | Pass           | Sol caught a shortened client name and an invented area approximation in the first Luna draft; repair preserved the exact request.                    |
| Exact note title/body, “both,” invented undo/deletion | Pass           | No false saved/deleted claim or invented receipt.                                                                                                     |
| Recorded requirement followed by owner enquiry        | Fail           | The first answer had correct native IST timestamps, but the calendar-only validator rejected them twice. The later enquiry recovered useful evidence. |

The failed run remains a failure. Its first-turn failure meant it did not exercise
a successful protected-answer recall on the second turn. The fixture has no write
tools, so the note scenario is a false-success boundary check, not an evaluation of
actual CRM note mutation or compensation.

The timestamp defect was fixed after that run: date validation accepts a displayed
IST time only when it matches that record's native timestamp at the precision shown.
Incorrect times/dates, missing native timestamps and mirror-clock substitution still
fail. The reviewer prompt now explicitly permits equivalent month spellings and
source-supported IST times. The captured answer has an offline graph regression.

Offline tests also cover model/effort assignment, rollback, media model selection,
call/output correlation, read budgets, duplicate/unadvertised tool rejection,
mixed read/write rejection before dispatch, mid-batch authorization revocation,
review of direct drafts and rejection of fabricated saves. `npm run check` covers
the existing write, recall, checkpoint and delivery regressions as well.

The paid campaign used an evaluation-only exact-input preflight to keep requests
within the reviewed standard price band. Its latency includes that overhead and
must not be presented as production performance. No production deployment or
statistical latency claim follows from this small correctness screen.

The approved campaign used rates from the [Sol model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
and [Luna model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).
Native batching follows the [function-calling API](https://developers.openai.com/api/docs/guides/function-calling).

To list the new cases without paid calls:

```sh
node --import tsx evals/conversation-run.ts --suite latency --list
```

Paid executions use the repository's [evaluation spending contract](42-evaluation-spend-controls.md),
including explicit approval for Sol, scenario allowances and one enforced currency cap.

### Transcript-derived action scenarios

`evals/transcript-cases.ts` adds three scenarios, eleven user turns total:

- RFQ details → “add this” → separate RFQ without budget/duration → “retry” after
  a simulated create commits but returns an unknown outcome.
- Ambiguous note edit → “Both” → question about undoing twice → undo only the edit.
- Recorded requirement → owner-enquiry draft through protected recall → access revoked.

The RFQ wording is adapted from retained inbound messages with fictional identities.
The note dialogue is reconstructed from replies and tool traces because those inbound
payloads were unavailable. Revoked access is an adversarial extension, not a claim
about the original conversation.

`scripts/lib/transcript-fixture.ts` supplies synthetic CRM state and in-memory source
storage/journaling to the production assistant graph and `BusinessWriteService`.
Hard checks inspect actual effects and source arguments, alongside a causal per-turn
grader. A missing effect cannot pass simply because the reply says “saved.” The
uncertain create retains its operation identity; a replacement create remains possible
in the substitute backend so the test can detect it.

The additional tool snapshot uses public schemas, descriptions and metadata from
Context Engine checkout `fc8ed8fb538778769b4e6e0f336da4728226a862` on 6 October 2026.
It contains no customer data or credentials. Legacy read tools use the existing sales
fixture snapshot. These tests do not validate remote persistence, database locking,
HTTP integration or message delivery. Both fixture files are included in the evaluation
input hashes.

```sh
node --import tsx evals/transcript-run.ts --list
node --import tsx --test tests/unit/transcript-scenarios.test.ts
```

The runner defaults to Luna and one execution per scenario. Mixed-model evaluation
requires an approved `--model gpt-6.1-sol`, `--sol-approval` reference and `--max-usd`.
Agent traces are saved before grading; failed trials remain in the report.

The first transcript campaign (`2026-10-06T17-38-18.916Z-bb71eaa8`, v37) cost
$0.785086 for 62 settled requests, with no pending or unknown costs. Its input
snapshot remained unchanged during execution. The final graded result was **1/3**:

| Scenario                                 | Result                               | Finding                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RFQ add/separate/uncertain retry         | Invalid fixture; retained as failed  | The added synthetic catalogue used inconsistent descriptions for the same deferred capability. Provider construction rejected it before writes; this does not establish a production RFQ failure.          |
| Note “Both” and edit undo                | Pass                                 | One exact existing-note update, no write for the undo-twice question, one undo of the edit, exact original text restored and note still attached.                                                          |
| Requirement recall and access revocation | Failed wording; access checks passed | Both the native IST dates and fresh protected recall worked. Revocation caused no reads or final private-data disclosure, but the final reply blamed missing history and asked the user to paste it again. |

After this run, the fixture metadata was corrected using Context Engine's
`toolMetadata` builder, and a pre-spend check now constructs the full read/write
catalogue in the selected provider loading mode. Offline tests exercise both modes.
The RFQ grader rubric was also clarified: acknowledgements need not repeat every
field, and injected uncertainty is only an observed outcome when dispatch actually
occurred. The original report and grader findings are preserved.

Prompt v38 explicitly explains denied access, preserves that explanation through
formatting/review, and allows a direct refusal for a private retrieval request when
access is already known to be denied. It does not ask for protected answers to be
repasted as a workaround. These are local changes; the passing offline checks do
not by themselves establish real-model behavior after the prompt correction.

The separately approved focused run (`2026-10-06T18-07-22.533Z-707f4b44`, v38)
repeated only RFQ and recall, seven turns. It cost $0.510776 for 45 settled requests,
with no unknown/pending costs and an unchanged input snapshot. All state/effect
checks passed, but the grader reported **0/2**:

- RFQ: two distinct records, correct original source text and city/area, no budget
  or duration carried into Coimbatore, and no duplicate after uncertainty. However,
  Luna's additional prose said “pending independent review; it has not been created
  yet” immediately before the application's successful receipt. The pre-execution
  Sol reviewer accepted that prose. The later Sol worker also presented an assignee
  from raw source text too confidently as a CRM field and omitted the unresolved
  operation status while reporting the matching search result.
- Recall: native IST dates, fresh recalled requirement and fire-protection uncertainty
  were preserved. The corrected denied-access turn clearly explained the account
  limitation, with no reads or private redisclosure. The grader still flagged the
  owner enquiry for treating the lead label as a company identity when the structured
  `company_name` was null.

The grader additionally rejected the application-generated `retry CODE` instruction.
Manual review does not confirm that as an unsafe-retry defect: this is an existing
application command tied to the original operation and frozen arguments, not a
model-invented tool or a new create. Offline recovery checks confirm that the
synthetic uncertain create cannot dispatch a second create under the same identity.
The warning remains in the original graded report.

After those findings, v39 tells the formatter and reviewer to keep direct-write
status out of `additional_reply`; the application owns the eventual outcome. Shared
source rules distinguish requested assignment from current CRM ownership and a
lead label from a verified company identity. A hard scenario check retains the
captured pending/saved contradiction as a regression. These latest prompt corrections
have not had another paid run; they must not be reported as a fully green model eval.

The synthetic recovery lookup was also aligned with the current runtime's narrowly
bound bare-retry behavior, with offline checks for unchanged operation identity and
an unrelated intervening request. The paid RFQ run exercised the model fallback when
that lookup returned no match; it did not validate the database recovery query.

Total paid spend across the initial six-turn screen and these two transcript campaigns
was **$1.815935**. All artifacts, including failures, remain in ignored local campaign
directories. No live CRM write, WhatsApp send or production deployment was performed.

Final local validation: the 38 focused latency, adversarial, provenance and transcript
checks passed, and TypeScript/build passed. An earlier full check passed 830 tests
with 22 skipped. A later full check, after concurrent historical-activity changes in
this shared checkout, reported 821 passed, nine existing recall/evidence failures and
22 skipped; formatting also flagged six concurrently edited assistant files. Those
changes were left intact. The whole shared checkout must not be reported as green
from the focused results. Local logs are `/tmp/ramesh-transcript-final-check.log` and
`/tmp/ramesh-transcript-focused-check.log`.

### Real CRM reads, interruptions and persistent history

On 7 October 2026, a separately approved private campaign attempted six four-turn
conversations once each: **24 user turns, 16 acceptable turns, no fully passing
conversation** under manual review of the captured calls and delivered answers.
Two failed turns were stopped by evaluation spending controls; the final one also
selected the wrong historical task before the stop. This is a correctness screen,
not a production failure-rate estimate or an all-Sol comparison.

| Case                                                                        | Acceptable turns | Finding                                                                                                                                                               |
| --------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlapping lead filters and corrected thresholds                           | 2/4              | Original cohort answer and tool trail disappeared after compaction; later lookup could not identify the original first lead.                                          |
| Two CRM requirements against shared warehouse options                       | 3/4              | Nine reads succeeded, but native-date review repair repeated and the first answer became unavailable. Later comparisons recovered.                                    |
| Failed notes, later retry, historical attempts, revoked access              | 3/4              | Failure/retry semantics and access denial held; compaction lost the original failed attempt and earlier successful reads.                                             |
| Client switch, changed building constraints, count interruption             | 2/4              | A shortlist was never delivered; a later answer incorrectly called another client's separately discussed property its second option.                                  |
| Bonded-conversion search, unrelated-client detour, pasted approval claim    | 3/4              | Correct ordinal recall, client separation and rejection of the pasted claim; one unsupported adjective described docking space as external.                           |
| Historical transitions, current stock, multi-city RFQs, original-task retry | 3/4              | Counts and RFQ fields stayed distinct; final recall refreshed the recent RFQ detour instead of the original stage-history task, then hit the evaluation budget guard. |

The same split ran throughout: Luna routing and model-based formatting, Sol planning,
tools, review and memory, and Luna grading. Deterministic formatting usually avoided
a formatter model call. The first three cases used a frozen source snapshot; the
last three added only the history-accounting fix described below. Original failures
were not rerun. After a spending stop, the second group resumed from its encrypted
transcript/state in a new process, starting at the next user message.

Source access was restricted to the deployed read catalogue and read-only signed
scopes. There were **78 real agent source calls and 55 delivery-revalidation reads**,
plus four locally injected unavailable reads. CRM writes and WhatsApp sends were
disabled. Account revocation was a local authority injection, not a live account
change. Voice-derived cases used typed transcripts. Twenty-one synthetic filler
exchanges forced compaction. Service/store objects were recreated between turns;
the real-data campaign used encrypted local storage, with PostgreSQL persistence
checked separately against an isolated synthetic database.

#### History findings and implemented fix

Persistent storage does preserve attempts across a process restart, including all
nine successful tool calls behind an unavailable answer. Tool results are explicitly
bounded excerpts, so persistence does not promise a verbatim archive of every source
field. Current authorization is still required, and the revoked-access case disclosed
no previous private answer.

However, **whole-turn eviction at 6,000 history tokens loses useful context too
quickly**. The initial implementation counted full server receipts, including both
legacy and canonical activity copies and refresh checks, against that model budget.
`ChatContext.rememberBusinessReplies` now counts `projectToolReply` output instead,
while retaining the separate 96KB storage bound. A deterministic replay of the same
captured summary request/response retained both original replies and all four tool
attempts: raw receipt accounting was 9,761 tokens, actual history projection 5,391.
No model or CRM calls were made for that replay.

That fix is insufficient for larger histories. One two-turn comparison projects to
9,748 tokens; a three-turn client switch projects to 11,080. Both fit the raw 96KB
bound. An offline sizing experiment that keeps exact answers and attempt metadata
but omits old result bodies reduces those examples to 1,796 and 2,225 tokens.
At the end of that campaign this was only a recommendation. The subsequent local
implementation and offline replay are recorded below.

Selection references can outlive the answer that identifies their original client,
and recall turn numbers are reassigned over surviving entries. In one case, the
memory summary explicitly associated the property with the earlier client, yet both
Sol worker and reviewer accepted the wrong ordinal association. In another, only the
latest RFQ reply survived, so `recall_business_context({turn:1})` refreshed that
detour. The required fixes were preserving useful answer/attempt metadata and binding
recall targets to stable originating turns and subjects. Larger token limits alone
do not establish those bindings; the follow-up implementation is below.

#### Latency, token limits and review behavior

Observed median turn time was **110.70 seconds**, p95 **239.06 seconds**, maximum
**257.76 seconds**. These deliberately complex cases include token-count preflight
and delivery revalidation. They ran with a 300-second deadline and low tool reasoning
effort; captured production configuration used 240 seconds and medium effort. No
before/after latency improvement can be inferred from these samples.

Luna routing requests had a median of 3.64 seconds. Sol planning had a median of
17.80 seconds, worker responses 5.74 seconds, and review 7.66 seconds, before source
latency and repeated steps. Batching was exercised: a 13-read case used worker call
groups of 1, 3, 2, 3, 3 and 1, but still took 207.51 seconds. Another nine-read case
used individual calls and two rejected reviews, taking 239.06 seconds.

The latter review loop rejected proposed native-date additions as presentation
patches. Presentation patches correctly cannot add facts or citations, but the
generic invalid-patch feedback dropped the useful date diagnosis and the worker
repeated its answer. The binding guard should remain; review classification and
independent-revision feedback need correction. This is separate from the earlier
IST timestamp-validator fix, and remains unresolved in this campaign.

No completed agent request approached the configured **6,000 output-token cap**:
the maximum was 1,092. The Luna grader reached 1,601. Maximum worker input was
52,826 against 96,000; routing 15,939 against 24,000; planning 18,082 against 48,000;
review 46,746 against 64,000. The code/example fallback of **800 output tokens** is
tight for complex tasks, but the captured production config and these tests used
6,000. The evidence supports improving retained history rather than increasing all
input/output limits.

The first two automated graders exceeded 64k because the private evaluator duplicated
large turn artifacts in its prompt. Those errors remain recorded; the turns were
manually reviewed without a paid regrade. Later grading used a smaller causal payload.
Two grader findings were rejected manually: a count-only answer did preserve the
user's corrections in memory, and historical tool attempts were incorrectly treated
as new reads. The final scenario was manually reviewed after the budget stop prevented
grading. All original grader outputs remain unchanged.

#### Spending and validation

The approved combined ceiling grew from $5 to $8 and then $12. Known real-data spend
was **$3.971343** across 185 settled requests; two additional requests have unknown
billing. Their maximum reservations, **$5.37**, remain fully accounted, for a combined
known-plus-reserved amount of **$9.341343**. This is not a claim that $9.34 was charged.
The final Sol request required another $2.685 worst-case reservation, which would
exceed $12, so it was not sent. No pending requests remain. The earlier synthetic
campaign's $1.815935 is separate from this real-data ceiling.

Private transcripts, approvals, source/model captures, the interrupted run and
`consolidated-report.json` are retained under
`.local/private-evals/live-messy-20261007/`. All three frozen-source hashes remained
unchanged during their runs. No production deployment occurred.

After the accounting fix, `npm run check` passed type checking, build, formatting
and **844 tests, with 22 skipped**. Focused context/history checks passed 18 tests;
checkpoint/restart checks passed 21. The isolated PostgreSQL context test passed
with no skip, and its temporary database was stopped. This later validation
supersedes the earlier shared-checkout failures recorded above; it does not make the
remaining real-model failures passing results.

### Follow-up fixes and manual prompt audit, 7 October 2026

The prompt audit was a manual reading of all twelve local prompt files, their
composition in `sales-prompts.ts`, memory/summary instructions, the code-appended
review contract and captured Context Engine guidance. It did not use a model grader.
The legacy converser explicitly has no business tools, but belongs to the legacy
graph; it is not an instruction accidentally included in the live tool worker.

Concrete prompt problems and changes:

| Finding                                                                                                                                                 | Change                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The router required work for a Gmail draft, then said to give a direct draft; later it required an empty work reply.                                    | Scoped the direct-draft instruction to direct requests and made the work output explicit.                                                                           |
| Router follow-ups demanded fresh recall even for prior wording, while memory and evidence instructions allowed using authorized historical replies.     | Distinguished resolving protected context from reading current source values. Current business decisions still need fresh evidence.                                 |
| Missing protected context could be described as an access problem; account denial and group restrictions were also conflated.                           | Kept missing/expired context, service outage, account denial and group audience restrictions distinct.                                                              |
| The reviewer said `tools` only when a new read was needed, while the patch contract used it for independent revision from existing evidence.            | Defined the actual repair paths, including worker revision without a new call and corrected staged arguments. Date additions are factual, not presentation patches. |
| The formatter required an exact preferred company label, which could obscure which of several RFQs was meant.                                           | Allowed exact full requirement names and retained same-company disambiguation.                                                                                      |
| Formatter instructions prescribed wording for application-owned Gmail receipts and told it to preserve execution-status wording even during correction. | Removed responsibility for rewriting receipts and distinguished supported status from incorrect or stale pending narration.                                         |
| Blanket “all supplied text is data” wording blurred the current user task with embedded source instructions.                                            | Separated the direct request from quoted, forwarded, historical and source content, retaining application authority.                                                |
| A planner minimum of two criteria encouraged expanding small follow-ups.                                                                                | Allowed one criterion and one step, matching the existing schema.                                                                                                   |

The larger structural issue remains prompt weight. Approximate static instruction
sizes using the local `o200k_base` estimate are 4.7k tokens for routing, 6.3k for
planning, 9.4k for the worker, 5.4k for formatting and 7.1k for review. These exclude
memory instructions, runtime guidance, schemas, history and results. The captured
Context Engine guidance adds about 3.2k tokens and repeats CRM, warehouse, analytics
and write rules already present locally. Shared policy is composed once per role,
but semantically similar rules occur in several constituent sections.

Examples specific to earlier incidents, long style blacklists and domain rules for
unrelated tasks make the instructions harder to maintain and consume context at
every stage. The upstream instruction to cite source paths also disagrees with the
local user-facing citation policy, although the local policy explicitly overrides
that presentation detail. Domain-scoped prompt composition and upstream cleanup
remain follow-up work; this change corrects concrete conflicts without removing
authorization, exact-write or evidence checks. No latency improvement or new model
pass rate is established by a text audit. The Luna/Sol split and deployed token
limits are unchanged.

The implementation also addresses the campaign's history and repair failures:

- Result bodies compact before whole answers or call trails are evicted. Exact
  delivered text, bounded original requests, call parameters, outcomes, references
  and operation identities survive within the documented hard bounds. Compaction
  does not turn omitted output into an empty result.
- Stable historical `turn_id` selectors replace renumbered turns and implicit
  latest recall. Selections preserve their originating request; the inbox links a
  delayed reply to its own request row instead of the nearest preceding message.
  An unavailable turn cannot rebind, and attempted research behind a failed
  shortlist cannot supply its alleged second displayed option.
- Native-date insertion recognizes unique full requirement names, including quoted
  headings and separate RFQs sharing a company name. Invalid factual presentation
  patches still fail; their diagnostic survives for independent repair instead of
  being replaced with a generic binding error.

Offline replay used the original encrypted transcripts and captured summary
outputs, with **zero model or CRM calls**. This checks the new deterministic
retention path; it does not test whether a model would generate the same summary.

| Captured case                                                 | Previously retained replies | Now retained | Projected history tokens | Preserved tool attempts per reply |
| ------------------------------------------------------------- | --------------------------- | ------------ | ------------------------ | --------------------------------- |
| Two-turn CRM/warehouse comparison (R2)                        | 1                           | 2            | 4,159                    | 8, 4                              |
| Client switch, unavailable shortlist, count interruption (T1) | 1                           | 3            | 3,371                    | 3, 9, 1                           |
| Pipeline history, retry, RFQ detour (T3)                      | 1                           | 3            | 3,476                    | 5, 4, 5                           |

All three encrypted states loaded in a separate process with the same stable IDs.
The failed-shortlist ordinal and old numeric-turn calls were rejected without a
source read; denied business access withheld every private answer. Replaying the
original R2 review input inserted both native date pairs and left zero date issues;
the original invalid patch remained rejected with its date diagnosis preserved.
Private artifacts are `replay-compaction-fix.ts` and `compaction-fix-report.json`
under the campaign directory. Original evaluation files and results remain intact.

Focused deterministic checks cover compaction, origin binding through interruption,
revoked access, uncertain-write metadata, quoted/ambiguous RFQ names and review
diagnostics. At this checkpoint the local changes had not been deployed or evaluated
in a new paid conversation run. The earlier 16/24 result remains the original
campaign result; the separately approved rerun follows below.

After the fixes, `npm run check` passed: **850 tests passed, 22 skipped**, plus
type checking, build and formatting. The sandbox run could not support all local
HTTP tests; the full check ran with localhost access. Six existing scripted recall
fixtures were migrated to the required stable selector, and the final check passed.
The current SQL schema is unchanged; the earlier isolated PostgreSQL check was not
repeated for this change.

### Same-corpus rerun under a fresh $5 ceiling, 7 October 2026

The user approved the same corpus once more with a $5 budget. All six original
scenarios (24 user turns) were queued with unchanged text and the same Luna/Sol mix:
Luna routing, formatting and grading; Sol planning, tools, review and memory.
This run used a frozen v42 snapshot containing the preceding fixes. Its source hash
remained unchanged. CRM/warehouse operations were read-only, with no WhatsApp sends.

The reservation guard stopped the run after **15 attempted turns**: **12 acceptable
delivered answers, two harness failures, and one budget-interrupted turn**. Nine
turns were never started. This is not a completed 24-turn rerun.

| Scenario                                   | Acceptable answers / attempted turns | Result                                                                                                                                             |
| ------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1: overlapping lead samples               | 3/4                                  | Historical filters/overlap survived; final fresh-read answer failed in date insertion/review.                                                      |
| R2: shared warehouse comparison            | 3/4                                  | Initial comparison failed in date insertion/review; later hypothetical, historical and fresh comparisons passed.                                   |
| R3: outage, retry, history, revoked access | 4/4                                  | All four outcomes passed, including the failed-call versus successful-empty-result distinction.                                                    |
| T1: client switch and interruption         | 2/3                                  | CVM and revised Masters Union shortlist passed; negotiation-count turn interrupted by the budget guard. Final ordinal/compaction turn not reached. |
| T2 and T3                                  | Not attempted                        | Guard stopped before these scenarios.                                                                                                              |

Manual acceptance on the **same first 14 turns** was 12/14 versus the original
9/14. One original failure in that subset was itself an evaluation reservation stop,
so the difference is not a pure model-quality improvement. The two historical-recall
recoveries in R1 and R3 directly exercise the repaired retention path. R2 still has
the original review caveat: its pair was recovered from earlier source attempts,
and the historical area was actually delivered on turn 2, after turn 1 was unavailable.
Original failures and all new grading outputs remain intact.

All three reached compaction tests retained both original protected replies after
21 filler exchanges and encrypted-state reload. R1 preserved 3+1 attempts, R2 9+4,
and R3 5+2, including the failed notes read and its later successful empty retry.
Bulky result bodies were omitted while requests, arguments, identities and outcomes
survived. Each history-only turn made **zero source calls**. Denied owner/business
access withheld protected details. The later three compaction cases were not reached;
the local adapters do not test production PostgreSQL persistence or an OS crash.

Latency remains material. For the matched first 14 turns, median wall time was
**92.44 seconds**, previously 106.55; maximum was **271.36 seconds**, previously
257.76. These are single-run observations with fresh source snapshots, not a controlled
speed comparison. Across those turns the worker made 54 provider responses and 42
tool-call batches, all containing one call, despite independent-read batching already
being enabled and described in the adapter instructions. R2's initial comparison
used nine source calls, ten worker responses and two failed reviews. Changing the
router/formatter model alone does not remove those serial worker/review round trips.

No completed agent output approached its token cap: maximum **857/6,000** tokens;
maximum worker input **46,884/96,000**. Raising those limits is not supported by this
sample. The research-time allowance did expire during R2's repair, after its long
sequence of successful reads and first review.

The rerun exposed two additional date-layout defects:

- R1's worker supplied a grounded answer, but deterministic enrichment treated a
  warehouse caveat mentioning the CRM client as another record card. It attached
  that client's dates to the warehouse and reinserted them after review removed them.
- R2's `Deal: “full requirement name”` headings escaped date enrichment. Luna's
  repair correctly added the dates, but the factual-preservation guard rejected
  those additions, leaving the reviewer the same incomplete answer.

Local **v43** now recognizes explicit record-label prefixes and excludes incidental
client mentions inside warehouse caveats. Offline replay of both captured drafts
leaves zero date issues: R1's original draft remains unchanged; R2 receives its two
native date pairs. Focused regression checks cover these layouts. **These later fixes
were not included in the frozen paid run and have not been paid-retested or deployed.**

Spend was **$2.355286**, across 116 settled requests, with no unknown charges, pending
requests or held reservations. The next Sol response required a **$2.685** worst-case
reservation; $2.355286 + $2.685 = $5.040286, exceeding the approved $5 ceiling. The
guard therefore stopped before sending it. The unused $2.64 was not charged or spent,
and the ceiling was not raised. This reservation uses the provider input ceiling,
not the much smaller input actually observed in these requests.

Private evidence, the exact approval, frozen source, original model/CRM captures,
usage ledger, `manual-review.json`, `summary.json` and offline date replay are under
`.local/private-evals/live-messy-20261007/post-fix-5usd/`. The top-level machine report
contains six case entries including empty ones; attempted-turn counts above are the
actual coverage.

Final local v43 validation: `npm run check` passed Prisma validation, type checking,
build and formatting, with **851 tests passed and 22 skipped**. The paid run had
already stopped before this full check, so local test load did not affect its latency
measurements. No additional paid requests were made for the date fixes.

### Answer rendering and review cleanup, v44

The requested pre-refactor checkpoint was committed and pushed as `13e3120` on
`main`. The following changes build on that checkpoint and remain undeployed. The
subsequent authorized paid evaluation is recorded below.

- Current CRM cards can use an internal `answer_blocks` envelope with exact source
  record IDs. The renderer owns each card's name and native dates. Text blocks retain
  warehouse sections, comparisons and caveats without name-based date insertion.
  Missing/retired IDs, warehouse IDs used as CRM bindings and model-supplied native
  date fields in card bodies produce explicit repair diagnostics. Requested native
  timestamps support IST milliseconds; missing values remain `Not recorded`.
- Plain prose is still accepted. Missing unrequested dates are optional metadata,
  not a reason to suppress a useful answer. Wrong dates, requested dates, identity,
  authorization and internal-ID leaks still require correction.
- Review now distinguishes `format`, `evidence` and `tools` repairs. Formatting is
  wording/layout only. An evidence repair uses the configured worker model (Sol in
  the existing mix) with already-read evidence and no tools, so supported dates or
  numbers may be added after research has ended. It retains the original reply
  deadline and independent review. Tool-loop repair remains for missing reads or
  changed staged arguments when time and tool allowances permit it.
- Rejected or unchanged formatting edits produce diagnostics instead of silently
  restoring the old answer and spending another review on it. One evidence repair
  is allowed; an unchanged answer with unchanged evidence stops. Fresh evidence
  changes the reviewed artifact even if its answer text is unchanged. The original
  two-review maximum remains. Stage metrics retain only repair kind and outcome.
  Absolute deadline expiry is classified consistently even when the graph deadline
  fires before the outer service timer.
- Suggestion-only review findings cannot veto an otherwise explicitly supported
  CRM insertion. Required fields and material user intent remain mandatory; optional
  enrichment, preferred naming/style and an extra confirmation for `direct_request`
  do not become new prerequisites. Exact renderer-owned CRM names are source data,
  so a name containing a stock phrase is preserved while generated filler still
  receives normal style checks. Proposal values are never patched by the answer
  repairer, and unsupported staged values still cannot commit. Planner/worker and
  reviewer guidance consistently distinguish a new user-supplied fact from a claim
  that CRM already contains that fact.

Offline replay of the original R1-4 and R2-1 worker drafts preserves both drafts
without automatic date additions and leaves zero date-validation issues. This is
rendering/validation evidence only, not a new semantic-model verdict. The report is
`post-fix-5usd/v44-rendering-replay.json` alongside the untouched original captures.

Deterministic graph checks cover explicit CRM/warehouse separation, date repair
past the research deadline, the original hard reply deadline, invalid binding
recovery, rejected formatting edits, no-progress stopping, independent rejection
of a bad factual repair, optional metadata, wrong native dates, IST precision, and
ordinary synthetic RFQ insertion with omitted optional fields. The insertion saves
once without a redundant read or extra confirmation; a material rejection performs
no write. Existing source-bound patches, direct-write authorization, recall and
prompt-composition checks remain part of the full suite. These checks use local
fixtures: no model API calls, live CRM writes or WhatsApp sends.

Final local v44 validation: `npm run check` passed Prisma validation, type checking,
build and formatting, with **863 tests passed and 22 skipped**. The first refactor
check retained five failures: four old repair-path fixture expectations and a real
deadline-classification race. Those were corrected before the passing run; the
earlier failed check remains in `.local/answer-refactor-check.log`. No additional
paid model requests were made during those local checks.

### Same-corpus paid evaluation of v44, 7 October 2026

The user authorized the unchanged six-conversation, 24-turn corpus once with the
same Luna/Sol split and a fresh **$5 combined ceiling**. Luna handled routing and
grading; Sol handled planning, native tools, review, memory and evidence repair.
Formatting retained its configured Luna route, but all reached answers used the
deterministic formatting path without a formatter API call. The runner froze v44
source and verified input integrity at completion. Real CRM/warehouse operations
were read-only; the evaluation had no write client or WhatsApp transport. Failed
and interrupted captures remain intact; no turn was rerun or paid-regraded.

**Coverage: 16 completed turns, all acceptable on manual source-backed review;
one budget-interrupted turn; seven unattempted.** R1, R2, R3 and T1 completed all
four turns. T2-1 completed routing but was blocked before its first Sol request or
source read, returning unavailable; T2-2 through T3-4 were not reached. This is not
a full-corpus pass. The previous v42 run had 12 acceptable answers in its 14 fully
evaluated turns; all 14 matching turns are acceptable in v44.

Latency comparisons use the same turn IDs, excluding the current budget stop:

| Comparison                                               | Matched turns | Earlier median | v44 median | Reduction |
| -------------------------------------------------------- | ------------: | -------------: | ---------: | --------: |
| Original baseline, excluding its budget-interrupted T1-2 |            15 |      100.872 s |   64.737 s |    35.82% |
| Original baseline, including its interrupted T1-2        |            16 |      106.552 s |   65.596 s |    38.44% |
| Previous v42 run, excluding its interrupted T1-3         |            14 |       92.444 s |   65.596 s |    29.04% |

These are single-run observations with fresh source data, not a controlled model
benchmark. In particular, the live notes response changed between runs. Across
all 16 completed v44 turns, the median was **65.596 s** and the maximum was
**178.849 s**. Serial model/tool steps remain a substantial latency source; the
longest turn used nine source attempts, including one transient search failure
and its successful retry.

Both previous date/review failures are resolved in this run:

- R1-4 returned separate CRM and warehouse details in **76.548 s**, versus
  **168.962 s** and an unavailable reply in v42. Explicit CRM rendering kept its
  native dates out of the warehouse section; one review approved without repair.
- R2-1 returned the shared two-warehouse comparison in **132.013 s**, versus
  **271.357 s** and an unavailable reply in v42. Supported prose without optional
  native dates was accepted by one review; no date-insertion or repair loop ran.
- R3-3 exercised the new evidence repair on a real error. Luna recalled four
  original lookups but the saved trail contained five. Sol correctly requested
  the omitted warehouse-detail lookup, repaired the answer from existing history
  without tools, and approved it on the second review. This was the run's only
  evidence repair. The other 15 completed turns passed their first review.

**History and compaction:** all four reached compaction cases passed after 21
filler exchanges and encrypted-store/service reload. Across their nine retained
business replies, reply text and all **37 tool-attempt metadata entries** matched
the original receipts: tool, arguments, phase, status, error code, record references
and returned count. Bulky results were intentionally omitted, not silently treated
as current data. Both the injected notes failure and the later transient warehouse
search failure survived distinctly from their successful retries. R1/R2/R3
history-only turns made zero source calls. T1-4 correctly resolved the original
second option after a client switch and interruption, honored the newer property
restrictions, and performed the two fresh reads used in its answer. Simulated
access revocation still blocked protected history disclosure. These checks cover
local encrypted persistence and object recreation, not production PostgreSQL
persistence or an operating-system crash.

Raw Luna grades flagged three completed turns; the manual review retains explicit
disagreements rather than changing those grades. R1-4 was flagged for a missing
Last updated field that is visibly present. R2-3 was incorrectly credited with
fresh calls copied from the preceding turn's historical tool receipt; its live
call list is empty. T1-3 was flagged for not restating paused corrections despite
the user's request for only the count and scope; both the subsequent compacted
memory and T1-4 preserved those corrections. These are evaluator issues, not
observed user-answer failures. The grading prompt was not changed mid-run.

The largest observed worker input was **45,582 tokens** against the configured
96,000 input allowance, and largest output was **1,087 tokens** against 6,000.
There was no observed token-limit failure in the completed turns. This read-only
corpus does not establish live insertion behavior; the preceding deterministic
synthetic insertion checks remain the evidence for that change.

Total spend was **$2.349121**, covering **123 settled requests**, with no unknown
charges, pending requests or held reservations. The next Sol request needed the
unchanged **$2.685** worst-case reservation: $2.349121 + $2.685 = $5.034121, above
the cap. The runner stopped before sending it. The unused $2.65 was not spent;
the provider-ceiling reservation, rather than settled cost reaching $5, limited
coverage. The cap and reservation policy were not relaxed.

Approval, unchanged cases, frozen code, raw model/source captures, usage ledger,
manual audit and reproducible `summary.json` are retained privately under
`.local/private-evals/live-messy-20261007/post-cleanup-5usd-v44/`. No application
code was changed during this evaluation and no deployment was performed.

### Authorized v44 continuation and complete corpus, 7 October 2026

The user subsequently approved the unfinished work and an **additional $5**. The
continuation ran T2 and T3 once each, using the same frozen source and model split.
T2-1 was explicitly retried because the original attempt stopped after routing,
before any source call. Its unavailable reply, trace and charged routing call are
preserved in `run/`; the new attempt is in `continuation-run/`. The 16 completed
turns were neither repeated nor regraded. The additional campaign enforced its own
$5 cap and recorded the prior $2.349121 spend separately.

**All eight continuation turns completed and passed manual source-backed review.**
Across both campaigns, all **24 distinct corpus turns** now have acceptable
delivered answers. There were **25 total attempts**, including the retained original
budget interruption. All six conversations completed; there are no unattempted
turns. This is one corpus execution with one authorized budget retry, not a
multi-trial reliability estimate.

The continuation cost **$1.533589** across **76 settled requests**. Combined spend
was **$3.882710** across **199 settled requests**, including the interrupted attempt.
There were no pending, unknown, unpriced or held charges at completion. No new
application code, grading prompt or reservation-policy change was made during the
continuation.

Full-corpus latency, using the latest delivered answer for each distinct turn:

| Comparison                                                        | Matched turns | Earlier median | v44 median | Reduction |
| ----------------------------------------------------------------- | ------------: | -------------: | ---------: | --------: |
| Original baseline, all matched turns                              |            24 |      110.698 s |   72.261 s |    34.72% |
| Original baseline, excluding its budget-interrupted T1-2 and T3-4 |            22 |      110.698 s |   67.215 s |    39.28% |
| Previous v42 run, excluding its interrupted T1-3                  |            14 |       92.444 s |   65.596 s |    29.04% |

The complete v44 sample's nearest-rank p95 was **178.849 s**, with a maximum of
**246.113 s**. Source snapshots changed, so these remain observational comparisons.
In this continuation, stage-history reads returned actual transition rows that had
been absent in the earlier baseline, and current negotiation stock was 39 instead
of the earlier 38. The answers used their contemporaneous captures.

The remaining latency issue was concrete: in T2-1, Luna attached “max” to the area
in “10,000 sqft max budget 25 rupees.” Sol's planner and first worker draft carried
that interpretation into an undersized shortlist, despite receiving the original
user wording. Sol review caught the material requirement mismatch. A tools repair
read two replacements and delivered a supported shortlist, with the above-budget
fallback and uncertain commercial units explicit. The recovered turn took
**246.113 s and 15 source calls**, slower than the original baseline's 207.506 s.
It also began with “Corrected shortlist” even though the rejected draft had never
been delivered. Earlier requirement validation and less narration of internal
corrections remain useful improvements; this evaluation did not implement them.

T2 preserved the Express 3PL brief through the XP India detour, resolved the actual
second delivered option, and rejected an unsupported pasted bonded-approval claim.
Its final four-bullet history answer made zero source calls. T3 kept three city
requirements and their ownership/budget evidence separate, then returned to the
original stage-history task after compaction rather than recalling the intervening
company's records. The final retry read all three original histories successfully,
kept the original failures separate, and still declined to invent elapsed durations
without RFQ-entry timestamps. It identified negotiation stock as the previously
observed count, explicitly not refreshed by that retry.

**All six compaction/reload cases passed.** Across their **15 retained business
replies**, reply text and all **69 tool-attempt metadata entries** matched the
original receipts, including **five failed attempts**. Full result bodies remain
intentionally bounded. All four history-only turns made zero source calls; the two
turns requesting fresh evidence performed their expected reads. The persistence
scope remains local encrypted stores and recreated service objects.

Raw automated results are retained: Luna marked **19/24** turns fully passing,
while the manual review accepts **24/24**. In addition to the three disagreements
above, T2-1 was flagged for missing native dates that are visibly present. T3-4 was
flagged under the grader's older mandatory Created/Last updated rule even though
the task requested historical stage transitions and v44 allows omission of that
unrequested metadata. The transition timestamps and missing-duration explanation
were correct. These evaluator failures were not silently regraded or erased.

Largest worker input across both campaigns was **59,821/96,000 tokens**; largest
worker output was **1,225/6,000**. No completed-turn failure pointed to insufficient
token allowances. The long case arose from requirement interpretation, serial
reads and a late repair.

The approval, runner diff/provenance, raw continuation captures and manual audit
are under the same private v44 directory. `build-combined-summary.py` reproducibly
produces `combined-summary.json`, which includes the original interrupted attempt,
both usage ledgers, per-turn dispositions, latency comparisons and history checks.
No live CRM writes, WhatsApp sends or production deployment were performed.
