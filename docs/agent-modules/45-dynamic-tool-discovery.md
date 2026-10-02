# Dynamic tool discovery and employee authorization

Status: implemented for first-party Context Engine reads. This contract separates
tool development from Ramesh releases without making tool metadata an authority
to act as another employee or perform writes.

## Runtime flow

1. Resolve the trusted WhatsApp sender phone/LID to one active employee. Unknown
   users can converse but receive no business credential.
2. Initialize an authenticated Context Engine MCP connection for that employee.
   Read server instructions, the paginated tool catalogue and `get_context`.
3. Keep tool descriptions, input/output schemas, annotations and read-contract
   metadata. Project bounded orientation from `get_context`, excluding private
   employee identifiers. Pass guidance and context through the graph's planning,
   execution, formatting and verification stages.
4. Admit permitted read tools from this live catalogue. Tool names are no longer
   an exhaustive list maintained in Ramesh. Catalogue pagination, tool count,
   metadata size and guidance remain bounded; malformed or ambiguous catalogues
   fail closed.
5. On a source read, resolve the current employee binding and authorization again.
   The server applies current permissions and argument-dependent record access.
   Production does not substitute an old in-run result for a newly authorized
   source read. Delivery verification also replays reads with current access.

No employee catalogue or result cache is shared across senders. A per-turn tool
schema snapshot helps the model plan, but never authorizes a later call. If a tool
is removed or a permission changes during a turn, the current source boundary
denies it. The agent must report that limitation rather than claim the read worked.

## Server-owned read contract

Each new tool supplies:

- Its name, description, JSON input schema and JSON output schema.
- `readOnlyHint: true`, without contradictory destructive annotations.
- `_meta["wareongo/context-read-v1"]` containing minimum `requiredScopes` and an
  optional `sourceFamily`.
- The existing evidence envelope: `source_path`, `status: 200`, `data` and `meta`.
- `meta.toolName` and `meta.argumentsSha256`, binding evidence to the original
  MCP arguments. SHA-256 uses recursively sorted JSON object keys and preserves
  array order, before server schema trimming or defaults.

Minimum discovery scopes are not a full permission decision. For example,
`assess_shortlist` can provide a CRM checklist with CRM access, while selecting
warehouse records also needs warehouse permission. The source API owns that rule.

The existing tool-name mappings remain compatibility fallbacks and specialized
business-data validators. They do not define the universe of admissible reads.
New generic tools use schema validation, request binding, bounded relative source
citations and full evidence fingerprints. Receipt replay calls the authenticated
tool again; it does not fetch a returned citation URL. New metadata cannot shadow
reserved local tool names or select HTTP credentials.

## Decoupled changes and deliberate boundaries

New reads within existing service scopes can be introduced by changing Context
Engine's registration, handler, schemas and guidance. A matching bot release is
not required when the existing read contract remains compatible. Updated tool
descriptions and employee permissions are loaded on subsequent turns/requests.

New permission domains still need an explicit service-scope rollout. The signing
key is a maximum service capability, intersected with each employee's current
roster permissions. Granting analytics to the service does not grant Analyst
access to all employees. Unknown, inactive or ambiguously mapped senders remain
blocked from business reads.

Writes, scheduled actions and arbitrary third-party MCP servers are outside this
contract. They need their own effect, confirmation and replay semantics. A
first-party read annotation is not proof that an unreviewed external tool is safe.

## Validation and operation

Offline tests cover an unfamiliar tool, catalogue pagination, guidance/context
propagation, permission changes, reserved-name collisions, schema validation,
argument binding and receipt replay. Adversarial cases check asynchronous schemas,
schema-ID collisions, misleading citations and changed generic business fields.
No model calls are required for these checks.

Production source readiness is checked with `npm run capability:preflight` under
the actual worker configuration and a server-selected employee. That proves
access for the tested paths and identity; it does not measure conversational
quality or assert that every employee has the same permissions.

Monetary price profiles and dollar caps remain optional. They are not part of tool
discovery or authorization. Current production leaves them off and retains its
existing deadlines, retry bounds, token limits and tool-loop limits. Paid evals
continue to require their separately approved scope and model choices.
