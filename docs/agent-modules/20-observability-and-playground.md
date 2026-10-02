# Observability, admin and fake chat

Status: **General sales capture GUI, traces and isolated queues implemented; full run inspector proposed.**

**Implemented subset:** The live GUI runs as the server-configured employee over real Supabase and signed MCP. It exposes conversational, worker, formatter and verifier timings, with no business body in normal logs. Supabase test queues are physically separate from the WhatsApp queues. The optional SQLite preset remains a synthetic regression path. See the [personal-assistant runbook](../sales-manager-agent.md) and [module 22](22-sales-manager-tool-loop.md) for the current contract. Production enablement remains separate. The richer role/task contracts below remain target design unless explicitly identified as implemented.

## Responsibility and existing boundaries

Make task progress and failure reasons inspectable without exposing credentials or granting operators employee business permissions. The worker owns its operational API; the separate admin application consumes versioned contracts. The dummy chat uses captured transport and isolated storage.

Current `AgentTrace` records run/model/prompt versions, stage timing, usage and outcome. Extend this with persisted run/operation correlation; do not use a second unrelated run ID when a durable task already exists.

## Trace contract

Record account/run/input references, epoch, role/step, safe tool name, operation outcome, policy/schema/prompt versions, latency, token usage, source freshness class and outbound reference. Record concise decisions and assertion results, not private model reasoning.

Normal logs should use opaque or hashed identifiers and safe error codes. Full phone numbers, lead bodies, prompts, tokens, signatures and database connection strings are excluded. Detailed evidence requires separately authorized access and an audit trail; being able to see queue health does not imply permission to browse every business result.

## Operational views

| View              | Useful information                                                                     |
| ----------------- | -------------------------------------------------------------------------------------- |
| Run list          | Status, age, request class, active step, budget used and safe failure category         |
| Run detail        | Plan/assertions, evidence references, verifier outcome and pending input               |
| Delivery          | Queue age, expiry, suppression reason, SDK acceptance and uncertain status             |
| Source health     | Scoped integration availability, freshness and schema faults                           |
| Automation, later | Due occurrences, resolved/cancelled reminders, unmapped recipients and escalation step |

Cancellation must call a fenced run operation. Any retry button must distinguish a safe read retry from an uncertain send/write; the latter cannot blindly dispatch again. Retry/cancel behavior needs a concrete worker API contract before admin controls are added.

## Dummy GUI behavior

Keep the existing fake chat workflow and add an optional developer panel showing structured run progress and captured tool evidence. Synthetic identity controls select fixture employees; browser input must never choose an arbitrary real employee for the production signer. The separate live harness uses an explicitly authorized employee pinned in server configuration, currently Raghav, and performs actual identity checks before signed reads.

Provide scenarios for unknown/active/admin identities, DM/group audience, empty/partial/stale results and revoked access. Distinguish fake tool data from real model generation clearly. Resetting a fixture conversation clears only its test state.

The original `dev:chat` command must not create a Baileys socket, read production auth files, connect to live Supabase or call production Context Engine. The separate `dev:chat:live` entry point deliberately uses live Supabase/Context Engine with its own login and physical capture queues. Neither entry point constructs a real sender. See the [live-data runbook](../live-data-playground.md) for identity, retention and test evidence.

## Metrics and readiness

Measure admitted/duplicate/denied requests, source failures, schema failures, budget exhaustion, repair loops, queue ages, delivery suppression, uncertain sends and per-role usage. Separate source outages from model failures so operational action is clear. Readiness verifies configuration/schema dependencies without sending a message.

Acceptance cases cover redaction, cross-employee artifact access, trace correlation after restart, denied operator evidence access, cancelled runs and fixture-mode isolation. The first CRM slice should expose enough trace data in tests and logs to diagnose each boundary; a full new admin dashboard is a later additive interface change.
