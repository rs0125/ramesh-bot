/** Historical output is conversation data, separately from source refresh and write authority. */
import { createHash } from 'node:crypto';
import {
  historicalDeliveryAt,
  historicalDeliveryOwner,
  historicalDeliveryParts,
  historicalDeliverySchema,
  type HistoricalDelivery,
} from '../messaging/delivery-evidence.js';
import type { PersonalToolRun } from '../scheduling/personal-tools.js';
import type { BusinessWriteRun } from '../writes/write-tools.js';
import type { ContextToolRun } from './tool-executor.js';
import {
  BUSINESS_HISTORY_DAYS,
  BUSINESS_HISTORY_PREFIX,
  boundToolActivity,
  compactToolActivity,
  historicalArguments,
  type ToolActivity,
} from './business-history.js';
import { FOLLOWUPS_QUERY } from './followups.js';

/** Receipt time, owner and delivered text survive result compaction and history eviction. */
export function historyTurnId(value: { text: string; receipt: HistoricalDelivery }) {
  return `turn-${createHash('sha256')
    .update(
      JSON.stringify([
        historicalDeliveryOwner(value.receipt),
        historicalDeliveryAt(value.receipt),
        value.text,
      ]),
    )
    .digest('hex')
    .slice(0, 24)}`;
}

export function compactToolReply(value: HistoricalDelivery): HistoricalDelivery {
  const receipt = structuredClone(value);
  const parts = historicalDeliveryParts(receipt);
  for (const part of [parts.business, parts.personal, parts.write]) {
    if (!part) continue;
    if ('history' in part && part.history)
      part.history.activity = part.history.activity.map(compactToolActivity);
    if (part.kind === 'context_tools' && part.activity)
      part.activity = part.activity.map(compactToolActivity);
  }
  return receipt;
}

/** Compact old result bodies before evicting any whole answer/attempt trail. */
export function fitToolReplies<T extends { text: string; receipt: HistoricalDelivery }>(
  values: T[],
  overBudget: (values: T[]) => boolean,
): T[] {
  const retained = [...values];
  for (let index = 0; index < retained.length && overBudget(retained); index++)
    retained[index] = { ...retained[index]!, receipt: compactToolReply(retained[index]!.receipt) };
  while (retained.length > 1 && overBudget(retained)) retained.shift();
  return retained;
}

export function historicalReply(value: { text: string; receipt: unknown }, now: number) {
  const parsed = historicalDeliverySchema.safeParse(value.receipt);
  if (!parsed.success || value.text.length > 16000) return undefined;
  const at = historicalDeliveryAt(parsed.data);
  if (
    !at ||
    Date.parse(at) > now + 60000 ||
    now - Date.parse(at) >= BUSINESS_HISTORY_DAYS * 86400000
  )
    return undefined;
  return { text: value.text, receipt: parsed.data, at };
}

export function canRecallToolReply(
  value: HistoricalDelivery,
  run?: ContextToolRun,
  personal?: PersonalToolRun,
  writes?: BusinessWriteRun,
) {
  const parts = historicalDeliveryParts(value);
  return (
    (!parts.business ||
      (!!run && !run.blocked && historicalDeliveryOwner(value) === run.employeeId)) &&
    (!parts.personal || !!personal?.canRecall(parts.personal)) &&
    (!parts.write || !!writes?.canRecall(parts.write))
  );
}

export function projectToolReply(
  value: NonNullable<ReturnType<typeof historicalReply>>,
  run?: ContextToolRun,
  personal?: PersonalToolRun,
  writes?: BusinessWriteRun,
  origin?: { request?: string; turnId?: string },
) {
  const parts = historicalDeliveryParts(value.receipt);
  const activities: ToolActivity[] = [];
  let omitted = 0;
  for (const part of [parts.business, parts.personal, parts.write]) {
    if (!part) continue;
    if ('history' in part && part.history) {
      activities.push(...part.history.activity);
      omitted += part.history.omittedCount ?? 0;
    } else if (part.kind === 'context_tools') {
      activities.push(
        ...(part.activity ??
          part.checks.map((check) => ({
            tool: check.tool,
            ...historicalArguments(JSON.stringify(check.arguments)),
            status: 'succeeded' as const,
            at: part.preparedAt,
          }))),
      );
    } else if (part.kind === 'assigned_followups_today') {
      activities.push({
        tool: 'search_crm_leads',
        arguments: FOLLOWUPS_QUERY,
        status: 'succeeded',
        at: part.preparedAt,
      });
    }
  }
  activities.sort((a, b) => a.at.localeCompare(b.at));
  const bounded = boundToolActivity(activities);
  activities.splice(0, activities.length, ...bounded.activity);
  omitted += bounded.omittedCount;
  return {
    content:
      BUSINESS_HISTORY_PREFIX +
      JSON.stringify({
        turn_id: origin?.turnId ?? historyTurnId(value),
        prepared_at: value.at,
        ...(origin?.request ? { original_request: origin.request } : {}),
        reply: value.text,
        tool_activity: activities,
        ...(omitted ? { omitted_activity_count: omitted } : {}),
        ...(parts.business?.kind === 'context_tools' && parts.business.displayedRecords
          ? { displayed_records: parts.business.displayedRecords }
          : {}),
        historical: true,
        tool_health: 'not_current',
        retry_policy:
          'Recorded errors and retryable flags describe the original attempt only. Use current tool availability and live retry limits; history does not blacklist tools. Uncertain writes must reconcile the original operation.',
      }),
    remember() {
      if (parts.business) run?.rememberHistoricalReply();
      if (parts.personal) personal?.rememberHistoricalReply();
      if (parts.write) writes?.rememberHistoricalReply();
      for (const activity of activities)
        for (const record of activity.records ?? [])
          if (record.kind === 'crm_lead') run?.internalCrmIds.add(String(record.id));
    },
  };
}
