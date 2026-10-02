# Ramesh adversarial implementation audit

Scope: the current Ramesh working tree, starting from `2ab4072`, including the
new P0A accounting and P0B readiness implementation. Reviewed on 3 October 2026.
This is a code and fixture audit, not a penetration test or a certification of
production. No production credentials, live business records, WhatsApp recipients
or paid model evaluations were used. Context Engine is an external trust boundary;
its signing/replay path received limited inspection, not an exhaustive server audit.

The review covered four questions: can the system exceed its intended authority
or spend, can valid work fail unnecessarily, is functionality only partially
implemented, and does the architecture add work without improving the outcome?
Findings below distinguish confirmed defects from rollout gaps and design work.

## Confirmed defects addressed in this change

P1 means material privacy, resource or spending exposure; P2 means a narrower
correctness, reliability or diagnostic defect. These finding priorities are
separate from the research roadmap's P0/P1 phase names. Accounting findings
include defects caught in the new implementation before rollout.

| Priority   | Finding                                                                                                            | Resolution and evidence                                                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1         | Employee/run accounting split across resumed media, group chat and capture batch members.                          | Preserve trusted same-run attribution; resolve billing identity independently of business access; use the durable batch root. [Attribution tests](../tests/unit/usage-attribution.test.ts).                                                                                                                                      |
| P1         | An enabled policy could reach an adapter without the shared meter.                                                 | Constructors fail before a provider request. [Text adapter](../src/infrastructure/openai/text-model.ts), [meter fixtures](../tests/unit/usage-meter.test.ts).                                                                                                                                                                    |
| P1         | Audio admission could assume text rates; project-level service tier could invalidate a price profile.              | Require the audio rate, request standard tier explicitly, reject unsupported billing modes, retain unexpected-tier charges as unknown. [Pricing](../src/modules/usage/usage-pricing.ts), [HTTP meter](../src/modules/usage/usage-meter.ts).                                                                                      |
| P1         | SDK retries, ambiguous failures and auxiliary calls were not reliably represented by stage-success token reports.  | Reserve each actual HTTP attempt and retain unknown charges; share caps across text, media and graders. [Ledger tests](../tests/unit/usage-ledger.test.ts), [PostgreSQL tests](../tests/integration/usage-ledger.test.ts).                                                                                                       |
| P1         | Evaluation artifacts could be reused to reset a campaign; failed workers could leave reporting incomplete.         | Exclusive policy creation, latched campaign denial and reporting after all admitted workers settle. [Evaluation contract](../evals/lib/usage-budget.ts).                                                                                                                                                                         |
| P1         | View-once media nested inside a supported wrapper could reach normal persistence.                                  | Check privacy provenance before normalization at admission and download; reject view-once flags and excessive depth. [Guard](../src/infrastructure/whatsapp/media-privacy.ts), [privacy regressions](../tests/unit/media-privacy.test.ts).                                                                                       |
| P1         | Burst ingress started unbounded downloads before the extraction semaphore or database quotas applied.              | At most three downloads retain buffers through persistence; exact source lookup avoids repeated old downloads; permanent stop cancels queued work without disabling later reconnects. [Ingress implementation](../src/infrastructure/whatsapp/durable-messages.ts), [burst fixtures](../tests/unit/media-ingress-limit.test.ts). |
| P2         | Caller cancellation and the nominal media deadline waited behind multi-wave extraction.                            | Cancel reader waits promptly; do not start queued reader work after cancellation; preserve reusable extraction and abort service-owned work before shutdown drain. [Media lifecycle](../src/modules/media/media.service.ts), [lifecycle tests](../tests/unit/media-lifecycle.test.ts).                                           |
| P2         | Raw SDK warn/error objects, child bindings and text could enter logs despite shallow redaction.                    | SDK-only logging exposes fixed events, severity and allowlisted transport codes. [Logging boundary](../src/infrastructure/whatsapp/sdk-logger.ts), [sentinel tests](../tests/unit/sdk-logger.test.ts).                                                                                                                           |
| P2         | Receipt expiry or India midnight could occur during asynchronous delivery verification.                            | Recheck the original reply's freshness after all reads in both receipt paths. [Delivery boundary](../src/modules/assistant/business-reads.ts), [fake-clock tests](../tests/unit/receipt-freshness.test.ts).                                                                                                                      |
| P2         | An old prompt equated changed source data with a changed historical selection.                                     | Align the chief-of-staff instruction with the actual recall contract; prompt version is v23. [Prompt](../src/prompts/chief-of-staff.md). Exact selection persistence remains a separate gap below.                                                                                                                               |
| P2         | A UUID-shaped document/tracking reference could be rejected as an internal CRM ID.                                 | Suppress identifiers proven to come from CRM records, retaining that provenance even when evidence expires. [Identity helpers](../src/modules/assistant/record-identity.ts), [display guard](../src/modules/assistant/deal-display.ts).                                                                                          |
| P2         | Cached evidence expires at 120 seconds while research can continue longer; reuse previously aborted the whole run. | Retire stale snapshots and refresh through normal authorization, cancellation, call and cumulative-byte budgets. Remove recalled prose if any supporting snapshot is retired. [Executor](../src/modules/assistant/tool-executor.ts), [refresh tests](../tests/unit/evidence-refresh.test.ts).                                    |
| P2, latent | A future optional SDK preview dependency could trigger server-side URL/thumbnail fetching from generated text.     | Set `linkPreview: null`; links remain text. The actual SDK serializer fixture verifies no preview callback. [Transport test](../tests/unit/outgoing-text.test.ts). This is not a claim of current production SSRF.                                                                                                               |

No production log leak or actual view-once download was observed. Those findings
come from reachable code paths and synthetic regressions. Sanitizing SDK logs
reduces their diagnostic detail deliberately; application-authored lifecycle
and error events remain separate.

## Boundaries checked and retained

- Business identity comes from the trusted WhatsApp sender/LID mapping and active
  roster. A billing subject does not grant a business tool. Unknown users retain
  ordinary chat, with business authorization still performed separately.
- Tool availability is intersected with server-side read policy and employee
  authority. Source content and model-selected arguments do not select credentials.
- Business replies retain delivery-time reauthorization and source receipts.
  A source failure is not an authorized empty result.
- Capture and production use different queue/media/usage namespaces and database
  roles. Local PostgreSQL checks cover cross-role denials, concurrent reservations,
  durable state, replay and uncertain delivery handling.
- The readiness command composes existing identity/MCP/receipt checks without a
  model, application startup or WhatsApp sender. Its report excludes source rows
  and credentials. It is an operator check, not an impersonation endpoint.

These are checks of specific paths, not claims that prompt injection, credential
compromise or provider errors are impossible. Ledger RLS settings are service-owned
context; possession of the runtime database credential remains a trust boundary.

## Remaining rollout and implementation work

| Priority                             | Gap                                                                                                                                                  | Concrete next action                                                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before enabling budgets              | `USAGE_MODE` is off by default; production migrations, model price profiles and monetary caps have not been installed in this task.                  | Apply the separate production/capture migrations, configure reviewed profiles and explicitly chosen caps, observe once, then enforce. Do not treat checked-in code as an active production control. |
| Before claiming capability readiness | The new model-free probe has not run against the deployed worker environment and is not automatically part of CD.                                    | Choose an active probe employee and required sources, then run it once under the actual worker account/configuration. Preserve process-health checks separately.                                    |
| Before remote paid evaluations       | A local grader budget cannot control agent work in an already-running remote capture server.                                                         | Add a server-enforced authenticated campaign allowance shared by graph, media and grader. Until then, the private HTTP runner fails before making a request; in-process smoke remains metered.      |
| Before reconciling unknown charges   | Unknown/pending reservations do not expire and cannot be rewritten as zero.                                                                          | Add an audited adjustment process using provider evidence. Do not delete ledger rows to replenish an allowance.                                                                                     |
| Before enabling duration-priced STT  | Compressed bytes do not establish a safe maximum audio duration.                                                                                     | Establish a trusted duration/input bound and its accounting contract, or keep token-priced transcription with reviewed ceilings.                                                                    |
| Operational budget scope             | Separate API consumers, account IDs and purposes have independent allowances. New bucket configuration does not reconstruct past untracked spending. | Maintain provider-account billing controls and activate policy at a documented accounting boundary.                                                                                                 |

## Remaining architecture findings

These are distinct from the defects fixed above. The next changes should reduce
repeated work and centralize contracts. The research roadmap's P1–P8 remains
staged work; reminders, SLA episodes, business writes and resumable tasks are not
implemented by this change.

1. **Ordinary chat waits on business initialization.**
   [sales.graph.ts](../src/modules/assistant/sales.graph.ts) opens scoped MCP/context
   before routing every turn. A greeting can wait for the roster/catalogue during
   a business outage. Initialize business access lazily after ordinary-chat
   routing, while keeping protected history hidden until authorization.
2. **Exact historical selections are not persisted.**
   [business-recall.ts](../src/modules/assistant/business-recall.ts) compares source
   page hashes and withholds previous prose on changed data. Hashes cannot recover
   the second option when the answer selected B,D,A from twenty returned rows and
   an unrelated field later changes. Persist validated owner-scoped selected IDs,
   order and source references; reauthorize current access on recall. The corrected
   prompt reduces false claims but does not solve this storage gap.
3. **Delivery depends on every exploratory read.**
   [tool-executor.ts](../src/modules/assistant/tool-executor.ts) builds a receipt
   from all accepted evidence; [business-reads.ts](../src/modules/assistant/business-reads.ts)
   rereads all checks. An irrelevant page update can suppress an otherwise valid
   selected answer, while increasing source work. Add explicit claim/selection
   dependencies before narrowing receipts; do not bypass revalidation.
4. **Durable queues and journals are not resumable graph checkpoints.**
   [sales.graph.ts](../src/modules/assistant/sales.graph.ts) keeps the tool session,
   evidence and step state in closures and compiles without a checkpointer.
   [text-model.ts](../src/infrastructure/openai/text-model.ts) retains native tool
   continuation/reasoning only in memory. Restart repeats unfinished paid work.
   Add versioned logical checkpoints and reauthorize on resume before building
   reminders or write actions. Accounting retains earlier charges across restart.
5. **One conversation blocks other queued processing.**
   [durable-messages.ts](../src/infrastructure/whatsapp/durable-messages.ts) awaits
   each claimed job; [message-queue.repository.ts](../src/infrastructure/database/message-queue.repository.ts)
   and active-lease indexes also enforce account-wide exclusivity. A multi-minute
   task delays every employee, potentially past the five-minute inbound expiry.
   Bounded downloads do not solve this. Roadmap P1 needs per-chat claims/indexes,
   ordering, lease fencing, aggregate budgets and fairness/restart tests; simply
   running several consumers cannot bypass the existing database exclusion.
6. **MCP catalogue paging is deliberately unsupported.**
   [mcp-client.ts](../src/infrastructure/context-engine/mcp-client.ts) rejects
   catalogue `nextCursor`. Add bounded catalogue traversal before expanding beyond
   today's one-page tool set. This differs from business-result pagination, which
   already has dedicated handling.
7. **Argument recovery still contains a CRM-specific instruction.**
   [tool-executor.ts](../src/modules/assistant/tool-executor.ts) supplies CRM date
   advice for every `INVALID_ARGUMENTS`, including analytics tools. Replace it
   with schema/source-specific recovery metadata or a generic schema fallback.
8. **Writes need a distinct execution contract.** Existing discovery is intersected
   with a read vocabulary and evidence validators. Exposing a new write tool
   requires least privilege, validated intent, idempotency, postcondition checks
   and an explicit confirmation policy. Discovery alone is not write compatibility.

9. **Transient media failures cannot recover on the retained copy.**
   [media.service.ts](../src/modules/media/media.service.ts) maps extraction
   failures to one terminal state; [media.repository.ts](../src/infrastructure/database/media.repository.ts)
   reclaims pending/expired processing, not failed rows. An outage, budget denial
   or shutdown-aborted extraction therefore remains failed until expiry or a new
   source message. Add typed failure classes and bounded explicit retry/backoff,
   preserving earlier unknown charges. This pass fixes cancellation, not recovery.
10. **Optional group metadata delays durable admission.**
    [baileys-client.ts](../src/infrastructure/whatsapp/baileys-client.ts) awaits
    `session.chatName` before enqueue/receipt on the shared event queue. A slow cold
    group lookup delays persistence for other chats and can fill that queue.
    Enrich names after durable admission or use a separately bounded lookup; test
    hung metadata with a burst of unrelated messages.
11. **Unmentioned group audio is not collected for a later summary.** Observed
    unmentioned group messages do not enter media ingestion. Several forwarded
    voice notes followed by a final mention cannot currently recover all those
    earlier notes. Decide an explicit group collection policy before changing its
    privacy, storage and spending behavior; DM batching is a different path.
12. **Multi-account database isolation is incomplete in older tables.** Older
    queue/media/agent policies use broad runtime-role access while repositories
    enforce account/owner predicates. This is the current restricted single-worker
    trust model, not a newly observed leak. Before hosting mutually untrusted
    accounts under one credential, tighten policies or use separate runtime roles.

## Optional simplifications and tradeoffs

- The active graph always plans business work and runs semantic verification even
  for direct chat. Ordinary greetings take three model stages; a basic business
  read commonly takes six. Consider optional planning and selective semantic
  review only with outcome checks. Deterministic authority/delivery checks stay.
- Full evidence is sent separately to formatter/verifier and appended to worker
  history; recall can duplicate it. Use canonical evidence handles plus useful
  task projections and claim coverage. Arbitrary truncation would lose grounding.
- `assistant.service.ts` retains ordinary chat, fixed follow-up and dynamic tool
  graphs. Production uses the dynamic graph; this is not a remaining production
  “today only” restriction. Consolidate after identifying compatibility consumers.
- Capability information appears in discovery, scope mapping, planning, evidence
  and display layers. Centralize shared metadata before extending the tool set.
  This change removes the new executor-to-presentation dependency by keeping CRM
  provenance in `record-identity.ts`.
- Repeated identity/catalogue/receipt reads have a correctness purpose. Measure
  their cost and use request-scoped reuse with explicit invalidation; a long-lived
  permission cache can defeat revocation.
- Conservative cost reservations can reject requests that would eventually cost
  less. Improve enforceable request bounds rather than substituting optimistic
  token guesses. Price profiles are assumptions to review, not invoice guarantees.

The localhost playground remains a single-operator trust model. Host/origin/token
checks do not authenticate mutually untrusted local OS users. Add real operator
identity before exposing it through a shared host or tunnel.

## Validation and limits

Validation uses real SDK serialization with injected fake fetch, synthetic model
and source fixtures, and disposable local PostgreSQL databases. It covers
accounting, authorization boundaries, attribution, queue isolation and the
specific failure scenarios above. No paid quality score or production capability
result is inferred from deterministic checks.

Focused suites passed for readiness, attribution, currency admission, SDK retries,
evaluation approval guards, evidence refresh/recall, source identity, receipt
freshness, media privacy/cancellation/ingress and logging. Local PostgreSQL suites
passed for ledger isolation/concurrency, message handoff, capture and media
ownership/expiry. The new two-table migration required correcting the old table
count assertion; its permission checks then passed. TypeScript, production build
and formatting are checked separately from any response-quality evaluation.

At completion of this pre-rollout audit, the reviewed fixes were local and
uncommitted. The audit itself performed no production migration, environment
update, capability probe, deployment or WhatsApp test send. Subsequent release
results are recorded by the repository CI/CD runs and the rollout report.
Runtime metering remains off until explicitly configured. Media-reader cancellation
may leave an already-started shared extraction running; its charge remains in the
ledger and a turn's usage trace is a point-in-time snapshot, not proof that all
background work has settled.

See [usage policy and rollout](agent-modules/43-usage-ledger-and-budgets.md),
[capability readiness](agent-modules/44-capability-readiness.md) and
[evaluation spending rules](agent-modules/42-evaluation-spend-controls.md).
