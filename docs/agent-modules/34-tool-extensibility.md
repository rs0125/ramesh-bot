# Tool extensibility without changing the agent graph

Status: dynamic first-party read discovery is implemented; writes and arbitrary
third-party tools remain future work. Advertising a tool does not grant permission
to run it. See the [live read contract](45-dynamic-tool-discovery.md).

## Current compatibility

| Layer                    | Current behavior                                                                                          | New tool impact                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Converser/planner/worker | Plan from the permitted live catalogue and JSON Schemas; graph stages do not enumerate business workflows | Same graph can plan a different capability                                                    |
| Model adapter            | Native Responses function calls with generic names, schemas and outputs                                   | No new agent or provider implementation required                                              |
| Context executor         | Admits current employee-permitted read contracts, validates schemas and evidence                          | New conforming reads need server registration; no bot name-list edit                          |
| Evidence/delivery        | Domain-aware source paths, freshness checks and encrypted read receipts; replays reads before delivery    | Generic reads use request binding and full evidence replay; domain checks remain specialized  |
| Media                    | Same-owner image/PDF extraction and audio transcription; 24-hour private retention                        | Useful input today; extraction is bounded and potentially lossy, not a general document index |
| Writes                   | No write transport, confirmation state, idempotent command lifecycle or write receipt                     | Requires an effect adapter and the action lifecycle in module 17                              |

Implementation references: `src/modules/assistant/task-plan.ts`, `sales.graph.ts`,
`tool-executor.ts`, `tool-evidence.ts`, `business-reads.ts`,
`src/modules/context-engine/context.types.ts`, and `src/modules/media/`.

## Extension contract

Keep the shared graph concerned with intent, outcomes, execution, evidence and
response quality. Context Engine owns read registrations and domain authority.
Its live read contract carries schemas and minimum scopes; future effect adapters
should also describe each capability with:

- Stable name/version and discovered input schema.
- Effect class: read, private artifact analysis, proposal, or write.
- Trusted actor/audience policy, scopes and backend binding, never model-supplied credentials.
- Execution deadline, output-size/call budget, cancellation and retry policy.
- Result validator, evidence projection, retention and display requirements.
- Read freshness/revalidation, or write idempotency/reconciliation and authoritative
  postcondition checks. These are different contracts.

First-party read tools are discovered from the authenticated Context Engine at
runtime. They need the versioned read contract and current employee permission,
not a matching bot-side registration. New effects remain unavailable until their
adapter is implemented. Neither an MCP annotation, source document nor a
model-generated label may authorize a write.

Context Engine also requires an explicit platform list for every tool. Its admin
**Prompts → Available on** selector controls `claude` and `whatsapp` independently;
the authenticated `/mcp/ramesh` endpoint selects WhatsApp on the server. Keep this
selection separate from employee permissions: platform selection decides which
tools the server offers, while current permissions and the read contract decide
which offers Ramesh can use. The worker refreshes discovery before every call and receipt
replay. A tool removed during an in-flight read produces a non-retryable
`TOOL_UNAVAILABLE`; there is no fallback to the Claude endpoint.

Do not run a write through current read receipt replay: that would execute the
mutation again during recall or delivery. A committed action has a persistent
operation receipt; verification reads its postcondition or operation status. The
user's clear request can authorize a permitted low-impact action under policy;
confirmation, when required, binds a concrete payload and current actor. See
[17. Business actions](17-business-actions.md).

A document-analysis tool should accept authorized opaque artifact IDs, scoped
questions and bounded page/section requests. It should return page/section
references, extraction coverage, unread/failed parts and uncertainty. It must not
accept arbitrary file paths or public URLs supplied by the model as authority.
Reuse the media owner/expiry checks, and distinguish a derived extract from a
complete reading of the original document. The worker can then request additional
sections through the same tool loop rather than relying on one lossy extraction.

## Avoiding use-case overfitting

General behavioral evals judge outcomes and use the current advertised schemas;
they should accept different valid tool paths, supported interpretation of visible
facts, and equivalent query spellings. Exact call requirements belong to explicit
API/security regression tests, such as refusing unauthorized writes or preserving
an assigned-only query. They are not the universal definition of intelligence.

Use separate evaluation layers:

1. Domain-independent behavior: continuation, corrections, constraints, clarification,
   uncertainty, partial completion, tool failure and response quality.
2. Adapter contracts: schema validity, identity, scopes, input/output limits,
   idempotency or read freshness, and artifact ownership/expiry.
3. Outcome journeys: a user goal with reference facts, without prescribed tool order.
4. Held-out variations when a new capability is added: unfamiliar names, different
   schemas, reordered results, absent fields and multi-tool dependency chains.

The present public suite covers personal work, CRM, supply, knowledge, analytics
and boundaries; private real-data cases prescribe employee outcomes. This is
useful evidence for these capabilities, not proof of arbitrary future tools. The
new grader-calibration suite tests semantic equivalents and known bad neighbors.
Do not tune prompts to private record names or promote fixtures into product rules.

Keep new domain rules in adapter-specific guidance. Avoid adding another permanent
agent, an intent regex or a universal prompt paragraph for every endpoint. Review
common-versus-domain prompt separation again when the next actual capability is
registered, with measured held-out cases before enabling it.
