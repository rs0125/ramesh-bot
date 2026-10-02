# Ramesh: product context and decisions

Current local increment (2 October 2026): separate converser → planner → worker/tool-executor → formatter → verifier roles; ordinary chat skips planning. Images, PDFs and voice notes use encrypted owner-scoped media records with 24-hour expiry. Forwarded messages and media use durable sliding inbound batching (1-second ordinary text, 3-second burst window, 8-second cap). The capture GUI accepts attachments and overlapping messages, with one response per batch. See [module specifications](docs/agent-modules/README.md) for current contracts and deployment prerequisites. Real-data private outcome cases and transcripts remain only under gitignored `.local/private-evals/`; `npm run eval:private` refuses CI.

Initial context captured on **2026-09-30**; updated on **2026-10-02** through the personal-assistant tool loop and real-data capture playground. This preserves earlier options; the [implementation reference](docs/current-implementation.md) and [architecture plan](docs/assistant-architecture-plan.md) describe the current direction.

## Current scope

The TypeScript Baileys worker replies to qualifying text DMs and real group @mentions with an **OpenAI Terra `converser → formatter` LangGraph flow**. Replies use natural WhatsApp language; the formatter and final style guard remove em dashes and discourage stock AI phrases. Without an OpenAI key, the transport baseline replies `hello`. DMs and group replies stay in their originating chat.

The worker and separate Next.js admin have independent packages, configuration, tests, and CI/CD. Their only runtime connection is the authenticated `/v1` HTTP API. The admin provides pairing, status, activity, and connect/disconnect/reconnect controls. Its operator login does not grant employee CRM access.

The live linked account belongs to the EC2 worker. The earlier local pairing is retired. Successful main CI deploys through GitHub OIDC and SSM. The current EC2 API is private, with no inbound security-group rules; Vercel access needs a separate network rollout. See [EC2 operations](docs/ec2-operations.md).

Supabase now holds `ramesh-inbound-queue`, `ramesh-outbound-queue`, message state, and transition history. Agent processing atomically saves the final reply before the sender delivers it. SQLite retains encrypted Baileys credentials/Signal keys, admin sessions, login limits, operator settings, and legacy claims. The two queue migrations and conversational/MCP releases have deployed successfully.

The selected real-data test path is `npm run dev:chat:live` at `http://127.0.0.1:3012`: real Supabase and signed Context Engine as the server-configured Raghav, with separate `ramesh-test-inbound-queue` and `ramesh-test-outbound-queue` tables and a dedicated capture login. It never constructs a WhatsApp sender. The duplicated phone was cleared from the support account at the user's request so Raghav resolves uniquely. See the [live playground runbook](docs/live-data-playground.md). Synthetic SQLite GUI/evals remain available for repeatable fixtures, and queue regression tests use isolated local PostgreSQL. **Do not send real WhatsApp test messages or start a second process with the production pairing.**

The default production graph has no live business tools until explicitly enabled. This checkout connects all permitted CRM, supply, knowledge, shortlist and analytics tools through a bounded LangGraph tool loop, with independent review and an encrypted run journal; see [personal-assistant implementation](docs/sales-manager-agent.md). The live capture playground enables that loop as Raghav. `createSignedEmployeeContextAccess` now supplies trusted phone/LID resolution, live active-employee checks and signed requests to the parallel Context Engine endpoint. No employee OAuth enrollment is needed. Unknown users can chat without business access. Separate planner/worker roles, media ingestion and durable debounce are implemented locally. Durable paused tasks, reminders and writes remain future work; dedicated domain endpoints remain deferred.

## Intended product

A personal chief of staff for each messaging user, helping with thinking, planning, prioritization, preparation, drafting and authorized company research. Sales is one capability; the role is not limited to salespeople. Potential uses include follow-up reminders, morning digests, urgent lead/task alerts, and questions about permitted CRM leads. Group access matters because useful context already lives in existing WhatsApp groups.

The harness should own WhatsApp connections, trigger rules, scheduling, permissions, and outbound delivery. An LLM can interpret requests and propose narrow actions, while application code decides whether and how to execute them. Keep reminder polling, due-time rules, and deduplication deterministic rather than calling a model on each scheduler tick.

## Rough authorization plan

The user's direction: **scope authorization to the person messaging the bot, and allow only open-to-the-organisation information in group chats**.

1. Resolve the authenticated sender's phone/JID to an active `VerifiedNumber` employee. Resolve WhatsApp LIDs through trustworthy protocol mappings; never infer an identity from a display name or message text.
2. Use the resolved immutable employee ID and current permissions for personal reads. A service signature authenticates Ramesh; Context Engine independently authorizes the employee. The model cannot choose an actor.
3. Keep group output to help, generic acknowledgements, and an explicitly reviewed organisation-wide knowledge source. An employee's personal CRM access does not make their lead data safe to publish to a group.
4. Route personal CRM results and reminder details to the requesting employee's DM. Tools should not accept arbitrary destinations or a user-selected identity.
5. Recheck active employee status and permissions when executing work. A future group knowledge policy also needs to consider guest/external group members: open within the organisation does not mean public.

Business credentials are loaded only with BUSINESS_READS_ENABLED; all active employees are eligible by default (`BUSINESS_READ_EMPLOYEE_IDS=all`), with optional numeric rollout lists. The general loop enforces trusted identity, DM audience, schema-validated tool proposals, server identity match and delivery reauthorization. Private CRM replies stay hidden from the admin inbox. Model history retains the last 32 messages; private answers are available only through employee-bound recall with fresh scoped reads and matching source fingerprints. See [business recall and display](docs/agent-modules/24-business-recall-and-deal-display.md). Migration 004 and deployment remain separate operational steps. See [signed access](docs/signed-context-auth.md); the legacy OAuth factory is optional.

## Selected AI and MCP direction

OpenAI Responses is the provider. Production configuration still defaults to `gpt-5.6-terra`; the current capture playground tests `gpt-6.1-sol` at medium tool reasoning effort. LangGraph owns ordinary chat and the separate research graph. The repository's MCP client uses Streamable HTTP with an employee-scoped credential resolver; see the [service contract](docs/assistant-architecture-plan.md#20-context-engine-mcp-service-scaffold). The read loop now separates converser, planner, native-tool worker, deterministic executor, formatter and verifier. Paused tasks remain deferred. Role prompts are editable Markdown under `src/prompts/`.

Earlier options, retained for context:

- **Claude's API MCP connector:** the discussion suggested starting here because the model can call a remote MCP server without a harness-side MCP client. Tool allowlisting, bearer authorization, employee consent, and token refresh still need explicit configuration. The original discussion also flagged a possible zero-data-retention limitation; recheck current Anthropic terms before choosing this path.
- **MCP client in the harness:** discover allowed tools and expose them to a model as ordinary tool definitions. More code, but the harness can audit calls, validate arguments, trim results, and enforce routing.
- Superseded restriction: the early CRM-only allowlist is no longer the product boundary. The user chose the full current employee-authorized read catalogue, including GA4 and Search Console.
- A proposed first CRM allowlist is `crm_filters`, `search_crm_leads`, `crm_summary`, `read_crm_lead`, `read_crm_lead_context`, and `crm_briefing`.
- Treat group messages and CRM notes as untrusted data, not instructions. Do not grant shell access, arbitrary HTTP requests, bulk messaging, or arbitrary database queries to the model.
- Cap steps, tokens, and per-person daily spend. Keep API keys server-side. Audit triggers, tool calls, results, and responses with suitable access controls and retention; use representative, sanitized runs as a regression set.
- Ground CRM answers in successful tool results, citing returned lead IDs/links and exposing missing or stale data rather than guessing.

**Current contract:** `/mcp` retains Claude OAuth. `/mcp/ramesh` accepts first-party Ed25519 request signatures with exact employee, method, URL, body digest, short expiry and one-use nonce. Context Engine independently checks current roster permissions. It stores only nonce hashes/expiry for this path; no employee grant is required.

## Transport options discussed

**Baileys:** useful for access to the account's existing WhatsApp groups and for free-form replies/DMs. It uses an unofficial WhatsApp Web connection, so account stability is not guaranteed. Passive listening and responding to mentions was proposed as the initial interaction style; no particular traffic pattern should be treated as ban-proof.

**Gupshup:** a possible official-provider transport for proactive DMs. The design discussion described a 24-hour customer service window and approved templates for messages outside it. A morning digest could be a utility template with a “Show list” quick reply, followed by richer responses after the employee replies. Template approval/category and actual account capabilities still need validation. Reference: [Gupshup messaging guide](https://www.gupshup.io/developer/guide?name=whatsapp-api-documentation) and [send-message API](https://docs.gupshup.io/reference/msg).

**Possible hybrid:** Baileys for existing groups and mention replies; a separate Gupshup number for scheduled reminders/digests and DM Q&A. A transport adapter would hide delivery differences from the reasoning layer, while tracking session windows independently for each provider/number. The team would have two bot contacts. This remains an option, not a decision implemented here.

Provider-specific claims copied from the discussion need rechecking before implementation:

- Official Groups API eligibility, small participant limits, whether the bot counts toward the limit, invite requirements, coexistence restrictions, and Gupshup beta/media support. Do not assume it can access existing team groups.
- The quoted India utility rate of roughly ₹0.145, an asserted 1 October 2026 service-message pricing change, and a claimed 1,000-message allowance. No prices or allowances are encoded in the scaffold.
- The original comparison said official APIs have “no ban risk” and a number will survive long term. Those are not guarantees; account/policy restrictions can still apply.

## Hermes / OpenClaw discussion

The earlier discussion considered either letting Hermes own WhatsApp or putting it behind the harness as an OpenAI-compatible reasoning service. It preferred keeping WhatsApp and side effects in the harness. It also preferred a small explicit tool loop over an autonomous, self-modifying personal-agent framework for this multi-user sales bot. Hermes/OpenClaw compatibility and runtime behaviour were not verified during this scaffold; neither is a dependency.

## Relevant existing repos

Paths below are relative to this folder. The initial organisational inspection was read-only. Subsequent worker-owned queue migrations and deployments are documented separately; they do not change CRM business tables.

| Repository / source                                                                                                                | Relevant findings                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`../Context_Engine/README.md`](../Context_Engine/README.md)                                                                       | Read-only REST/MCP over warehouse, reviewed knowledge, and CRM sources. Ordinary employees get creator/assignment-scoped CRM access; Analysts (including roster admins) can have broader access. |
| [`../Context_Engine/src/lib/mcp.ts`](../Context_Engine/src/lib/mcp.ts)                                                             | The actual tool catalog, including the six CRM tools above and separate analytics tools.                                                                                                         |
| [`../Context_Engine/src/lib/mcp-oauth.ts`](../Context_Engine/src/lib/mcp-oauth.ts)                                                 | OAuth token validation and revalidation of employee grants.                                                                                                                                      |
| [`../../CRM-Automations/README.md`](../../CRM-Automations/README.md)                                                               | Actual folder name is `CRM-Automations`. Existing RFQ intake, Twenty polling, local opportunity mirror, and scheduled sales briefings. Node.js 22 and Prisma 6.19.3.                             |
| [`../../CRM-Automations/prisma/schema.prisma`](../../CRM-Automations/prisma/schema.prisma)                                         | Shared `VerifiedNumber` roster; mirrored `opportunities`, `stage_transitions`, and `sync_checkpoints`. Most other tables belong to other systems.                                                |
| [`../../CRM-Automations/src/lib/sla.js`](../../CRM-Automations/src/lib/sla.js)                                                     | Existing source of truth for stage SLA thresholds, excluded stages, and IST formatting. Do not introduce a competing rule set in the bot.                                                        |
| [`../../CRM-Automations/src/services/morning-briefing.service.js`](../../CRM-Automations/src/services/morning-briefing.service.js) | Assignee-based briefing ownership, with exact matching after splitting the comma-separated `assigneeEmail` mirror field. A substring match alone is insufficient.                                |
| [`../Backend_Repository/src/services/gupshupService.js`](../Backend_Repository/src/services/gupshupService.js)                     | Existing Gupshup utility-template send pattern for warehouse review notifications. Parameters, app, number, and templates for this bot still need their own configuration.                       |

CRM-Automations uses Supabase `pg_cron`/`pg_net` to call secret-protected HTTP workers. Its “meaningful update” clock combines manual business-field changes with separate note/task activity streams; Twenty's generic `updatedAt` is not a substitute. The bot should reuse those clocks and the existing sync rather than create another poller.

General CRM, supply, knowledge, shortlist and analytics reads now work through the real-data capture harness. Production pilot enablement remains a separate migration/configuration/deployment step. The old logistics bot's app-owned context and media-pin patterns are documented in [module 23](docs/agent-modules/23-context-and-media-reference.md); the replacement media lifecycle is implemented in module 30 and exact voice delivery in module 35. Reminder tools and due-time checks come later, reusing CRM-Automations rules and **assignee(s), then existing CRM admins** escalation. Long-lived reminder state, cancellation and recipient rechecks remain to build.

Evaluation refinement is specified in `docs/agent-modules/33-eval-refinement.md`.
The current grader validates each delivered turn against full tool schemas and
converted source clocks; `npm run eval:judge` calibrates it on generic positive and
negative outcomes. Research reserves up to one quarter of the deadline (maximum
60 seconds) for formatting/verifying retained evidence. Trace metadata preserves
completed stages on failures. Original model-eval reports remain immutable.

Current voice delivery uses deterministic quoted/italic transcripts before one shared answer. The private media record is the transcript source of truth; queued replies hold references. The logistics-bot OpenAI credential is reused only in ignored local STT configuration. Model research and synthetic results are in [the transcription comparison](evals/results/2026-10-02-stt-comparison.md). No production STT environment or deployment was changed in this refinement.
