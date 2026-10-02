# Ramesh capability and harness review

Reviewed on 2 October 2026 against the worker code, deployment configuration,
production identity/MCP checks, real-data capture tests and the primary AI Engineer
talks linked below. This document distinguishes application capability from its
current production configuration. It is not a guarantee of every model response.

## Production access incident and resolution

The screenshot's CRM/supply refusals were configuration and authorization-path
failures. `BUSINESS_READS_ENABLED` was absent, so production used ordinary chat.
The restricted worker also had four-column SELECT grants on `VerifiedNumber` but
no matching RLS SELECT policy. The playground's separate role did have a policy,
which explains why its success did not prove production access.

The worker policy now permits SELECT on the roster under the existing column
grants; RLS remains enabled and unrelated policies remain intact. Provisioning
validates its named policy and is idempotent. An integration test enables roster
RLS, proves active/unique employee resolution and still denies other columns and
writes. Actual production access was verified with the worker login.

AWS Parameter Store runtime version 7 and the host environment now set:

```text
BUSINESS_READS_ENABLED=true
BUSINESS_READ_EMPLOYEE_IDS=all
OPENAI_MODEL=gpt-6.1-sol
AGENT_TOOL_REASONING_EFFORT=medium
AGENT_TIMEOUT_MS=240000
AGENT_MAX_OUTPUT_TOKENS=6000
```

Other secrets/settings were preserved. The service was restarted and the actual
process environment checked. A production preflight resolved the real reciprocal
WhatsApp LID mapping, discovered 14 tools, ran the full agent against CRM and passed
fresh delivery authorization. Separate CRM/supply reads succeeded. These checks
captured results and never instantiated a test sender.

### Voice reply incident

A later voice note downloaded and transcribed correctly, but its generated business
reply was silently expired by outbound preflight. Replaying all five original
queries showed matching data fingerprints. Concurrent preflight reproduced Prisma
P1008/P2028 errors in local reciprocal LID resolution. This is Baileys session
storage, not a switch away from Supabase queues or CRM.

The correction discovers the phone key and validates both mapping directions in
one SELECT snapshot, without overlapping interactive transactions. In an isolated
production diagnostic, the same five checks passed in 3.54 seconds. No message was
sent. Regression cases cover concurrent resolution, mapping changes, revocation,
notice fencing/restart and quoted voice batches when protected output is withheld.
Failed checks now persist a neutral retry notice, remove the original business
reply from deliverable history and skip its memory callback.

Baileys' offline setting uses inactive receipts; the adapter now explicitly sends
normal delivery acknowledgements after durable archival through a bounded
dispatcher. These are not read/played receipts. The actual sender-side tick display
requires observation on a subsequent real message; fake transport tests cannot
prove WhatsApp's client UI. The old logistics bot used Twilio's transport layer.

## Capabilities available now

| Capability           | Behavior and boundary                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal assistant   | Conversation, drafting, summarization, prioritization, meeting preparation and personal planning from supplied facts. Its role is a chief of staff, not a sales-only persona. No calendar/email integration is implied.                                     |
| WhatsApp             | Persistent Baileys connection, pairing/reconnection, DMs and actual group mentions. Business reads are DM-only. Unknown people can chat.                                                                                                                    |
| Identity             | Trusted transport phone/LID resolves to one active employee. Ambiguous/duplicate/inactive roster identities cannot read business data. Chat text cannot select an employee.                                                                                 |
| Authentication       | Employee-bound signed Context Engine requests with protected service credentials, request binding, expiry and replay protection. Context Engine independently checks current employee permissions. The Claude OAuth connector remains separate.             |
| CRM search           | Assigned or otherwise permitted leads, stages, follow-up dates, native creation/update ordering, filters, summaries, details, related notes/tasks and briefing. “All my follow-ups” is not limited to today.                                                |
| Supply search        | WAG warehouse filters, search, counts and details. Native dates support recently added/updated searches. Warehouse IDs are useful references; recorded specifications are not confirmed availability.                                                       |
| Shortlisting         | Carry CRM requirements into supply research, compare candidates, call the shortlist assessment tool, give grounded pros/cons and targeted verification questions. Rank the reviewed pool.                                                                   |
| Company knowledge    | Search and read reviewed knowledge pages, retaining source identity and uncertainty. A CRM note is not automatically company policy.                                                                                                                        |
| Multi-step work      | LangGraph converser, optional planner, native tool worker, deterministic executor, formatter and semantic verifier. One bounded repair may fetch missing evidence or fix wording. Ordinary chat skips the planner.                                          |
| Tool execution       | Live permitted schemas/guidance, argument validation, application-owned authority, duplicate query reuse, bounded recovery and persisted encrypted source receipts. No model-selected identity, destination or SQL.                                         |
| Conversation context | Up to 32 recent messages within 48,000 characters, reconstructed from Supabase. Protected prior answers can be recalled for up to 24 hours with fresh permissions/source checks. This is not permanent personal memory.                                     |
| Images/PDFs          | Bounded private extraction for supported images and PDFs; encrypted copies/extracts expire after 24 hours. Eight attachments per batch, 8 MiB per attachment, owner and namespace limits. No general Office-document or video pipeline.                     |
| Voice                | Direct audio upload to independently configured `gpt-4o-transcribe`; the STT credential is separate from the chat credential. No runtime ffmpeg requirement.                                                                                                |
| Voice presentation   | Exact returned STT text in italic quotes before the answer. Batched notes appear in inbound order before one common reply. Exact STT quotation is not proof of transcription accuracy. Long output can be labelled as an excerpt.                           |
| Burst handling       | Forwarded flags and media trigger a sliding 3-second window; ordinary text uses 1 second; collection is capped at 8 seconds. Owner/chat isolation and bounded combined input remain enforced.                                                               |
| Reply presentation   | Natural WhatsApp prose, em-dash/canned-phrase guards, no CRM UUIDs, native Created/Last updated on CRM cards, useful warehouse IDs. Model compliance is evaluated, not guaranteed.                                                                          |
| Persistence/delivery | Separate Supabase inbound/outbound queues, duplicate suppression, fenced leases, atomic final reply handoff, retries, source reauthorization before private delivery and conservative uncertain-send handling. SQLite remains for Baileys auth/admin state. |
| Operations/admin     | Separate authenticated admin for pairing, connection controls, inbox and manual replies to existing conversations. Protected business reply bodies are withheld from the ordinary inbox.                                                                    |
| Local test GUI       | Real Supabase and Context Engine, fixed server-side employee, dedicated capture queue role and no Baileys session. Media and batched inputs are supported.                                                                                                  |
| Evaluation           | Deterministic/integration checks, real-model fictional conversations, adversarial tests, outcome-oriented private real-data cases, judge calibration, input hashes and retained failed trials. Private cases/artifacts are excluded from git and CI.        |

Production currently advertises 14 read tools to an appropriately authorized
employee: context (1), knowledge (2), CRM (6), warehouses (4) and shortlist assessment
(1). Analytics adds `analytics_capabilities`, `ga4_report` and
`search_console_report` in the local full-scope profile, for 17 total. Those three
are **not yet production-enabled**: the Context Engine auth deployment and both
sides of the registered signing scopes must be updated together.

The analytics implementation supports source-specific dates/timezones, traffic and
engagement, events, entry/page reports, form-performance reports, Google organic
queries/pages, comparisons and pagination. Its caveats distinguish sessions,
clicks, form events and CRM leads; it cannot create individual attribution from
aggregate reports.

## Pagination increment

[Module 39](agent-modules/39-paginated-research.md) adds unique-record accounting,
duplicate detection, linked traversal status and cursor-cycle suppression for CRM
and warehouse searches. The worker, formatter and verifier receive coverage
computed from accepted source evidence. Page size can change without losing the
query boundary; filters/sort/tool changes start separate accounting. Empty pages
with a cursor are not exhaustion. Recalled/disconnected pages alone cannot prove
complete coverage. The byte, call and time budgets still bound research.

The original live baseline fetched 60 records across three pages but withheld the
shortlist because only listed total space was returned, not usable area. The
revised shared evidence contract permits a clearly labelled provisional comparison
using the recorded field without claiming it establishes usable/carpet area.
Both fresh private trials passed the real outcome: review 60 unique records, return
five grounded provisional options and preserve units/uncertainty. Delivery was
capture-only through real Supabase and the production Context Engine.

Those trials took 86.8 and 72.1 seconds, with about 191k and 232k cumulative model
input tokens across stages. These are two task observations, not p95 estimates or
a controlled performance improvement. The source interface already allowed 25-row
pages; the baseline model used that maximum. The new benefit is explicit coverage
and useful synthesis, not a claim that merely changing a prompt made reads faster.

## Review findings and next work

| Priority | Finding                                                                                                                  | Recommended next change and acceptance evidence                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Process readiness missed the deployed feature flag and roster RLS failure.                                               | Add a capture-only post-deploy capability check using the actual runtime configuration: identity resolution, permitted catalogue, source read, full graph and delivery authorization. Report the affected capability without exposing private content. Test inactive/unknown employees too. |
| P0       | The paid quality workflow is manual/opt-in weekly, not required by CD.                                                   | Define a release decision using frozen repeated outcomes, deterministic authority checks and a human-reviewed holdout. Preserve failed attempts and distinguish provider failures from agent quality. Never convert a judge-only regrade into a new agent pass rate.                        |
| P1       | Account-wide sequential processing makes a long research turn delay other chats.                                         | Preserve one writer per conversation while allowing bounded concurrent conversations. Test same-chat ordering, separate-chat progress, restart recovery and outbound fencing before enabling concurrency.                                                                                   |
| P1       | Each worker continuation and final review carries large amounts of repeated evidence; MCP reconnects/discovers per read. | Profile tokens and latency; introduce lossless retained evidence with compact, retrievable working results and carefully scoped connection reuse. Keep fresh authority and delivery checks. Test the later turn that needs an omitted detail.                                               |
| P1       | Business access/catalogue discovery happens before the converser even for ordinary chat.                                 | Separate a cheap conversational route from business initialization with tested escalation to tools. Avoid adding mandatory domain retrieval to every greeting.                                                                                                                              |
| P1       | Analytics exists locally but is not available on the production signing path.                                            | Isolate the intended Context Engine auth changes from concurrent repository edits; deploy, update server key scopes and worker scopes together, then test admin, analyst, ordinary employee and revocation paths.                                                                           |
| P1       | The assistant can prepare work but cannot maintain a durable personal task/reminder lifecycle.                           | Add explicit reminder/task state with due time, cancellation/snooze, timezone and missed-time policy. A scheduler rechecks business conditions before placing ready messages in the outbound queue. Keep scheduled intent separate from delivery retries.                                   |
| P1       | SLA/escalation producers are still specifications.                                                                       | Implement deterministic source rules, breach episodes, deduplication and recovery. Recipient order is **assignees, then existing CRM admins**, as agreed. Evaluate resolved/reassigned leads, source outages and repeat suppression.                                                        |
| P1       | No business writes are enabled.                                                                                          | Add narrow command adapters with current authority, exact target/arguments, idempotency, reconciliation and verified postconditions. Record durable outcomes before saying “done”. Never replay a write as a delivery-time read.                                                            |
| P2       | Memory is a recent-message window plus protected recall, not enduring preferences/commitments.                           | Design explicit per-person memory with provenance, correction/deletion, scope, expiry and contradiction handling. Test cross-day continuation and changes in permissions.                                                                                                                   |
| P2       | The run journal is not a resumable graph checkpoint.                                                                     | Add checkpoints/task state before long background work, approval pauses or multi-day workflows. Define cancellation and terminal outcomes. A crash currently restarts bounded reads from the beginning.                                                                                     |
| P2       | Adding an arbitrary MCP tool is not plug-and-play.                                                                       | Current registration/evidence adapters cover 17 read tools. New reads/doc analysers need schema, evidence, timeout and permission contracts; write tools need a separate executor. Preserve a general assistant rather than hardcoding more business workflows.                             |
| P2       | Media checks lack representative human Hindi/Hinglish recordings and difficult real documents.                           | Maintain private labelled audio/document holdouts covering negation, names, numbers, noisy notes, mixed languages, expiry and forward ordering. Synthetic voice benchmarks cannot establish human speech accuracy.                                                                          |
| P2       | Traces exist, but routine production quality review and spending controls remain limited.                                | Add sampled review, task/tool success, end-to-end latency, token/cost and queue-age metrics with owners and rollback criteria. Add per-person/org usage budgets and targeted alerts. Do not expose confidential records in metric labels.                                                   |

HRMS, calendar/email integrations, autonomous outbound user tasks, business writes,
scheduled reminders, SLA producers and general web browsing are not current tool
capabilities. A fluent plan or drafted message does not perform any of them.

## AI Engineer research and application

The following recommendations are this review's application of the talks to
Ramesh, not claims that the speakers audited this code.

- Vinoth Govindarajan separates model proposals from application commits and
  durable evidence of outcomes. His session-state and execution examples support
  testing a real deployed identity-to-delivery path, retaining receipts, and
  moving from account-wide serialization to ordered per-conversation processing.
  Ramesh already has valuable queue/receipt boundaries; today's incident shows why
  fixture success and process health are insufficient.
  [Your Agent Didn’t Fail. Your Harness Did.](https://ai.engineer/talks/BInpv7lGp1o-your-agent-didnt-fail-your-harness-did)
- Phil Hetzel describes progressing from documented human judgments to automated
  scorers, production-derived traces and replay, while checking the judges
  themselves. Apply this with employee-labelled outcomes, retained private source
  snapshots, replay that cannot send/change production data, and explicit
  adjudication when a grader rejects a valid answer.
  [The maturity phases of running evals](https://ai.engineer/talks/FB-MLPhL9Ms-maturity-phases-running-evals)
- Nishant Gupta treats the whole workflow as the evaluation unit and includes
  reliability, recovery, latency and resource use alongside answer quality.
  Measure Ramesh from accepted message through authorized captured/delivered
  reply, including queue delays, tool failures, partial results and the user's
  outcome. Bring reviewed production incidents back into regression cases.
  [Production Evals For Agentic AI Systems](https://ai.engineer/talks/vljxQZfJ9wY-production-evals-agentic-ai-systems)
- Sally-Ann DeLucia distinguishes active context from retained, retrievable
  memory and tests the later turn where forgotten context becomes necessary.
  Apply that to bulky pagination results and cross-day follow-ups. Preserve a
  route back to omitted evidence instead of relying on arbitrary truncation or
  lossy summaries; measure whether retrieval helps the actual task.
  [How We Solved Context Management in Agents](https://ai.engineer/talks/esY99nYXxR4-we-solved-context-management-in-agents)
- Leonie Monigatti describes different retrieval interfaces for exact lookup,
  search and aggregation, and makes tool selection/parameter semantics explicit.
  Keep Ramesh's summaries for totals, native cursor searches for pools and detail
  reads for selected records. Improve descriptions and bounded query recovery
  before introducing more agent roles. A generic shell/database tool would need
  a different authority boundary; the talk does not justify giving this bot SQL.
  [Agentic Search for Context Engineering](https://ai.engineer/talks/ynJyIKwjonM-agentic-search-context-engineering)

## Evaluation evidence and interpretation

The combined pagination and delivery increment passed 237 deterministic/integration tests with no skips,
plus Prisma validation, TypeScript, build and formatting checks. The private
production-source pagination task passed two independent agent executions. Raw
records, requests and answers remain ignored and private.

The first fictional pagination run scored 8/12 automatically. All four failures
were the judge incorrectly requiring Created on warehouse cards. Retained answers
had grounded winners, accurate coverage and appropriate partial-result wording.
The evaluator now explicitly confines that card rule to CRM, while keeping dates
required when the user requests them. Three contrastive examples were added;
the complete updated calibration passed **62/62** (31 examples, twice each).

An attempted 160-trial full run was interrupted after a burst of immediate model
request failures; its retained partial artifacts are not a completed quality
baseline. The prior complete baseline and judge-only regrades are documented in
[the historical evaluation report](../evals/results/2026-10-02-eval-refinement.md).
Final validation and release status for this increment are recorded in the
[production access and pagination report](../evals/results/2026-10-02-production-pagination.md).

No reported score establishes a general production success rate. Public fixtures,
private live-source tasks, security checks, human judgment and production traces
cover different failure modes and should remain distinguishable.
