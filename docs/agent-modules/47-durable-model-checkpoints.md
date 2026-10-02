# Durable model checkpoints

Status: **deployed on 3 October 2026 in [e0b7232](https://github.com/rs0125/ramesh-bot/commit/e0b723290478da646809af1542a343d49b913b07).** Production and capture migrations through `202610030005` are applied, and the running worker integration passed schema health checks.

## Purpose

A process restart should reuse completed model requests for the same inbound job. Recovery runs the graph again, revalidates the employee and tool authorization, and rereads business data. An exact match between the newly reconstructed request and its saved request digest can reuse the full provider response, including function-call IDs and encrypted reasoning continuation. A changed request invalidates that step and all subsequent saved steps.

This is an optimization for completed model calls, not a guarantee of exactly-once inference. A process may die after the provider finishes but before its response is saved. Tools are not cached by this store and writes must eventually have their own idempotency guarantees.

## Binding and fencing

A run belongs to one environment, account, inbound job, conversation, sender, and caller-supplied identity/model/prompt fingerprint. These values are authenticated with a keyed digest. The caller must include the current identity and permission/tool context in request construction; reuse is never permission to skip authorization.

Every begin, read, save, budget charge and policy update locks the inbound job and checks its current unexpired lease token, processing state and message expiry. A worker whose lease was replaced cannot inspect or overwrite a checkpoint. Queue ownership is the source of truth. The stored binding also includes the queue's own conversation and sender keys. Requests are hashed canonically with HMAC-SHA-256; no raw request, phone number or model response is stored in a plaintext column.

## Persistence and lifetime

Production uses `ramesh-agent-checkpoints`. The real-data capture harness uses physically separate `ramesh-test-agent-checkpoints` with a separate runtime role. Both hold AES-256-GCM envelopes bound to the environment, account, employee and job. Row-level security requires transaction-local account and capture employee settings. Public, Supabase API roles and the other environment's runtime have no grants.

A checkpoint contains the original request clock and absolute execution deadline plus up to 96 ordered model responses. The encrypted envelope is limited to 4 MiB, bounded by the message expiry and a maximum 24-hour retention window. Handoff and terminal queue cleanup delete it in the same transaction. A cleanup method also removes expired or terminal entries. Deleting an inbound job cascades to its checkpoint.

The same encrypted envelope holds atomic consumption counters: 72 tool reads, four web requests and 600,000 response bytes across all recovery attempts. These are execution safeguards, not model pricing or dollar caps. Up to 48 bounded policy entries preserve retry/cooldown state. Changing a binding or discarding model responses does not reset these counters, policy entries or the original deadline. Every public storage operation raises a fixed `CheckpointError` on lease/storage failure; the durable consumer must release its job instead of finalizing a generic fallback response.

Terminal cleanup uses invoker-rights triggers. Each trigger temporarily binds its own queue row's account and employee for RLS and restores the transaction's previous scope. It adds no `SECURITY DEFINER` function or extra cross-environment grants.

SQLite remains the local sandbox/auth store; it has no durable inbound leases. It must not pretend to offer production checkpoint fencing.

## Validation

Use synthetic local PostgreSQL fixtures and no model calls. Exercise process reconstruction, request mismatch truncation, namespace/account/binding isolation, lease theft and expiry, encryption and payload tampering, caps and cleanup. Test capture-role separation in the existing capture database fixture. No test may send WhatsApp messages or read live business data.

## Runtime recovery algorithm

This increment uses deterministic replay checkpoints around completed native model
responses. It is not a process snapshot or a LangGraph next-node checkpointer.
The graph reconstructs its bounded state by replaying its completed model steps,
including native encrypted reasoning and function-call continuation. Source reads
run again under current authorization; they are not restored as authority. A
changed model request invalidates every later response in the saved sequence.
The request clock and original deadline survive restart. Freshness, identity,
leases, media expiry and delivery always use current wall time. Interrupted
provider calls without a committed response may repeat; exactly-once billing is
not promised. Completed outbox handoff remains the delivery recovery boundary.

Model-facing evidence can omit named retrieval-only clocks and transport request
IDs after live validation. It must retain business timestamps, access scope,
source health and any unknown fields. Stable run-scoped evidence IDs keep an
unchanged result addressable across replay. All raw fresh results remain in the
executor for freshness validation and delivery receipts. Unknown tool contracts
are conservative: only envelope transport clocks are omitted.

Operational source/web/byte budgets survive response truncation. Replay is bounded
by the original execution deadline and message expiry, with fresh source checks
charged to a finite recovery allowance. Storage or lease failure propagates to
the durable queue; it must never become a successfully finalized fallback reply.

OpenAI reference: [reasoning continuation with Responses](https://developers.openai.com/cookbook/examples/responses_api/reasoning_items).

Recovery does not guarantee reuse of every step. Unknown source fields, analytics retrieval metadata and public web results can change the exact model request and conservatively invalidate the remaining sequence. The capture GUI wires the same encrypted replay boundary; its operator-only processing remains serialized and does not simulate production multi-chat scheduling. A run whose original deadline or message lifetime has expired is not resumed. Background or multi-day paused tasks still need a separate lifecycle.

## Migration verification, 3 October 2026

The production schema advanced from `202610020005`, applying the pending usage-ledger migration before concurrency and checkpoints. Capture advanced from `202610020002`, applying its separate ledger and checkpoint migrations. Historical checksums passed; both changes committed in one operator transaction after a successful rollback dry run. Existing runtime passwords were preserved. Restricted worker and capture health checks passed; checkpoint RLS and cross-role denial were verified. [CI 37067044403](https://github.com/rs0125/ramesh-bot/actions/runs/37067044403) and [CD 37067181558](https://github.com/rs0125/ramesh-bot/actions/runs/37067181558) passed for the deployed commit. WhatsApp is connected and the effective concurrency is three. Spending mode remains off. No paid evaluations, model calls, test messages or business-record mutations were used for rollout verification. Production restart faults were not injected; replay correctness is covered by the isolated deterministic tests.
