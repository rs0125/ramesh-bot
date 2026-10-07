# Conversation failures: 6 October 2026

## Evidence and scope

Read-only review of 53 bot-handled requests in five chats, over the 24 hours ending
6 October 2026 at 20:30 IST. The sample contains 51 sent replies, two expired
requests and 173 successful logged source reads. Failure categories overlap.
Encrypted message history, queue state transitions, tool events, write receipts,
retained media and worker traces were compared. Private audit exports remain in
the ignored `.local/chat-audit-20261006` directory; they are not test fixtures.

## Findings and corrections

| Observed failure                                                                                                                                            | Root cause                                                                                                                                                                                                                                                             | Correction                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two CRM stage reports also answered an old CMS question.                                                                                                    | `MediaService.context` treated “yesterday”, “earlier”, “note” and “summarize” as attachment references and loaded recent uploads into the current input. An unrelated voice transcript became part of the new request.                                                 | Only explicit attachment references trigger implicit retrieval. A singular reference selects the latest matching kind; explicit current attachment IDs preserve the current burst.                                                                                                                                                                                               |
| A building-type correction switched from the current client to an earlier logistics client; a voice retry asked the user to resend an available transcript. | Inbox history stored `[Audio message]` without hydrating the original brief. The current voice transcript existed in the short-lived media store but disappeared from follow-up context. “Retry” did not trigger the old attachment keyword matcher.                   | Hydrate each historical audio message by its exact WhatsApp source ID and owner. Keep it in chronological history, with source labeling and expiry. Exclude transcripts from durable summaries and pins. A retry can use this history without reclassifying historical text as write authorization.                                                                              |
| “After this, show my task list” created an already created task again.                                                                                      | The write gate checked that proposed text was user-authored and the source quote belonged to the current turn. It did not reject a read-only current instruction, so an old creation instruction could supply the text again. Independent review approved the mistake. | Reject `personal_apply` for narrow, explicit list-only commands, regardless of the model proposal or recalled text. Mixed create-and-list requests and genuine time clarifications retain their existing paths. Strengthen review guidance for current intent.                                                                                                                   |
| RFQ retry was described as potentially completed despite a definite validation rejection.                                                                   | The authoritative receipt said `not_dispatched` with no uncertain attempt. Bare “retry” did not enter deterministic recovery; natural recovery was limited to mail drafts. Model-led CRM lookup could not establish the original journal state.                        | Allow scoped natural retries for approved direct actions. A bare retry must relate to the immediately preceding turn; unrelated voice/read retries fall through to conversation handling. Ambiguity still requires a code. Retry reuses the same operation ID, frozen arguments, approval and fresh access checks.                                                               |
| Three automatic retries lost most or all completed research; one warehouse answer reported sources unchecked after 13 successful reads.                     | Replay persisted model responses and retry budgets, not a reconstruction plan for successful reads. The new run needed to rediscover and reread evidence under the original absolute deadline; late retries exhausted research before rebuilding it.                   | Retain a bounded encrypted journal of successful read selectors, never results or grants. Late restarts reauthorize and refresh those reads in a bounded window before final review, sharing the original call/byte budgets and hard reply deadline. Writes and utilities are excluded. Known rolled-back PostgreSQL contention gets bounded checkpoint retries in the same run. |
| Two queued requests expired without replies, after waiting about 208 and 88 seconds; another voice request hit the four-minute model timeout.               | Admission expiry was five minutes from message time, but generation allowed four minutes from processing start. Queue age and media waits consumed the delivery window. Lease renewal was correctly capped at message expiry, so it could not rescue the overrun.      | Pass a transport-owned generation deadline reserving 15 seconds for handoff/delivery. Bound media waiting by remaining time, reserve finalization time from the actual available generation budget, and preserve committed receipt recovery. Hard timeouts still fail closed.                                                                                                    |
| Review approved the wrong-client answers and duplicate task; one RFQ run ended in a verification fallback.                                                  | Review checked supplied evidence but inherited contaminated or incomplete context and missed current intent. A verifier alone did not repair source selection or enforce read-only intent.                                                                             | Fix the source and runtime boundaries above; explicitly instruct review to preserve the latest user brief, reject old questions/client switches, and distinguish unsent from uncertain receipts. Verification remains required before committing staged writes or delivering protected facts.                                                                                    |

The optional-locality RFQ rejection was separately fixed in Context Engine commit
`772e10f`: user-provided optional free text such as “Anywhere” and “TBD” is allowed,
while source provenance and required/formatted fields remain enforced.

## What the evidence cannot establish

The original exception that triggered each automatic retry was discarded by the
worker. The queue records `processing_retry`; the first attempts have no completed
agent trace. This proves restart and evidence loss, but does **not** prove whether
the trigger was a lock timeout, connection loss or another checkpoint failure.
Do not report a database outage as a confirmed cause. New diagnostics record the
run, direction, processing phase and fixed checkpoint failure category without
exception bodies, credentials or message content. PostgreSQL lock/deadlock/
serialization retries are preventative hardening, not a claimed historical finding.

## Validation and operating limits

Deterministic tests cover attachment selection, exact-source voice hydration,
retention and summary exclusion, read-only write rejection, genuine reminder
clarifications, RFQ operation identity and unrelated-retry isolation, fresh read
recovery, exhausted budgets and revoked access, bounded generation, and checkpoint
retry/error sanitization. Database cases use an isolated local PostgreSQL 17
container through Podman. No production action is replayed and no WhatsApp test
message or paid model evaluation is required.

Read recovery remains bounded: an unavailable source, revoked permission or
exhausted deadline can still produce a partial answer. Transcript recovery obeys
the existing media retention window and bounded conversation tail. The delivery
reserve reduces expiry caused by generation overruns; it cannot guarantee delivery
during a transport or database outage. Prompt changes have deterministic contract
coverage; production semantic improvement requires observation after deployment.

No production duplicate was deleted, failed RFQ resubmitted or past message resent
as part of this repair. Release status must be checked separately from local tests.

Validated after merging with the existing workspace changes: `npm run check`
passed Prisma validation, TypeScript checking, all **989 tests** (zero skipped),
the production build and Prettier checks. The integration database was the
isolated Podman PostgreSQL instance on localhost port 55436. The initial full
run exposed an overly eager recovery threshold and outdated media-selection
expectations; those were corrected before this passing run. No deployment was
performed during this repair.

## Follow-up context inspection

A separate code-path inspection found that business replies were replaced by a placeholder in model history. Recall revealed the old wording only after re-fetching the successful source queries and matching their fingerprints. A changed field or failed source could therefore hide an answer that had already been delivered. Compaction retained warehouse selections but dropped standalone CRM replies and selectors. Failed tool attempts were also absent from cross-turn history. These are confirmed implementation gaps; they are not additional incidents counted in the 53-request audit above.

The correction retains same-owner delivered answers as historical context independently of source refresh, plus bounded read parameters, record references and success/failure/interruption outcomes. Standalone CRM history now survives compaction/restart within the documented retention limits. All model stages keep this context. Current claims still require current evidence, and delivery still checks identity. A historical read trail is not proof that a write committed or permission to repeat it. See [conversation context](agent-modules/04-conversation-context.md) for bounds, validation and the primary-source guidance used.

Validated on 7 October: the combined workspace passes `npm run check`, including
all **996 tests** with zero skipped, Prisma validation, type checking, build and
formatting. Seven new deterministic cases cover CRM wording/selectors without
re-reading, failed-read recovery, argument bounds, compaction/restart/forgetting,
delivery revocation, generation failure and model-stage continuity. The PostgreSQL
integration test also verifies encrypted persistence of the answer and read trail.
The first full run exposed an unintended callback on ordinary chat failures and two
old expectations that discarded failed-turn read history; the corrected run passes.
No paid evaluation, production write or deployment was performed.

## All-tool history and retry follow-up

Extended the same owner-scoped history to every advertised tool family: Context Engine reads, public web and calculator utilities, personal tools, and business writes. A shared bounded recorder captures parameters, result excerpts, fixed failures and separate application commit/recovery events. Complete delivered replies and their constituent receipts survive compaction/restart, with unchanged expiry and forgetting controls. Mixed history requires every relevant current authority; a business-only segment cannot reveal personal or write-only details. Current-turn mutation receipts keep their journal fences even if later response generation fails. Historical write references never become executable commands.

Earlier failures are explicitly not current health or a permanent tool blacklist. They do not populate a new turn's runtime retry policy. A previous retryable:false does not prohibit corrected arguments or a genuine later retry; fresh permissions, limits and errors still govern dispatch. Uncertain writes reconcile the same operation ID and frozen arguments, avoiding duplicate creates.

Validation: `npm run check` passes all **1,002 deterministic tests**, zero skipped, plus Prisma validation, type checking, build and formatting. Added regressions cover shared result/credential bounds, retry after an earlier non-retryable failure, personal compaction/recovery, mutation state distinctions, and safe uncertain-write retry. Expanded existing tests cover web/calculation history, mixed authorization, encrypted database restarts and native reminder recovery. The first all-tool full run caught an asynchronous delivery-memory callback that could duplicate a turn; it is synchronous and idempotent again. Receipt comparison tests now distinguish stable authoritative data from new recovery history. No paid/live-model evaluation, production write or deployment was performed; model retry guidance is covered structurally and runtime retry behavior deterministically.
