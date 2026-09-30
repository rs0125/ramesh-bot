# Sales WhatsApp bot: context and rough plan

Captured on **2026-09-30** from the supplied discussion and a read-only inspection of neighbouring WareOnGo repos. This preserves planning context; it is not a claim that every integration is implemented or every quoted provider limit is current.

## Current scope

The greeting behaviour remains deliberately small: **a TypeScript Baileys bot using Prisma that replies `hello` to the person who messages or @mentions it**. DMs receive a DM reply; group mentions receive a quoted group reply. SQLite holds local message deduplication records.

The follow-up request adds a maintainable module structure, comments in each submodule, and a **Next.js admin app** for QR pairing, connection status, recent activity, and connect/disconnect/reconnect controls. The user explicitly chose to build both apps. The Next.js admin is intended for Vercel; Baileys remains in a persistent Node worker. Admin sign-in protects session controls; employee-to-CRM authentication, CRM/AI integrations, reminders, and Gupshup are still future work. See [architecture and deployment](docs/architecture.md).

The user subsequently selected **Next.js on Vercel plus a small EC2 instance for Baileys**, then requested that the projects be **decoupled**. `baileys-ramesh` is now the standalone worker; `../baileys-ramesh-admin` is the standalone Next.js project. Each has its own package, lockfile, configuration, tests and CI/CD. They communicate through `/v1` HTTP endpoints, without shared source packages or build dependencies.

The user also requested local hardening, CI/CD following the neighboring WareOnGo EC2 repositories, and **simulated WhatsApp events only** for this pass. The `warehouse-enricher` CI → OIDC → SSM pattern is the deployment reference. No cloud deployment or real account pairing has been performed. Supabase remains an option; current SQLite stores encrypted Baileys credentials/Signal keys, dedupe claims, revocable admin sessions, shared login limits and the operator's persistent disconnect preference. External auth storage would preserve state but would not replace the live WhatsApp process. See the [deployment guide](docs/deployment-vercel-ec2.md).

After the automated simulations passed, the user requested a **live local QR test** and startup commands. The separate worker/admin were started on localhost ports 3011/3010 and a real pairing QR was obtained. Scanning it links the user's chosen account and persists its credentials locally; this is separate from the automated test suite and does not deploy anything to AWS or Vercel.

## Intended product

A WhatsApp assistant for the sales team, with access to relevant existing team groups and the ability to DM salespeople. Potential uses include follow-up reminders, morning digests, urgent lead/task alerts, and questions about permitted CRM leads. Group access matters because useful context already lives in existing WhatsApp groups.

The harness should own WhatsApp connections, trigger rules, scheduling, permissions, and outbound delivery. An LLM can interpret requests and propose narrow actions, while application code decides whether and how to execute them. Keep reminder polling, due-time rules, and deduplication deterministic rather than calling a model on each scheduler tick.

## Rough authorization plan

The user's direction: **scope authorization to the person messaging the bot, and allow only open-to-the-organisation information in group chats**.

1. Resolve the authenticated sender's phone/JID to an active `VerifiedNumber` employee. Resolve WhatsApp LIDs through trustworthy protocol mappings; never infer an identity from a display name or message text.
2. Use that person's Context Engine credentials for personal CRM reads. Do not use a single administrator token for all employees. Treat the credential mapping and OAuth lifecycle as server-side concerns.
3. Keep group output to help, generic acknowledgements, and an explicitly reviewed organisation-wide knowledge source. An employee's personal CRM access does not make their lead data safe to publish to a group.
4. Route personal CRM results and reminder details to the requesting employee's DM. Tools should not accept arbitrary destinations or a user-selected identity.
5. Recheck active employee status and permissions when executing work. A future group knowledge policy also needs to consider guest/external group members: open within the organisation does not mean public.

This is only a plan. The current hello bot does not look up employees or load credentials.

## AI and MCP options discussed

- **Claude's API MCP connector:** the discussion suggested starting here because the model can call a remote MCP server without a harness-side MCP client. Tool allowlisting, bearer authorization, employee consent, and token refresh still need explicit configuration. The original discussion also flagged a possible zero-data-retention limitation; recheck current Anthropic terms before choosing this path.
- **MCP client in the harness:** discover allowed tools and expose them to a model as ordinary tool definitions. More code, but the harness can audit calls, validate arguments, trim results, and enforce routing.
- Allowlist only relevant CRM tools. The Context Engine also has warehouse, knowledge, GA4, and Search Console tools; do not hand the full catalog to a sales bot by default.
- A proposed first CRM allowlist is `crm_filters`, `search_crm_leads`, `crm_summary`, `read_crm_lead`, `read_crm_lead_context`, and `crm_briefing`.
- Treat group messages and CRM notes as untrusted data, not instructions. Do not grant shell access, arbitrary HTTP requests, bulk messaging, or arbitrary database queries to the model.
- Cap steps, tokens, and per-person daily spend. Keep API keys server-side. Audit triggers, tool calls, results, and responses with suitable access controls and retention; use representative, sanitized runs as a regression set.
- Ground CRM answers in successful tool results, citing returned lead IDs/links and exposing missing or stale data rather than guessing.

**Repo finding:** `/mcp` accepts employee OAuth access tokens (`wog_mcp_at_…`), not raw employee REST keys (`wog_ctx_…`). Access tokens last up to 15 minutes; refresh grants are bounded by the employee key/grant expiry. A future implementation must complete provisioning and refresh rather than copying one static token into the bot.

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

Paths below are relative to this folder. All inspection was read-only; no shared data or neighbouring code was changed.

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

Later: prove pairing and hello replies, then add scoped identity and private read-only CRM questions, then narrow reminder tools and a durable outbound queue. Keep bot-owned migrations separate from the shared database's existing schema.
