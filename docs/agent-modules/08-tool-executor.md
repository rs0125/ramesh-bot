# Application tool executor

Status: **General read-tool proposal executor implemented.**

**Implemented subset:** ContextToolRun validates discovered JSON Schemas plus CRM date-filter dependencies, rejects authority overrides, fences encrypted receipts and rechecks the employee before/after execution. Unsupported tools and malformed proposals never reach MCP. Tool and total evidence budgets apply. See the [personal-assistant runbook](../sales-manager-agent.md) and [module 22](22-sales-manager-tool-loop.md) for the current contract. Production enablement remains separate. The richer role/task contracts below remain target design unless explicitly identified as implemented.

## Responsibility

Turn an untrusted `ToolProposal` into a validated operation and authoritative receipt. This is code, not an agent. It is the only worker-facing entry point for tools. It must remain independently testable without a model or WhatsApp connection.

## Contract

`execute(proposal, runtimeContext, signal)` returns a `ToolReceipt` and registered `EvidenceRecord`, or a typed failure. Runtime context supplies the actor, audience, run/step/epoch, budget, catalogue and lease ownership. These fields cannot be overridden in proposal arguments.

The initial catalogue contains only existing read tools. The executor intersects the local allowlist, enabled task profile, discovered employee catalogue and current task contract. Discovery is not a substitute for server authorization on the call itself.

## Ordered execution checks

1. Verify the run is active, the epoch/lease is current and the step's dependencies are satisfied.
2. Validate tool name and arguments against the discovered schema plus application restrictions. Reject actor, credential and destination overrides.
3. Resolve current authority through the existing trusted adapter. Business reads require an active employee and a DM.
4. Reserve logical call, wall-time and model-independent operation budgets before dispatch.
5. Persist a started operation event with a server-created operation ID and safe input fingerprint.
6. Invoke the bound domain service with a deadline no later than the run's remaining deadline.
7. Validate the envelope and persist the outcome/evidence before returning success to the worker.

Application filters can narrow a request, such as enforcing `view=assigned`, but cannot broaden an employee's scope. No raw SQL, arbitrary HTTP client, shell, alternate MCP server or message-send tool is exposed.

## Retries and uncertainty

One bounded retry may handle a demonstrably transient read failure, consuming the same run budget. Honor safe retry delays only within the deadline. Each signed HTTP request gets a fresh signature; logical operation and attempt IDs preserve the audit trail. Avoid stacking executor retries with hidden transport retries.

Never retry `ACCESS_DENIED`, `AUTH_REQUIRED`, invalid arguments or cancellation as if they were transient. A read that completed remotely but lost its response can be safely repeated, while its original missing receipt remains explicit. A future write timeout must enter the action module's reconciliation path rather than the read retry path.

If evidence persistence fails, the worker cannot claim verified success from an unrecorded response. Retain a recoverable operation outcome or fail closed. Do not hold a database transaction open across a network call.

## Evidence and error semantics

Preserve source path, source request ID, actual retrieval time, underlying sync times, returned IDs, redactions, cursors and verification flags. A valid outer response does not imply complete business coverage. Return safe error categories without upstream secrets or raw server bodies.

Missing data is different from schema failure. A schema mismatch is an integration fault to surface in telemetry, not an invitation for the model to reinterpret arbitrary text.

Budget exhaustion is a structured outcome, not an exception that discards the run.
The graph restricts each continuation to families with remaining calls and checks
the selected family's allowance again before dispatch. Stale exhausted proposals
consume a total proposal slot but make no source request. Formatting and review
receive the remaining family budgets alongside the evidence, so a partial answer
can distinguish unchecked coverage from an empty result or authorization failure.

## Acceptance cases

Test malformed and unknown tools, forged actor fields, denied employees, changed permissions mid-run, request-size limits, budget exhaustion, invalid envelopes, delayed cancellation, receipt-write failure and repeated read attempts. Verify that a stale lease cannot persist a completion and that a fake worker cannot create evidence by referencing arbitrary rows.

The first production read requires this boundary even when the worker is deterministic. Reminder and write commands are added as separate effect adapters with their own contracts later.
