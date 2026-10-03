# SLA breaches and escalation

Status: **Proposed bot integration with CRM-Automations.** Depends on [reminders](15-reminders.md), [delivery](14-outbound-delivery.md) and the CRM domain's existing rules. The selected recipient order is **lead assignee(s), then existing CRM admins**.

The [reminders/tasks draft](../reminders-and-tasks-design.md) now separates personal intent from delivery occurrences. Use its [scheduler contract](50-reminder-scheduler.md) and [migration/evaluation plan](51-reminder-migration-and-evaluation.md) for transport integration; neither the deployed immediate outbound API nor that draft activates SLA notifications.

## Responsibility and domain ownership

CRM-Automations owns source synchronization, meaningful-activity clocks, stage clocks, rule evaluation and alert episodes. Ramesh owns authorized notification preparation and WhatsApp delivery. A planner or model does not decide whether an SLA was breached, and the bot should not add an independent Twenty polling loop.

Relevant clocks remain distinct: `nextFollowUp`, `stageEnteredAt`, `lastMeaningfulUpdateAt` and a personal reminder's due time. Generic `updatedAt`, alert acknowledgement and message delivery are not substitutes for qualifying sales activity.

## Producer contract

A proposed alert occurrence contains rule ID/version, episode ID, entity reference, observed condition, source observation/freshness, intended escalation step, due time and stable occurrence key. It contains logical recipient references; routing resolves active employees before preparing WhatsApp content.

The producer writes the episode transition and notification intent atomically or uses its own transactional outbox with an idempotent bot consumer. A transport outage cannot silently lose a committed escalation. Ramesh must not duplicate the authoritative episode state under a second rule engine.

## Evaluation and escalation

1. Require healthy relevant source streams and known rule semantics.
2. Find an active breach episode and current assignee mapping.
3. Produce the assignee notification occurrence once.
4. After the configured grace period, re-evaluate the underlying condition.
5. Escalate unresolved eligible episodes to the existing CRM admins.
6. Resolve/cancel obsolete pending work after closure, reassignment, stage change or rule-specific qualifying activity.

Deduplicate an occurrence using rule, entity, episode, policy version, escalation step, recipient and recurrence slot. Repeat evaluations of one slot reuse the occurrence; a later scheduled slot or new episode can create another.

An email fallback recipient list is not a verified WhatsApp identity. Ambiguous/unmapped recipients become visible routing failures rather than guessed phone numbers. Admin-recipient membership also does not automatically prove authority to receive every referenced detail; notification projection follows explicit current access policy.

## Decisions needed before activation

The CRM owner must settle threshold boundaries, missing-clock behavior, grace periods, repeat cadence, quiet hours, volume caps and unassigned-lead behavior. Existing email schedules do not define these WhatsApp policies. No new SLA should be inferred for stages that lack one.

The inspected `CRM-Automations/src/lib/sla.js` floors elapsed 24-hour days and marks RED only when that count exceeds `yellowMax`; its deadline label uses a different apparent boundary, and a missing stage clock currently renders GREEN. Resolve these domain semantics in CRM-Automations before enabling WhatsApp escalation. Ramesh must not silently reinterpret “two days” as an exact 48-hour breach or treat a missing clock as verified healthy evidence.

Automation needs its own authenticated invocation and authorized read/projection contract. The implemented interactive signed MCP path is not blanket organization-wide automation authority. Service identity and recipient permission checks remain separate concerns.

## Acceptance and preview

Test boundary times, stale mirrors, degraded notes/tasks streams, repeated ticks, missed ticks, unresolved-to-resolved transitions, reassignment during grace, multiple assignees, duplicate admin membership, missing phone links, snooze and uncertain delivery. Confirm acknowledgements do not change CRM activity clocks.

A preview report should show which rule, episode, recipients, time and projected message would be used without enqueueing a real send. Rollout depends on approved product policy and source health evidence, not solely on a passing model eval.
