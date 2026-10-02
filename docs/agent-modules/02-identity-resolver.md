# Trusted employee identity resolver

Status: **Resolver integrated with first-read execution and delivery checks.** Consumers are [credentials](03-context-credentials.md), [orchestrator](12-langgraph-orchestrator.md) and [delivery](14-outbound-delivery.md).

**Implemented subset:** createBusinessReads resolves the original PN/LID, pins credential resolution to that employee and rechecks before delivery. Protected replies are omitted from general model history instead of replaying cached business facts. See the [first-read runbook](../first-crm-read.md) for the exact code contract and activation steps; production enablement remains separate.

## Responsibility and current code

Resolve the actual WhatsApp participant to exactly one active `VerifiedNumber` employee. Reuse [employee-sender.ts](../../src/infrastructure/whatsapp/employee-sender.ts), [employee-identity.ts](../../src/modules/identity/employee-identity.ts) and [employee-roster.ts](../../src/infrastructure/database/employee-roster.ts).

Existing APIs include `WhatsAppEmployeeResolver.sender/resolve`, `EmployeeIdentityResolver.resolvePhone/resolveEmployee` and the roster's `byPhone/byId` reads. `lookupPhone` can return an inactive match for lifecycle handling; it must not be mistaken for the active-only resolver.

## Input and output contract

Input is the original transport key plus account-local Baileys mappings and an abort signal. DM identity comes from `remoteJid`; group identity comes from `participant`. Output is a trusted sender and immutable employee ID, canonical phone, current email binding and active state, or no valid employee identity.

The proposed orchestration wrapper may attach safe internal reason codes: `unmapped_sender`, `ambiguous_roster`, `inactive_employee` or `identity_unavailable`. Existing APIs return null for several of these cases, so exposing finer diagnostics requires an explicit extension. User-facing responses should not enumerate roster membership or reveal another employee's details.

## Resolution rules

1. Reject own messages and malformed transport identifiers. Device suffixes may be normalized only by the existing parser.
2. A phone JID must already carry its country code. The legacy India fallback applies to roster normalization only.
3. An LID must resolve through the encrypted, reciprocal mappings persisted by Baileys. Both directions must agree in the same transactional read.
4. Canonicalize roster numbers and require one matching employee. Differently formatted duplicate numbers are ambiguous even if a raw database column is unique.
5. Require active status for business operations. Rechecking an employee ID also verifies its current unique phone mapping and email binding.
6. Bind the result to the run's account, sender and audience. Record an opaque actor reference; never take employee identity from the model.

Mentions, quoted-message senders, first names, display names, CRM notes and a user typing “my number is…” are not identity proofs. Resolving a group participant does not enable group business access.

## Lifecycle and storage

The roster remains authoritative. Do not add a long-lived permission cache or a duplicate editable employee directory. Persist references for attribution, then resolve live identity again for tool calls, resumed runs and sensitive delivery. If a phone is reassigned, a pending task must not transfer to the new employee.

LID data remains in the encrypted local Baileys store. Agent-run and evidence records belong in Supabase. No employee OAuth table is needed for identity. A roster outage is an unavailable authorization check, not proof the sender is unknown; allow ordinary chat while withholding business reads and previously cached business facts.

## Acceptance cases

- Phone JID, device-suffixed JID and valid reciprocal LID all resolve to the same employee.
- Missing, inconsistent or cross-account LID data cannot produce a business identity.
- Two roster rows representing the same canonical phone are rejected.
- Unknown and inactive users can use the normal conversation path without a business credential.
- Deactivation, phone reassignment or email-binding change during a paused run prevents stale credential reuse.
- An active group participant receives no private business result in that group.
- History from a previous employee binding is excluded after the phone-to-employee association changes.

The first implementation task is integration of these existing services, not a second identity algorithm. Any roster-schema or capability change must be coordinated with Context Engine, which independently enforces business access.
