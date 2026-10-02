# Context Engine MCP adapter

Status: **Full permitted read-catalogue integration implemented.**

**Implemented subset:** createBusinessReads and the live playground expose all currently permitted reads through discover/call, retaining the domain services. Each call uses signed employee binding and fresh server checks; the local allowlist and server readOnlyHint must agree. No fixed today-only route remains in this composition. See the [personal-assistant runbook](../sales-manager-agent.md) and [module 22](22-sales-manager-tool-loop.md) for the current contract. Production enablement remains separate. The richer role/task contracts below remain target design unless explicitly identified as implemented.

## Responsibility

Provide bounded, employee-scoped CRM, supply, knowledge and analytics reads over the existing MCP interface. Keep database queries inside Context Engine. Dedicated domain-backend read endpoints remain deferred; no arbitrary SQL tool is introduced.

## Existing interface

`ContextEngineServices.forSender(trustedSender)` creates a bound service view. `ContextToolGateway.discover/call` accepts that trusted sender and abort signal. The currently allowed tools are:

| Family    | Tools                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Identity  | `get_context`                                                                                                                  |
| Knowledge | `search_knowledge`, `read_knowledge`                                                                                           |
| Supply    | `warehouse_filters`, `search_warehouses`, `warehouse_summary`, `read_warehouse`                                                |
| CRM       | `crm_filters`, `search_crm_leads`, `crm_summary`, `read_crm_lead`, `read_crm_lead_context`, `crm_briefing`, `assess_shortlist` |

The discovered schemas define available filter fields and values. Related CRM context is bounded by one lead and one section: notes, tasks, company or stage history. Analytics tools are `analytics_capabilities`, `ga4_report` and `search_console_report`, gated by current Analyst access and the key scope. HRMS, writes and message sending remain unconnected.

## Transport sequence

Resolve credentials, create an operation-local MCP connection, discover allowed tools, verify `get_context.employee_id` against the resolved employee, and call the permitted business tool. Each business read still receives server-side live authorization. Do not share a connection or catalogue across employees.

Signed credentials require the configured HTTPS `/mcp/ramesh` endpoint; the optional OAuth path uses `/mcp`. Loopback HTTP is allowed for explicit local development, including the real-source capture harness. Redirects, arbitrary hosts, stdio servers, sampling and credential-export flows are not supported.

The existing defaults are a 30-second operation deadline and 1 MiB response limit. The executor may impose a shorter remaining deadline. Configuring the endpoint alone must not enable business reads in the chat graph.

## Evidence contract

Preserve the existing `ContextEvidence` envelope with `source_path`, successful status, `data` and `meta`, including source request ID and generation time. Retain nested cursors, coverage, source health, redactions and verification indicators. The adapter checks transport/envelope validity; the verifier interprets business correctness.

CRM mirror freshness and live related-stream health are separate. Do not label all related notes/tasks current merely because the main opportunity query succeeded. Do not present broad accessible-record `crm_briefing` output as assigned-only personal work. The first lookup explicitly uses supported search filters with `view=assigned` and current-day follow-up semantics.

## Failure and integration rules

Preserve safe codes including `NOT_CONFIGURED`, `AUTH_REQUIRED`, `ACCESS_DENIED`, `TOOL_UNAVAILABLE`, `INVALID_ARGUMENTS`, `INVALID_RESPONSE`, `RESPONSE_TOO_LARGE`, `RATE_LIMITED`, `UNAVAILABLE`, `TIMEOUT` and `CANCELLED`. Callers cannot interpret an error as an empty result. Existing client calls do not automatically retry; the executor owns bounded retry decisions.

Constructing services performs no network access. The application explicitly composes the signed identity adapter only when the business feature is enabled. Tests can inject a fixture gateway; synthetic identities must never be resolved against live employee data accidentally.

## Acceptance cases

Retain existing SDK integration tests for identity mismatch, scoped discovery, group denial, malformed responses, response limits and cancellation. Add executor-level cases for assigned-only reads, bounded pagination, source-health propagation and catalog changes. No test should require a real WhatsApp session or live CRM data.

Any server-side change needed for a new tool or filter is a separate Context Engine change with matching schema tests. The worker must not guess undocumented parameters to make an unsupported workflow appear complete.

The optional `describe` method returns tools plus bounded MCP server instructions. The graph receives that guidance for source semantics without granting it authority over identity. Structured recovery actions from analytics errors are preserved, while raw upstream details remain private.
