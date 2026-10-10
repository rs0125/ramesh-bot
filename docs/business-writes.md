# Audited business writes and compensation

Implemented 3 October 2026. Deployment evidence is recorded separately; the default configuration remains disabled. This supersedes the deferred generic-writer portions of modules 17 and 52. Domain capabilities still require their own explicit permissions and configuration.

## Ownership

Ramesh owns proposal review, durable intent, the employee/chat boundary, policy enforcement and outcome presentation. Context Engine owns the dynamically discovered tool catalogue, schemas, execution policy, permissions and signed domain adapters. The dashboard or CRM command handler owns validation, transactional mutations, authoritative receipts and domain-specific compensation. A model never receives a database credential, chooses the caller identity, constructs an authorization header or sends arbitrary SQL.

Reads and writes use separate ports. `ContextToolRun`, conversation recall, evidence refresh, verifier checks and outbound delivery preflight never execute a write. `BusinessWriteRun.execute` only stages a proposal. After verifier review, `BusinessWriteRun.finalize` selects the path declared by authenticated tool metadata. Both paths share durable approval, dispatch, audit and recovery code.

## Extensible execution policies

`wareongo/context-write-v1.executionMode` declares one of two policies:

| Policy           | User experience                                                | Runtime boundary                                                                             |
| ---------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `direct_request` | An explicit current request executes in the same turn.         | Review, freeze and durably approve the exact operation before dispatch.                      |
| `confirmation`   | Show the proposed change and wait for a separate confirmation. | A delivered preview and matching current employee confirmation are required before approval. |

Omitted policy defaults to `confirmation`. The model cannot choose the policy, downgrade it from source content or infer it from a tool name. The frozen operation includes its policy and authenticated tool contract; a changed live contract requires review of a fresh operation, never silent promotion of an old proposal. New tools can use either path without a new agent or graph branch. Policy is an owner decision per capability, not a claim that every create or update is low risk.

Current Context Engine actions declare `direct_request`: GIS point creation, its guarded compensation, CRM RFQ creation, owned RFQ detail editing and guarded undo, Gmail draft creation and editing. Future actions such as sending an email or destructive record changes should declare `confirmation` when exposed. Those capabilities are not implied by the generic writer. Gmail never sends email; it creates or edits an owned app-created draft for the user to review in Gmail.

## Flow

```mermaid
flowchart TD
  A[Current employee request] --> B[Discover current permitted write tools]
  B --> C[Worker stages encrypted DRAFT]
  C --> D[Verifier reviews exact proposal]
  D --> P{Authenticated tool execution policy}
  P -->|confirmation| E[Publish PROPOSED and deliver preview]
  P -->|direct_request| R[Revalidate current explicit request and run lease]
  R --> H
  E --> F[Later direct confirm CODE]
  F --> G[Verify actor, delivery, expiry and current tool contract]
  G --> H[Persist APPROVED then DISPATCHING]
  H --> I[Call Context Engine once with frozen operation ID]
  I --> J[Domain transaction: mutation and idempotency receipt]
  J --> K[Persist verified result or UNKNOWN]
  K --> L[Authorize receipt delivery without replaying the write]
```

For `confirmation`, the user receives exact material fields and `confirm CODE` / `cancel CODE`. The proposal lasts one hour. The runtime requires a later, standalone, directly typed command in the same private conversation, from the same currently active employee and phone binding. The original proposal must already be recorded as sent, with an encrypted delivery receipt naming this operation and its published version, and the actual reply containing the confirmation code. A sent fallback or stale draft does not satisfy this proof. The final confirmation must be typed.

For `direct_request`, the same verified current employee request authorizes approval after independent review, without a code. Forwarded text, image captions, quoted instructions, native-location labels and historical messages cannot authorize either path. A direct voice request can supply intent through its trusted transcript. Permission, source provenance, lease ownership, frozen arguments and duplicate prevention apply to both policies.

A draft can be revised during verifier repair; every revision is audited and invalidates its earlier unpublished code. Once directly approved or published, its payload is immutable. A changed request needs a new reviewed operation. No capture queue or playground identity has production journal access, and the live-data playground does not compose the writer.

Cancelling an owned pending proposal is a local journal action. It remains
available when the remote write catalogue is empty or discovery is unavailable;
the sender must still resolve to the same active employee, phone and private chat.
The cancellation reply contains no stored business details and uses a constrained
delivery receipt that checks the cancelled operation's current state and version
without requiring remote write permission. It cannot authorize confirmation,
redisclose the proposal, cancel an uncertain dispatch, or undo a committed write.

Write discovery is optional for independent conversation, reads and personal
tasks. A catalogue outage omits the unavailable write tools rather than aborting
those workflows. Exact confirmation commands still use the application-owned
recovery path and cannot fall back to model-authorized execution.

## Storage and audit coverage

Supabase migration `202610030009_write_journal.sql` adds:

| Table                     | Purpose                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ramesh-write-operations` | Current operation state, employee/phone/chat/run binding, encrypted frozen arguments and source evidence, confirmation hash, dispatch lease, result and optional parent operation/version |
| `ramesh-write-events`     | Append-only encrypted before/after snapshots of each operation transition and each personal task/reminder command                                                                         |

Business arguments, descriptions, source messages, confirmation codes and receipts are envelope-encrypted with the worker's existing encryption key. Operational actor and lifecycle columns remain queryable. The runtime can append events but cannot update or delete them; it also cannot delete operation rows. Public API roles and the capture role receive no journal grants. Audit rows have no cascading inbox foreign key, so normal message cleanup cannot erase business history. Proposal expiry prevents new authorization; it does not erase audit data. There is currently no automatic journal deletion policy. Source evidence deliberately frozen into a proposal remains part of that audit after the 7-day source lookup window closes.

Personal task/reminder mutations keep their existing request-driven behavior. Their exact before/after task, reminder and affected occurrence snapshots are appended inside the same transaction as the command and its existing receipt. Audit insertion failure aborts the mutation. Scheduler occurrence and delivery events continue in their existing durable tables; queue lease housekeeping is not a new user write. This does not retroactively reconstruct writes made before migration.

Backend business state and Ramesh's journal cannot share one SQL transaction across HTTP. The domain handler must atomically commit its mutation and authoritative idempotency receipt. Ramesh persists intent before dispatch and the result afterwards. A crash between those steps leaves an explicit uncertain state, rather than pretending the remote transaction was rolled back.

Migration `202610040001_write_delivery_lookup.sql` adds a run-scoped audit-event
index for receipt checks. It changes no write permissions or table columns and
is an additive performance migration; runtime readiness still accepts `009`.

## Recovery and undo

A recovered business result survives an unrelated personal receipt lookup
failure. Queue handoff checks this inbound run's non-draft business transitions
and requires the current operation version, employee, phone, chat and run in the
protected delivery receipt. A mixed turn must also carry its committed personal
receipt. Missing or mismatched receipts retain the original run for bounded
recovery. Delivery authorization outages retain saved confirmations for retry;
they cannot replace an actual write outcome with a generic “try again” message.

An operation uses one server-generated UUID for its lifetime. Unknown results retain their exact arguments and ID. `retry CODE` resumes that same approved operation; it cannot create a second operation or change the payload. Uncertain approved operations remain recoverable after the original proposal deadline. The durable approved transition preserves the verified delivery proof, so later inbox cleanup does not strand a pending outcome. A later permission failure does not establish that an earlier uncertain request never committed. There is no autonomous retry loop or LLM-controlled retry budget.

Direct Gmail recovery accepts “retry that draft” or “try that draft again” only when exactly one unresolved, owned direct Gmail operation can be selected. Generic “try again” does not execute an older write. Ambiguous targets require clarification. Recovery keeps the frozen operation ID and arguments; it cannot create a replacement draft to hide an uncertain result.

Undo is a new audited **compensating action**, linked to the original operation. It does not delete or rewrite the original audit record. The worker first reads `write_history`, then may stage a currently advertised tool whose contract explicitly declares which action it compensates. The owned original must have a successful authoritative receipt. The compensation gets its own operation ID, result and independently declared execution policy.

The initial `rollback_gis_poi` tool compensates an employee's own `create_gis_poi`. The dashboard locks the point and compares its current fields and update timestamp with the creation receipt. It removes only an unchanged point and atomically stores a separate compensation receipt, including before/after state. It refuses edited records and arbitrary point IDs. Repeating the original create after a rollback returns its historical creation receipt; it cannot resurrect the point.

This follows the [Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction): undo rules belong to the business operation and must account for later changes. Stable intent identifiers follow [AWS's idempotent API guidance](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/). Sending a message and similar external effects may be irreversible. Ramesh must say so, rather than inventing an undo.

## Future CRM tools

No GIS branch is required in the graph or writer to add a CRM action. A new Context Engine tool must provide:

1. A closed, bounded input schema, a required UUID idempotency argument and a concrete output receipt schema.
2. `wareongo/context-write-v1` metadata with required scopes, source family, effect (`create`, `update`, `delete` or `compensate`) and an explicit `executionMode` (`direct_request` or `confirmation`). Omission requires confirmation. Current employee permissions and platform configuration determine discovery on every request. Historical arguments/results may be redisclosed only when the current tool explicitly declares `auditHistory: actor_scoped` (the GIS policy). The default is closed. A future CRM integration with record-level permissions must add current per-record authorization before enabling audit history or compensation previews; the existence of a write scope is insufficient.
3. A source-system handler that rechecks employee access and commits the mutation and receipt together. Do not write Twenty's replicated CRM tables as a shortcut.
4. For updates and deletes, expected record version or equivalent preconditions checked inside the mutation transaction. Record the exact prior value, resulting value and authoritative revision. A CRM mirror's delay is not evidence that a write failed.
5. If reversible, a separately advertised compensation tool with `compensates` and `originalOperationArgument`. It must verify that the current record still matches the result of the original action. Restore only affected fields and refuse intervening edits. Noncompensable actions must remain explicitly noncompensable.
6. Contract tests for duplicates, wrong employee, changed arguments, stale version, lost response after commit, replay after restart and rollback conflicts.

Examples include adding a CRM note, assigning a lead or changing a follow-up date. Each needs its own domain permission and semantics. The generic writer does not grant these capabilities merely because it supports the protocol. Multi-action workflows are not one atomic cross-service transaction; define partial-success and compensation semantics before exposing them.

## Locations and provenance

`write_sources` can retrieve at most 32 original messages / 32 KB from the same account and private conversation from the last 7 days, at or before the current request. When the current request is a WhatsApp reply, the replied-to message is also returned, flagged `quoted`, for as long as the inbox retains it (30 days), under the same chat, origin and sender checks. Structured native pins survive raw-protocol cleanup. Historical messages have unknown forwarding status and cannot authorize a new action. A selected source ID is stored alongside the exact proposal. For tools declaring `coordinateArguments`, selected native coordinates must match the proposed coordinates exactly.

Google Maps links and raw coordinates are resolved through Context Engine's read-only `resolve_location`. It preserves ambiguity and provenance. It does not silently choose a viewport, geocode an unsupported address or treat a user-supplied URL as a trusted WhatsApp pin. The confirmation preview displays the final coordinates regardless of origin.

## Configuration and rollout

`BUSINESS_WRITES_ENABLED=true` additionally requires signed business access, the assistant and Supabase message storage. The worker signing key and Context Engine registry must both grant `gis:write`; Context Engine independently checks current dashboard eligibility and tool platform settings. The dashboard's dedicated Context Engine public key needs `geo:points:create` and `geo:points:rollback`. The public key belongs in the dashboard; the separate private key stays in Context Engine/SSM. Existing read scopes and Claude OAuth remain unchanged.

Apply the bot journal migration and additive dashboard compensation migration before the code that requires them. Run local synthetic PostgreSQL, HTTP-signature, transport and graph tests. Deployment probes may inspect identity, catalogue admission, schema health and invalid requests; they must not create production business records or send test WhatsApp messages. No paid model evaluation is needed for these boundaries.

Disabling new writes does not undo existing writes. Keep the journal and authoritative receipts, inspect any uncertain operations, and preserve the delivery authorization fence. Never rotate operation IDs to get past a failed or timed-out request.

RFQ edits and undo use domain-owned list_crm_rfq_changes/read_crm_rfq references and fresh record authorization. Generic write_history intentionally omits CRM records; no actor_scoped CRM payload-disclosure policy is granted. Only RFQs created by this agent for the current employee can be edited. See [RFQ integration](crm-rfq-writes.md).

Explicit `delete_crm_rfq` moves this employee’s own agent-created opportunity to CRM trash, including after edits. `delete_crm_note` remains available only to recover existing exact operations; new note-trash requests are refused. Context Engine requires a fresh expected version, current deal access and creation ownership; generic journal history still discloses no CRM content. Deletion is a domain action with `effect: delete` and explicit `executionMode: direct_request`, not an undo chain. The authenticated `deleted` outcome is persisted as success; missing policy still requires confirmation. Fresh receipts use the verified provider target and, for notes, exact deleted title/body. They do not offer editing or automatic undo after deletion.

Whole-note deletion is now recovery-only because Twenty cannot atomically guard the separate note-to-deal links against a cascading note deletion. New `delete_crm_note` operations stop before CRM reads, reservation or mutation; existing exact operations retain their original recovery outcomes. The bot does not silently substitute unlinking or an undo chain. Eligible creation undo still removes only its original deal link; RFQ trash remains available under its existing checks. No new migration is required.
