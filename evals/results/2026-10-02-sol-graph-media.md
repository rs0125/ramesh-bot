# Sol, separate agent roles, media and inbound batching

This record follows the [historical v1–v7 results](2026-10-02.md). It covers local implementation and captured testing on 2 October 2026. Production business reads and the new media/batch migration have not been deployed. No live test constructed a WhatsApp transport.

## Implemented behavior

The research graph now separates converser, planner, native-tool worker, deterministic executor, formatter and verifier. The planner receives the actual permitted schemas, Context Engine guidance, protected history, clock, budgets and outcome criteria. Ordinary conversation skips planning. In v14, the verifier can correct an initial direct route by entering planning/research within the existing repair limit, and receives the actual local recall tool definition. It no longer has to infer that employee context retrieval restores a previous answer.

Forwarded text and supported media share a durable sliding collection policy: 3 seconds after a forwarded/media message, 1 second after ordinary text, and 8 seconds maximum from the first message. The collection clock is independent of model/transcription time. Duplicates do not extend it. Each account/chat/sender has separate membership; claimed batches are closed. Original messages remain in the inbox, with one finalized outbound response per batch.

Images, PDFs and voice notes have encrypted owner-scoped bytes and extraction records, with 24-hour expiry checked on reads and bounded cleanup. Current attachment order follows the original messages even if downloads finish in reverse order. Retained chronology/expiry uses server receipt time, including recovery. Ogg/Opus voice notes are decoded through a bounded ffmpeg process before transcription. Extraction starts while the batch is collecting.

## Matched model screen

The v11 screen held code, prompts, schemas, fictional scenarios and the external Terra judge fixed. Each profile ran 12 scenarios twice. This screen predates the separate planner graph.

| Profile       | Passed | Tool-contract failures | Invalid arguments | Turn median / p95 | Agent reasoning tokens |
| ------------- | -----: | ---------------------: | ----------------: | ----------------- | ---------------------: |
| Terra, medium |  21/24 |                      1 |                 0 | 11 / 42.9 s       |                  8,509 |
| Sol, medium   |  23/24 |                      0 |                 0 | 18.6 / 60.4 s     |                  1,748 |
| Sol, high     |  23/24 |                      0 |                 0 | 21.2 / 61.7 s     |                  8,466 |

Sol medium is selected for the local playground and the authored paid CI workflow. Production defaults remain Terra until a separate deployment/configuration change. High effort added latency without a measured gain in this small sample; this is not statistical proof of superiority. Both Sol failures involved a native CRM date parser/reviewer problem corrected afterward. Screen artifacts remain under `.local/model-comparisons/2026-10-02T07-15-50.072Z/`.

Responses requests use `store:false`, serial native tool calls and explicit effort. The worker defaults to medium, planner/verifier use medium, and routing/business formatting use low. Sol's unsupported `none` maps explicitly to low. Returned reasoning/cache token counts are retained as numbers; provider reasoning content is not written to traces.

## Generic repeated evaluations

The first separate-planner full run, v12, passed **127/148** trials: all 74 generic cases ran twice with Sol medium and fictional business evidence. The original report is `.local/ci-evals/2026-10-02T07-43-00.448Z-81bcb9e7/`.

That run exposed genuine continuity/over-review failures and several harness defects. Corrections distinguish equivalent explicit/relative date windows while retaining scope/date-field checks, make changed-record detail responses agree with the changed search fixture, and recognize the configured application name without requiring a lookup. Router guidance now sends drafts based on protected historical results through fresh recall. Earlier scores were not recalculated.

The focused v14 recovery run passed **15/16**, covering eight scenarios twice. Both previously failed analytics follow-up scenarios passed both trials; ordinal selection, changed/revoked history, media availability and topic switching also passed. One CRM call-preparation trial was rejected by the runtime reviewer for omitting a CRM UUID, contrary to the application's presentation contract. Its follow-up draft succeeded, but the full trial remains failed. Report: `.local/v14-focused/2026-10-02T09-01-40.224Z-67a8fcc5/`.

V15 supplies explicit application-owned organization/verified-employee context to formatting and review, and clarifies that missing CRM UUIDs are never a reason to reject an answer, including call briefs. This does not attest to job titles, deal ownership or transactions. Its focused run passed **2/6**: both CRM preparation trials passed, while company-guidance trials exposed a conflict between formatter and reviewer about internal source paths. V16 moves the common source-reference rule into the evidence policy shared by all roles: readable source titles/public references in chat, internal API paths/CRM UUIDs in receipts. Missing booking data also cannot establish that no visit is booked.

| Run | Coverage                                              |  Passed | Retained directory                                      |
| --- | ----------------------------------------------------- | ------: | ------------------------------------------------------- |
| v13 | All 74 generic scenarios, twice                       | 132/148 | `.local/ci-evals/2026-10-02T08-29-22.126Z-b86ab391/`    |
| v14 | Eight routing/recall regressions, twice               |   15/16 | `.local/v14-focused/2026-10-02T09-01-40.224Z-67a8fcc5/` |
| v15 | CRM preparation and two company-guidance cases, twice |     2/6 | `.local/v15-focused/2026-10-02T09-13-46.222Z-50a0418f/` |
| v16 | Three company-guidance/advice regressions, twice      |     5/6 | `.local/v16-focused/2026-10-02T09-19-06.655Z-a30002fc/` |

The v13 full run spans **270 turns**, with **38.9-second median** and **86.3-second p95** graph time on synthetic sources; it took **47 minutes 32 seconds** at concurrency four. Totals include **1,871 model requests, 19,175,967 input tokens and 316,976 output tokens** including judging. Agent usage was 1,723 requests, 17,741,689 input / 272,485 output tokens; the 148 judge requests used 1,434,278 input / 44,491 output tokens. Reasoning and cached-input counts are subsets of those totals. Real MCP/media and delivery revalidation can add latency.

V13 domain pass counts were CRM 36/40, analytics 39/42, personal assistance 22/24, supply 12/14, knowledge 5/10 and access/action boundaries 18/18. The sixteen failed trials involved direct-route recovery, unnecessary extra query scope, over-review, unsupported inferences, personal-plan continuity and presentation. Later focused fixes do not establish a new full-suite pass rate. The paid quality gate remains red on the full result.

The one v16 failure was an independently inspected judge error: it called the answer's approximate **14:50 IST** retrieval time unsupported, while successful tool timestamps were **09:20:25.265Z**, **09:20:27.994Z** and **09:20:31.605Z**, which convert to that IST minute. The raw **5/6** is retained. The future judge prompt now explicitly distinguishes UTC instants from source reporting calendars; no existing score or transcript was rewritten.

Start-time manifests distinguish changes made during a long run; a targeted rerun never replaces an earlier failed trial. The full v13 prompt hash is `03b1074a1ba4f97886632eedcbb11902b0daf72de124f901505ae77ccb14462a`, dataset hash `4e040973f758e51c5086a33fde126a6b31385daaef51b583638143a98f71fb85`, and input hash `83712ec8675c14f039729a306012509d078055b7b0b2529b729e2e2f3d70b792`. Each later directory retains its own manifests. V16 is the final local graph; the whole 148-trial suite has not been repeated after the focused corrections.

## Deterministic validation

The full required check on v14 passed **201 tests, zero skipped**, against disposable PostgreSQL 17, plus Prisma validation, typechecking, build/prompt packaging and formatting. The v15 reviewer-context change then passed all **24 affected graph/recall/planning tests**, typechecking, build and formatting. Relative Markdown links and `git diff --check` passed. The disposable database was removed after use. The live capture GUI and local Context Engine remain separate from that disposable database.

## Private real-data outcomes

Ten private cases were authored around employee outcomes before reference collection. They cover follow-up prioritization, preparation for a client conversation, supply shortlisting, visits, GA4, Search Console, attribution limits, ordinal follow-ups and a cross-domain brief. No case mandates a tool or call order. Questions, source snapshots, transcripts and judge details remain only under ignored `.local/private-evals/`; the runner refuses CI and its files are not included in artifact uploads.

| Snapshot                      | Result | Captured turns | Local run                  |
| ----------------------------- | -----: | -------------: | -------------------------- |
| v12, every private case       |   8/10 |             15 | `2026-10-02T08-08-17.764Z` |
| v13, three selected cases     |    3/3 |              6 | `2026-10-02T08-34-17.119Z` |
| v13, cross-domain brief rerun |    1/1 |              1 | `2026-10-02T08-55-17.774Z` |
| v16, company-guidance outcome |    1/1 |              1 | `2026-10-02T09-20-38.873Z` |

The initial failures remain failures. One shortlist was withheld because a discovery vocabulary changed during generation; its actual CRM/candidate/assessment facts were unchanged. All-read fingerprint checks remain conservative, including discovery. The other failure hit the four-minute graph deadline and returned no useful partial brief. A later fresh run passed, which demonstrates variability, not that deadline handling is solved. The later trials are not a new complete 10/10 run.

## Media, queue and browser checks

- Real OpenAI extraction of generated PNG and PDF inputs passed factual checks.
- Three generated WAV voice notes plus a summary request formed one batch and one captured response, preserving facts and uncertainties.
- Three generated Ogg voice notes passed the same check; a subsequent question about the second note selected its contents correctly. This also passed on v14.
- Browser testing submitted four messages while earlier requests were pending and rendered four user bubbles and one assistant reply, with no browser errors.
- Disposable PostgreSQL tests cover encrypted bytes/extracts, same-owner access, duplicate media, recovery, expiry before physical purge, closed batch membership, cross-sender separation, one outbound handoff and reversed download completion order.

The media checks use generated non-private files. Actual CRM/analytics checks use the real Context Engine and Supabase, with Raghav pinned by server configuration. Every live output is captured in the separate test tables. Capture migration `202610020002` is applied; production migration `202610020005` is not.

## Remaining limits

Semantic review can still over-reject useful answers or miss a subtle unsupported inference. Large cross-domain research can exceed the deadline. The runtime currently loses its aggregate stage trace on a timed-out graph, although tool events remain stored. Delivery revalidation may suppress a sound answer when discovery metadata changes. These are recorded quality/latency limits.

Account-wide work processing remains serial; per-sender burst collection does not yet mean concurrent research workers. Media extraction is bounded and potentially lossy, and later references select at most eight recent unexpired same-owner files. Unmentioned group media is not automatically downloaded. Paused-task checkpoints, reminders, business writes and calendar/HRMS integration remain separate increments.

At the time of this run, deployment required the production migration and ffmpeg installation. The subsequent [direct-audio change](../../docs/agent-modules/38-direct-audio-transcription.md) removes the runtime ffmpeg requirement; the measurements above remain historical. The local test GUI is capture-only, and private cases must stay ignored.
