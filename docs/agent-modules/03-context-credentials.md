# Context Engine credential adapter

Status: **Signed path integrated with the fixed read executor.** This fills the existing `ContextCredentialResolver` boundary. See [signed access operations](../signed-context-auth.md), [identity](02-identity-resolver.md) and [MCP adapter](09-context-engine-adapter.md).

**Implemented subset:** The first preset uses createSignedEmployeeContextAccess and an employee-pinned ContextCredentialResolver. No OAuth enrollment, token table or model-visible actor argument is added. See the [first-read runbook](../first-crm-read.md) for the exact code contract and activation steps; production enablement remains separate.

## Responsibility and existing interface

Use [SignedEmployeeCredentials](../../src/infrastructure/context-engine/request-credentials.ts) and [createSignedEmployeeContextAccess](../../src/app/context-engine.ts). The adapter accepts a trusted `ContextSender` and abort signal, returning an `EmployeeRequestGrant` or no grant. Its `authorize(Request)` closure signs a specific outbound request; it is not serializable agent state.

The earlier employee OAuth adapter remains available for compatibility. Ramesh's selected first-party flow does not require enrollment, refresh-token storage or new OAuth tables. Claude retains its existing OAuth path on Context Engine.

## Request authentication

| Field/control | Required binding                                                                           |
| ------------- | ------------------------------------------------------------------------------------------ |
| Sender        | Trusted canonical phone and one active immutable employee ID                               |
| Audience      | DM only for the selected first release                                                     |
| Service key   | Registered Ed25519 key ID, private key accessible only to the worker                       |
| Request       | POST method, exact configured `/mcp/ramesh` URL and hash of the exact body                 |
| Validity      | Short expiry, issued-at timestamp and unique per-request nonce                             |
| Scope         | Configured read scopes intersected with server key limits and current employee permissions |

The implemented signer rejects wrong methods/endpoints, browser-origin requests, oversized bodies and expired local grants. It rechecks employee ID, phone and email before signing. Each physical POST receives its own signature and nonce, including MCP handshake and tool requests. The server validates the signature and live authorization independently.

`expiresAtMs` bounds the local grant object's use; the signed assertion has its own at-most-60-second lifetime. Expiry results in live re-resolution and a fresh signature, not refreshing a stored employee token. The server's shared nonce store protects against replay across instances.

## Execution and recovery rules

Credentials are resolved inside each authorized operation. Do not put the grant, private key, raw signed header or request body into LangGraph checkpoints, model inputs, traces or retry records. Recovery reconstructs credentials from live identity and protected runtime configuration.

A failed signature or employee mismatch stops the operation. There is no fallback to the dashboard owner key, an admin employee or Claude's OAuth grant. Retried safe reads must use new request signatures, while the executor retains the logical operation ID for auditing.

Key rotation follows the existing runbook: register overlapping public keys, change the protected worker key, verify and then retire the old registration. Employee offboarding is enforced by live roster checks. Key removal, scope changes and worker configuration reload remain operational actions, not model tools.

## Threat boundary

The signature authenticates Ramesh as the caller and binds its employee assertion. It does not independently prove ownership of a phone if the worker is compromised. The gateway and signing host are trusted components. Application authorization still constrains permitted reads; this spec does not change the previously accepted database-role posture or shared Supabase extension grants.

Scheduled automation requires a distinct authority contract in the reminder/SLA specs. A service signature alone does not authorize unsolicited messages or organization-wide reads.

## Acceptance cases and readiness

Validate wrong body, URL, method, audience, employee, phone, expiry and replay denial; concurrent identities must not share grants. Deactivation between resolution and signing must stop the request. Crash/restart must not require recovering a serialized credential. Logs and checkpoints must contain no signing secret or authorization header.

Existing signing tests remain the foundation. Add orchestration tests that prove the live adapter is invoked at each business boundary and that failed credential resolution produces an honest conversational limitation. Runtime secrets stay in the existing protected deployment configuration; no environment update is required to create these specifications.
