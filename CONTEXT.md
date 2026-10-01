# Ramesh: product context and decisions

Initial context captured on **2026-09-30**; updated on **2026-10-01** through signed Context Engine access. This preserves earlier options; the [implementation reference](docs/current-implementation.md) and [architecture plan](docs/assistant-architecture-plan.md) describe the current direction.

## Current scope

The TypeScript Baileys worker replies to qualifying text DMs and real group @mentions with an **OpenAI Terra `converser → formatter` LangGraph flow**. Replies use natural WhatsApp language; the formatter and final style guard remove em dashes and discourage stock AI phrases. Without an OpenAI key, the transport baseline replies `hello`. DMs and group replies stay in their originating chat.

The worker and separate Next.js admin have independent packages, configuration, tests, and CI/CD. Their only runtime connection is the authenticated `/v1` HTTP API. The admin provides pairing, status, activity, and connect/disconnect/reconnect controls. Its operator login does not grant employee CRM access.

The live linked account belongs to the EC2 worker. The earlier local pairing is retired. Successful main CI deploys through GitHub OIDC and SSM. The current EC2 API is private, with no inbound security-group rules; Vercel access needs a separate network rollout. See [EC2 operations](docs/ec2-operations.md).

Supabase now holds `ramesh-inbound-queue`, `ramesh-outbound-queue`, message state, and transition history. Agent processing atomically saves the final reply before the sender delivers it. SQLite retains encrypted Baileys credentials/Signal keys, admin sessions, login limits, operator settings, and legacy claims. The two queue migrations and conversational/MCP releases have deployed successfully.

Local chat testing uses the isolated SQLite playground at `http://127.0.0.1:3012`; it captures replies without opening WhatsApp or connecting to Supabase. Live model evaluations also use fake delivery. Queue integration tests use a separate local PostgreSQL database, never the production queue. **Do not send real WhatsApp test messages or start a second process with the production pairing.**

CRM, supply and knowledge services remain outside the active graph. `createSignedEmployeeContextAccess` now supplies trusted phone/LID resolution, live active-employee checks and signed requests to the parallel Context Engine endpoint. No employee OAuth enrollment is needed. Unknown users can chat without business access. Planner/worker/verifier, reminders and writes remain future work; dedicated domain endpoints remain deferred.

## Intended product

A WhatsApp assistant for the sales team, with access to relevant existing team groups and the ability to DM salespeople. Potential uses include follow-up reminders, morning digests, urgent lead/task alerts, and questions about permitted CRM leads. Group access matters because useful context already lives in existing WhatsApp groups.

The harness should own WhatsApp connections, trigger rules, scheduling, permissions, and outbound delivery. An LLM can interpret requests and propose narrow actions, while application code decides whether and how to execute them. Keep reminder polling, due-time rules, and deduplication deterministic rather than calling a model on each scheduler tick.

## Rough authorization plan

The user's direction: **scope authorization to the person messaging the bot, and allow only open-to-the-organisation information in group chats**.

1. Resolve the authenticated sender's phone/JID to an active `VerifiedNumber` employee. Resolve WhatsApp LIDs through trustworthy protocol mappings; never infer an identity from a display name or message text.
2. Use the resolved immutable employee ID and current permissions for personal reads. A service signature authenticates Ramesh; Context Engine independently authorizes the employee. The model cannot choose an actor.
3. Keep group output to help, generic acknowledgements, and an explicitly reviewed organisation-wide knowledge source. An employee's personal CRM access does not make their lead data safe to publish to a group.
4. Route personal CRM results and reminder details to the requesting employee's DM. Tools should not accept arbitrary destinations or a user-selected identity.
5. Recheck active employee status and permissions when executing work. A future group knowledge policy also needs to consider guest/external group members: open within the organisation does not mean public.

The active conversational graph does not load business credentials. The inactive services enforce trusted identity, DM audience, read allowlists and server identity match. Explicit worker integration remains a separate step. See [signed access](docs/signed-context-auth.md); the legacy OAuth factory is optional.

## Selected AI and MCP direction

The selected provider is OpenAI, model `gpt-5.6-terra`, through the Responses API. LangGraph owns the two-node conversational flow. The repository's MCP client uses Streamable HTTP with an employee-scoped credential resolver; see the [service contract](docs/assistant-architecture-plan.md#20-context-engine-mcp-service-scaffold). Planner, worker, and verifier agents will be added later. Simple requests need not traverse every future stage.

Earlier options, retained for context:

- **Claude's API MCP connector:** the discussion suggested starting here because the model can call a remote MCP server without a harness-side MCP client. Tool allowlisting, bearer authorization, employee consent, and token refresh still need explicit configuration. The original discussion also flagged a possible zero-data-retention limitation; recheck current Anthropic terms before choosing this path.
- **MCP client in the harness:** discover allowed tools and expose them to a model as ordinary tool definitions. More code, but the harness can audit calls, validate arguments, trim results, and enforce routing.
- Allowlist only relevant CRM tools. The Context Engine also has warehouse, knowledge, GA4, and Search Console tools; do not hand the full catalog to a sales bot by default.
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

Next: configure the service keys/replay storage, then wire trusted identity and scoped services into one private read with evidence verification when worker development resumes. Supply assistance follows. Reminder tools and due-time checks come later, reusing CRM-Automations rules and **assignee(s), then existing CRM admins** escalation. Long-lived reminder state, cancellation and recipient rechecks remain to build.
