# Ramesh agent module specifications

Updated: **2 October 2026**. Status: **Specifications prepared first; the personal-assistant graph, media and batching are deployed. Production CRM/supply/knowledge reads are enabled for active employees; analytics is connected in the local full-scope capture profile.** Unconfigured installations remain closed to business tools by default. Reminder, SLA and write modules are specifications, not implemented capabilities.

These files expand the [architecture plan](../assistant-architecture-plan.md#23-agent-architecture-draft-informed-by-the-factory-talk) into module contracts. They describe a target system, including changes to existing modules. A proposed interface, table, configuration option or test below does not exist merely because it is documented here.

The deployed baseline contains the converser, formatter and separate queues. This checkout adds native model-directed reads over every employee-permitted CRM, supply, knowledge, shortlist and analytics tool, deterministic source checks, fresh semantic answer review, encrypted receipts and delivery reauthorization. See the [personal-assistant runbook](../sales-manager-agent.md). Separate planner/worker model roles, private media ingestion, and durable sliding debounce are implemented locally; durable paused-task checkpoints, reminders and writes remain proposed. Documentation and local tests do not activate production reads.

## Module map

| Spec                                                                   | Responsibility                                                         | Current foundation                                                   |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [00. Shared contracts](00-shared-contracts.md)                         | Cross-module data types, versions, outcomes and ownership              | Tool sessions/evidence/receipts; generic task contracts proposed     |
| [01. Inbound admission](01-inbound-admission.md)                       | Trusted transport events, eligibility, deduplication and run admission | Existing mapper and Supabase inbound queue                           |
| [02. Identity resolver](02-identity-resolver.md)                       | Phone/LID to one active employee                                       | Integrated for every tool and delivery                               |
| [03. Context credentials](03-context-credentials.md)                   | Employee-bound service signatures and credential lifecycle             | Signed adapter integrated                                            |
| [04. Conversation context](04-conversation-context.md)                 | Audience-separated history, entity references and pending input        | 32-message inbox; freshly authorized private recall                  |
| [05. Converser](05-converser.md)                                       | Intent, ordinary chat, clarification and capability honesty            | Personal chief-of-staff router; direct chat or planned work          |
| [06. Planner](06-planner.md)                                           | Bounded plans and success assertions                                   | Implemented: structured outcome plan and schema/reference validation |
| [07. Worker](07-worker.md)                                             | Task execution decisions and structured handoffs                       | Separate native worker session and deterministic executor            |
| [08. Tool executor](08-tool-executor.md)                               | Deterministic validation, budgets and recorded tool outcomes           | Schema-checked read executor and encrypted receipts                  |
| [09. Context Engine adapter](09-context-engine-adapter.md)             | MCP transport, domain methods and evidence envelopes                   | All permitted read tools integrated                                  |
| [10. Verifier](10-verifier.md)                                         | Operational checks and independent semantic review                     | Code checks and fresh semantic review                                |
| [11. Formatter](11-formatter.md)                                       | Natural WhatsApp wording and factual preservation                      | Style model and final evidence review                                |
| [12. LangGraph orchestrator](12-langgraph-orchestrator.md)             | Run lifecycle, routing, corrections, cancellation and resumption       | General bounded tool loop; paused resume deferred                    |
| [13. Supabase persistence](13-supabase-persistence.md)                 | Runs, events, checkpoints, transactions and recovery                   | Minimal run/event journal; checkpoints deferred                      |
| [14. Outbound delivery](14-outbound-delivery.md)                       | Saved replies, delivery authorization and uncertain sends              | Saved replies and protected-result preflight                         |
| [15. Reminders](15-reminders.md)                                       | Editable personal schedules and due-time notification preparation      | Proposed                                                             |
| [16. SLA escalation](16-sla-escalation.md)                             | CRM-owned breach episodes and recipient progression                    | Existing CRM-Automations context; bot delivery proposed              |
| [17. Business actions](17-business-actions.md)                         | Future typed writes, confirmations and reconciliation                  | Deferred                                                             |
| [18. Model runtime](18-model-runtime.md)                               | Provider adapter, structured outputs, prompts and usage limits         | Existing OpenAI Responses adapter                                    |
| [19. Evaluation harness](19-evaluation-harness.md)                     | Deterministic checks and repeated model evaluations                    | 85 multi-turn scenarios, protected CI and real-data capture smoke    |
| [20. Observability and playground](20-observability-and-playground.md) | Operator traces, fake-chat inspection and recovery visibility          | Synthetic CRM GUI and run-correlated traces                          |
| [21. Live-data playground](21-live-data-playground.md)                 | Real authorized reads with isolated Supabase capture queues            | Verified live as Raghav; no WhatsApp delivery                        |

Numbers are reading order, not a requirement to implement independent services for every specification. These are modules in the current worker, plus the existing Context Engine, CRM-Automations and separate admin application. The [live playground runbook](../live-data-playground.md) documents the implemented test boundary and commands.

- [22. General employee tool loop](22-sales-manager-tool-loop.md): implemented native tool orchestration, review and evidence contracts.
- [23. Logistics-bot context/media reference](23-context-and-media-reference.md): historical source review; module 30 defines the implemented media lifecycle.

## Shared decisions

- Production conversation, queue and agent-run state belongs in Supabase/Postgres. The real-data playground also uses Supabase, under separate test tables and a dedicated capture login. SQLite remains the existing device/admin store and optional synthetic chat/eval fixture.
- The selected identity path is trusted WhatsApp phone/LID → active `VerifiedNumber` employee → signed Context Engine request. No employee OAuth enrollment is required.
- Unknown, ambiguous or inactive identities may chat, but cannot access business data. Initial business tools are DM-only.
- Reuse Context Engine's bounded read tools. Direct domain-backend read endpoints remain deferred; arbitrary SQL and arbitrary HTTP tools are excluded.
- Model roles propose work. Code controls authority, budgets, side effects, records of execution and delivery destinations.
- Fast paths handle ordinary chat and known lookups. Complex tasks use contracts, scoped workers, independent verification and bounded correction.
- CRM SLA rules belong to CRM-Automations. Notify assignee(s), then existing CRM admins. Personal reminders and CRM activities remain different entities.
- Tests use captured delivery. Activating a real WhatsApp connection is not part of implementing or validating these module contracts.

## End-to-end dependency flow

```mermaid
flowchart TD
    IN[Inbound admission] --> ID[Identity and context]
    ID --> O[LangGraph orchestrator]
    O --> C[Converser]
    C -->|Business request| P[Preset contract or planner]
    P --> W[Worker]
    W <--> X[Tool executor]
    X --> AUTH[Credentials and MCP adapter]
    W --> V[Verifier]
    V -->|Repair within budget| O
    V --> F[Formatter and final checks]
    C -->|Chat or clarification| F
    F --> DB[Atomic run and outbound handoff]
    DB --> SEND[Delivery authorization and Baileys]
```

Persistence, model runtime, evaluation and observability support this flow. Reminder and SLA producers join at the durable notification boundary, not by simulating employee chat messages.

## Implementation increments

| Increment                          | Modules                          | Required result                                                                                        |
| ---------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A. Contract and fixture foundation | 00, 04, 18, 19                   | Shared schemas, synthetic identities/evidence, recorded outcomes and capture-only execution            |
| B. First CRM read                  | 01–05, 07–14, 20                 | Assigned-follow-ups preset, current identity/scope checks, verified private reply and durable recovery |
| C. Complex reads                   | 06–12, 19                        | Lead-to-supply workflow, independent verification and measured correction behavior                     |
| D. Concurrent conversations        | 01, 12–14, 20                    | Per-conversation fencing and independently paced delivery, with contention tests                       |
| E. Reminders and escalation        | 15–16 plus persistence/delivery  | Due processing, cancellation, active recipients and non-sending policy preview                         |
| F. Business writes                 | 17 plus relevant domain handlers | Narrow commands, scoped confirmation and authoritative reconciliation                                  |

For increment B, the worker can be a deterministic preset executor. A model-directed worker and general planner are not prerequisites for the first lookup. Keep the existing account-wide serialization until increment D has its own migrations and tests. Durable storage and delivery authorization are prerequisites for production business replies even during the small pilot.

The general loop uses `ContextToolRun`, `ToolEvidence`, `ToolDelivery`, `BusinessReadService` and the existing message repository; the original preset types remain regression fixtures. It does not create every generic type in spec 00. Migration `202610010004` supplies minimal run/event tables and atomic finalization. A pre-handoff crash restarts the side-effect-free read; a post-handoff crash reuses saved output. This intentionally defers a general LangGraph Postgres checkpointer until workflows need intermediate-step resumption, interrupts or correction loops. Spec sections describing those capabilities remain target contracts, not current behavior.

Initial retention follows the existing 30-day encrypted message cascade. Admin inboxes show a private placeholder. Model history contains only a content-free completion marker for delivered business replies. All active trusted employees are eligible by default when reads are enabled; an explicit employee list remains optional. per-person daily spend enforcement remains future work beyond the current bounded request and queue limits.

## Readiness and unresolved decisions

Each file gives its interface, state/failure rules, acceptance cases and dependencies. Acceptance cases are implementation requirements, not claims of tests already passing. Future test names are illustrative.

The following remain product or integration decisions, with a specific owner rather than a guessed default:

| Decision                                                      | Relevant spec | Effect                                                    |
| ------------------------------------------------------------- | ------------- | --------------------------------------------------------- |
| Production rollout and run/spend limits                       | 12, 18        | Required before enabling business reads                   |
| Evidence retention and operator access                        | 04, 13, 20    | Required before persisting business content in production |
| Reminder ambiguity, quiet hours and catch-up policy           | 15            | Required for scheduler rollout                            |
| SLA thresholds, grace, recurrence and recipient authorization | 16            | Required for automatic notifications                      |
| Command catalogue and confirmation policy                     | 17            | Required before business writes                           |
| Group-safe business scope and private handoff behavior        | 01, 04, 14    | Deferred; business reads remain DM-only                   |

Use the parent plan for product intent and this directory for detailed contracts. The [shared contracts](00-shared-contracts.md) define names used across specs. If implementation reveals a conflicting interface, update the affected contracts together before wiring the modules.

- [24. Business recall and deal display](24-business-recall-and-deal-display.md): protected selection/order recall, native CRM dates, compact shortlists and conversation evals.

- [25. Analytics and continuous evaluation](25-analytics-and-continuous-evaluation.md): source calendars, full scoped catalogue, editable prompts and CI reports.
- [26. Coworker loop and context](26-coworker-loop-and-context.md): personal chief-of-staff role, transcript/reference findings, repair routing and remaining architecture limits.

- [27. Adversarial review](27-adversarial-review-and-response-contracts.md): bounded recovery, per-record display checks and requested-versus-confirmed facts.
- [28. Model and effort comparison](28-model-and-effort-comparison.md): Responses compatibility, explicit planning references and a fixed-judge Sol/Terra experiment.

## New graph, media and batching contracts

- [29. Planner, worker and verifier](29-planner-worker-verifier.md): separate model roles and deterministic executor.
- [30. Media lifecycle](30-media-lifecycle.md): encrypted same-owner image/PDF/voice extracts, 24-hour expiry and cleanup.
- [31. Private outcome evals](31-private-outcome-evals.md): real-data operator tests, excluded from git and CI artifacts.
- [32. Inbound debounce](32-inbound-debounce.md): forwarded text/media use a sliding 3-second window; ordinary text uses 1 second; total collection capped at 8 seconds.

Production schema migration `202610020005` is a prerequisite for this worker revision. Audio is uploaded directly to STT, so the worker does not require `ffmpeg`. The separate Supabase capture schema is upgraded through `202610020002`. The local real-data playground uses Sol at medium tool effort. No WhatsApp connection or production queue migration is performed by its setup.

- [33. Evaluation refinement](33-eval-refinement.md): calibrated per-turn judgments,
  consistent fixtures and clocks, semantic query checks, and bounded research with
  time reserved for verified finalization.
- [34. Tool extensibility](34-tool-extensibility.md): current compatibility,
  adapter boundaries for reads/documents/writes, and outcome-oriented regression
  coverage without prescribing one business workflow.

- [35. Voice transcripts](35-voice-transcripts.md): exact quoted/italic audio text before one batch answer, expiring references, independent STT credentials.
- [36. Transcription evaluation](36-transcription-evaluation.md): current model/pricing research and repeatable synthetic audio comparisons.
- [37. Production evaluation](37-production-evaluation.md): primary-source research, current harness gaps, outcome contracts, private holdouts, judge calibration and proposed release/monitoring practices.
- [38. Direct audio transcription](38-direct-audio-transcription.md): original-byte uploads, Ogg compatibility evidence and removal of the runtime transcoding dependency.
- [39. Paginated research](39-paginated-research.md): unique coverage, cursor progress, broad-search outcomes and the production roster access correction.
- [40. Delivery acknowledgements](40-delivery-acknowledgements.md): concurrent LID resolution, durable failure notices and normal WhatsApp delivery receipts.

- [41. Recall and source labels](41-recall-and-source-labels.md): changed-result recovery, current-source continuations and inert labels across CRM, knowledge and analytics.
- [42. Evaluation spending](42-evaluation-spend-controls.md): Luna defaults, bounded case selection, explicit Sol approval and manual-only paid CI.

See the [2 October production capability review](../capability-review-2026-10-02.md) for deployed versus local-only capabilities, remaining work and AI Engineer research.
