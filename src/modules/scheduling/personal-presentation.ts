/** Pure deterministic personal record presentation, shared by storage page sizing and replies. */
import { formatIst } from './schedule-time.js';
import type {
  PersonalRecord,
  PersonalCommandReceipt,
  PersonalListResult,
} from './scheduling.types.js';

export const PERSONAL_LIST_MAX_CHARACTERS = 5000;

function describe(record: PersonalRecord, receipt = false): string {
  const pendingOccurrence =
    record.occurrenceDueAt &&
    ['pending', 'preparing', 'waiting_source', 'queued'].includes(record.occurrenceState ?? '')
      ? record.occurrenceDueAt
      : undefined;
  const nextDue = [record.nextDueAt, pendingOccurrence]
    .filter((value): value is string => !!value)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const reminderTime = receipt
    ? `; ${formatIst(record.occurrenceDueAt ?? record.nextDueAt ?? record.schedule?.dueAt ?? record.createdAt)}`
    : nextDue
      ? `; next ${formatIst(nextDue)}${pendingOccurrence && pendingOccurrence !== nextDue ? `; pending notification ${formatIst(pendingOccurrence)}` : ''}`
      : `; ${record.occurrenceDueAt ? 'last scheduled' : 'scheduled'} ${formatIst(record.occurrenceDueAt ?? record.schedule?.dueAt ?? record.createdAt)}`;
  const time = record.schedule
    ? reminderTime
    : record.deadline?.precision === 'instant'
      ? `; due ${formatIst(record.deadline.at)}`
      : record.deadline
        ? `; due ${record.deadline.localDate} (IST date)`
        : '';
  const rule = record.schedule?.recurrence;
  const recurrence = !rule
    ? ''
    : rule.frequency === 'daily'
      ? '; daily'
      : rule.frequency === 'weekly'
        ? `; weekly on ${rule.weekdays!.map((day) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day - 1]).join(', ')}`
        : `; monthly ${rule.dayOfMonth === 'last' ? 'on the last day' : `on day ${rule.dayOfMonth} (months without that date are skipped)`}`;
  const compactText = record.text.replace(/\s+/g, ' ').trim();
  return `${compactText.length > 280 ? compactText.slice(0, 277) + '...' : compactText}${time}${recurrence}${rule?.until ? `; until ${formatIst(rule.until)}` : ''}`;
}
export function renderReceipt(receipt: PersonalCommandReceipt): string {
  return receipt.records
    .map(
      (record) =>
        `${record.kind === 'task' ? (record.state === 'done' ? 'Completed task' : record.state === 'cancelled' ? 'Cancelled task' : 'Saved task') : record.state === 'cancelled' ? 'Cancelled reminder' : 'Saved reminder'}: ${describe(record, true)}.${record.affectedReminders ? ` Cancelled ${record.affectedReminders} linked reminder${record.affectedReminders === 1 ? '' : 's'}.` : ''}${record.alreadySending ? ' A notification has already started sending and may still arrive.' : ''}`,
    )
    .join('\n');
}
export function renderList(kind: 'task' | 'reminder', result: PersonalListResult): string {
  if (!result.records.length)
    return `No personal ${kind === 'task' ? 'tasks' : 'reminders'} match that filter.`;
  return `Your ${kind === 'task' ? 'tasks' : 'reminders'} (this page):\n${result.records.map((record, index) => `${index + 1}. ${describe(record)} [${record.state}${record.occurrenceState ? `; ${['pending', 'preparing', 'waiting_source', 'queued'].includes(record.occurrenceState) ? 'notification' : 'last occurrence'} ${record.occurrenceState}` : record.lastOutcome ? `; last delivery ${record.lastOutcome}` : ''}]`).join('\n')}${result.nextCursor ? '\nMore entries are available.' : ''}`;
}
