# Production access, pagination and voice delivery

## Scope and release evidence

The production worker was enabled for active employees and given its missing
SELECT-only roster RLS policy. The actual worker login and reciprocal WhatsApp
LID were verified against 14 signed production tools. Runtime configuration is
Sol, medium tool effort, a 240-second agent deadline and 6,000 output tokens.
Analytics remains available in the local full-scope profile, pending its separate
Context Engine signing-scope deployment.

The pagination increment adds accepted-evidence coverage accounting and cycle
detection. Evidence rules allow a clearly labelled provisional warehouse comparison
when listed total space is present but usable area is not recorded.

## Paid outcome checks

- Real Supabase plus production Context Engine: two fresh private trials passed
  a 60-record, five-option comparison. Durations were 86.8 and 72.1 seconds;
  cumulative model input was about 191k and 232k tokens. Delivery was captured,
  never routed to Baileys. Raw source data and answers remain ignored/private.
- Six fictional pagination cases, twice each: initial grading was 8/12. All four
  failures incorrectly required CRM date-card formatting on warehouse cards.
  After explicit rubric correction and contrastive calibration, regrading the
  retained answers passed 12/12. This is a judge-only regrade, not 12 new agent runs.
- Updated judge calibration: 31 labelled examples, twice each, passed 62/62.
- A 160-trial broad run was interrupted after repeated immediate model failures.
  Partial artifacts are retained and excluded from complete-suite claims. A fresh
  run at concurrency two is in progress; its final result will be recorded here.

The complete preceding baseline and prior targeted regrades remain in the
[historical report](2026-10-02-eval-refinement.md). Two private outcomes or a
fixture score do not estimate general production reliability.

## Voice incident regression

The combined change passed **237 deterministic/integration tests, zero skipped**,
plus Prisma validation, TypeScript, build and formatting checks with an isolated
local PostgreSQL test database. No test session connects to WhatsApp.

The screenshot's six-second voice note was stored and transcribed successfully.
Its business answer was suppressed by delivery preflight. Each of its five source
queries still matched its saved fingerprint when re-read independently. Fresh
concurrent preflight consistently failed after about five seconds with Prisma
P1008/P2028 errors in the reciprocal LID resolver.

Replacing overlapping interactive SQLite transactions with a two-key SELECT
snapshot let all five checks pass in 3.54 seconds in an isolated production
process. This check did not instantiate a sender, change CRM data, or replay the
old answer. SQLite is the Baileys session store; message queues remain on Supabase.

Deterministic cases additionally cover six simultaneous LID resolutions, a
mapping changed between key discovery and snapshot, inactive employees, normal
delivery receipts after archival, failed persistence, receipt timeouts and
backpressure, cancelled delivery, neutral-notice lease fencing/restart, and
forwarded voice transcripts before a common response when business output is
withheld. Actual WhatsApp tick rendering is not asserted by a fake socket.

See the [capability review](../../docs/capability-review-2026-10-02.md) for the
remaining work and the AI Engineer research applied to this harness.
