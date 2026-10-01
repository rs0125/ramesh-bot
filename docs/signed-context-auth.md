# Signed Context Engine access

Ramesh's preferred credential adapter uses service request signatures and live employee authorization. Each trusted WhatsApp phone/LID maps to exactly one active `VerifiedNumber` employee. Unknown users can still chat but cannot access business data. Business reads remain limited to DMs.

The conversational graph still contains only the converser and formatter. This increment prepares authenticated CRM/supply/knowledge services for the future worker; it does not activate business tools, planner/verifier agents, reminders or writes.

## Composition

`createSignedEmployeeContextAccess` in `src/app/context-engine.ts` composes the existing trusted sender resolver, live roster, `SignedEmployeeCredentials` and MCP services. Use `loadContextEngineConfig` and `loadContextSigningConfig` to load the endpoint and signing configuration, then explicitly inject them with the existing SQLite client, auth encryption key and `PostgresEmployeeRoster`. `forMessage(originalBaileysMessage)` derives the sender from the original transport key and returns scoped services or `null`.

The SQLite dependency is the existing encrypted Baileys LID/auth store. **This path creates no employee OAuth enrollment, grant or refresh-token state.** The employee roster and Context Engine's small shared replay cache are in Supabase. The previously shipped OAuth tables/migrations remain for compatibility; no destructive cleanup is required. `createEmployeeContextAccess` and `context:auth` remain the separate optional OAuth implementation, not the normal Ramesh setup.

Every MCP HTTP POST, including initialization and notifications, receives a new Ed25519 signature containing the employee ID, canonical phone, exact endpoint/method, body digest, read scopes, nonce and 60-second expiry. Context Engine stores only the public key and independently checks current identity and permissions. The worker verifies `get_context.employee_id` before a business read, enforces read-only discovery, refuses redirects and bounds request duration/response size. It rechecks employee binding before each signed request. Credentials and actor selection stay outside model arguments.

An attacker with a phone number cannot forge a signature. Compromising the worker/private key can impersonate employees through this trusted service, subject to Context Engine's current permissions. Protect the host and key, restrict service scopes, and rotate keys. The Context Engine [protocol and operational guide](../../Context_Engine/docs/ramesh-request-auth.md) describes validation, nonce expiry, kill switches and limits.

## Setup and rollout

1. Use the existing `npm run db:identity` procedure to give the restricted worker connection SELECT on four roster columns. Never give the worker a migration-owner connection.
2. On Context Engine, complete its restricted runtime/security migration, generate a key pair with `scripts/create-ramesh-key.mjs`, then check/apply `scripts/migrate-ramesh-auth.mjs`. Register only the public key there and enable the dedicated endpoint.
3. Set `CONTEXT_MCP_URL=https://<canonical-context-origin>/mcp/ramesh` and `CONTEXT_RAMESH_SIGNING_KEY_JSON` to the generated `worker-signing.json` contents in the protected worker environment. Keep the private JSON in the encrypted deployment secret store and root-readable runtime file; never echo it into commands, logs or chat.
4. Explicitly compose `createSignedEmployeeContextAccess` when implementing the future worker. Merely setting the environment does not connect these services to LangGraph.

No OAuth callback, employee consent screen, per-employee credential table or scheduled refresh job is required for this trusted first-party path. Claude continues using its existing OAuth connector. `/mcp` accepts the existing OAuth token type; `/mcp/ramesh` accepts the signed request type. The client rejects mismatched credential/endpoint combinations.

`CONTEXT_MCP_TIMEOUT_MS` defaults to 30000 and `CONTEXT_MCP_MAX_RESPONSE_BYTES` to 1048576. HTTPS is required except for explicit loopback development. Generated public registrations expire after 90 days. Rotate by deploying overlapping public keys, switching the worker signer, verifying the new key, then removing the old registration and redeploying Context Engine. Removing a key or changing the feature flag takes effect on deployments using the updated configuration. Retire or protect old deployment URLs too.

The worker's running conversational application does not currently read these new settings. Keep existing encryption, account namespace, API and model credentials intact during deployment. Signed access does not use the encrypted OAuth snapshots, so an OAuth restore/re-enrollment procedure is irrelevant to this path.

## Tests and next work

`tests/integration/signed-context.test.ts` uses fresh keys, the real MCP SDK, original phone/LID mapping and synthetic employees. It checks independent signatures, no OAuth writes, offboarding, group/unknown/ambiguous denial, cancellation, fixed endpoints and configuration redaction. Existing OAuth tests continue covering the optional legacy path. The Context Engine suite verifies forged/tampered/replayed requests and real PostgreSQL permissions. These tests never open WhatsApp or use production employee data.

Next, wire a single read operation through the future worker and verifier with evidence and private delivery. Follow with supply queries. Reminder scheduling, recipient revalidation and assignee-then-admin escalation remain separate work.
