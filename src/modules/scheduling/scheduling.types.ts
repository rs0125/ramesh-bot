/** Application-owned personal scheduling contracts. Never accept actor identity from model arguments. */
import type { ReminderSourceQuote } from '../../contracts/reminder-quote.js';
export const SCHEDULING_TIMEZONE = 'Asia/Kolkata' as const;

export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly';
  /** ISO weekdays: Monday=1, Sunday=7. Required for weekly recurrence. */
  weekdays?: number[];
  /** Required for monthly recurrence. Missing dates are skipped, never clamped. */
  dayOfMonth?: number | 'last';
  /** Inclusive absolute UTC end instant. */
  until?: string;
}
export interface ScheduleSpec {
  dueAt: string;
  timezone: typeof SCHEDULING_TIMEZONE;
  recurrence?: RecurrenceRule;
}
export interface ReminderTimeInput {
  localDate?: string;
  localTime?: string;
  afterMinutes?: number;
  recurrence?: RecurrenceRule;
}
export type TaskDeadline =
  | { precision: 'date'; localDate: string; timezone: typeof SCHEDULING_TIMEZONE }
  | { precision: 'instant'; at: string; timezone: typeof SCHEDULING_TIMEZONE };

export interface PersonalActor {
  employeeId: number;
  phoneE164: string;
  chatId: string;
}
export interface PersonalCommandContext extends PersonalActor {
  runId: string;
  leaseToken: string;
  /** Original command-bearing member's server admission clock. */
  requestTimeMs: number;
}
export interface VersionedTarget {
  id: string;
  expectedVersion: number;
}
export type PersonalOperation =
  | { kind: 'task_create'; text: string; alias?: string; deadline?: TaskDeadline }
  | ({ kind: 'task_update'; text?: string; deadline?: TaskDeadline | null } & VersionedTarget)
  | ({ kind: 'task_complete' | 'task_cancel' } & VersionedTarget)
  | {
      kind: 'reminder_create';
      text: string;
      schedule: ScheduleSpec;
      taskRef?: string;
      /** Application-selected current command member; rechecked against durable source rows. */
      sourceMessageId?: string;
    }
  | ({ kind: 'reminder_reschedule'; schedule: ScheduleSpec } & VersionedTarget)
  | ({ kind: 'reminder_cancel' } & VersionedTarget)
  | ({
      kind: 'reminder_snooze';
      occurrenceId: string;
      dueAt: string;
      quotedMessageId?: string;
    } & VersionedTarget)
  /** Application-only exact native reminder reply, never a model-exposed operation. */
  | ({
      kind: 'reminder_acknowledge';
      occurrenceId: string;
      quotedMessageId: string;
    } & VersionedTarget);

export interface PersonalRecord {
  kind: 'task' | 'reminder';
  id: string;
  text: string;
  state: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deadline?: TaskDeadline;
  schedule?: ScheduleSpec;
  /** Current recurring cursor, separate from the last occurrence. Null means no future slot. */
  nextDueAt?: string | null;
  /** Durable delivery outcome retained after individual occurrence history expires. */
  lastOutcome?: string;
  taskId?: string;
  occurrenceId?: string;
  occurrenceState?: string;
  occurrenceDueAt?: string;
  occurrenceAcknowledgedAt?: string;
  alreadySending?: boolean;
  affectedReminders?: number;
}
export interface PersonalCommandReceipt {
  commandId: string;
  runId: string;
  records: PersonalRecord[];
  replayed?: boolean;
  /** Exact post-change presentations, committed with the mutation for crash-safe recovery. */
  lists?: Array<{ kind: 'task' | 'reminder'; result: PersonalListResult }>;
}
export interface PersonalListResult {
  records: PersonalRecord[];
  selectionId: string;
  nextCursor: string | null;
}
export interface PersonalCommandMember {
  id: string;
  text: string;
  receivedAtMs: number;
}
export type PersonalRecallResult =
  | {
      kind: 'instructions';
      members: Array<PersonalCommandMember & { runId: string }>;
      truncated?: boolean;
    }
  | { kind: 'task' | 'reminder'; records: PersonalRecord[]; selectionId?: string };
export interface DueReminder {
  id: string;
  reminderId: string;
  employeeId: number;
  phoneE164: string;
  chatId: string;
  text: string;
  dueAt: string;
  notAfter: string;
  leaseToken: string;
  scheduleVersion: number;
  dispatchGeneration: number;
  /** Minimal original transport quote; never includes retained audio or a transcript. */
  sourceQuote?: ReminderSourceQuote;
}
export interface ReminderDeliveryRef {
  occurrenceId: string;
  reminderId: string;
  scheduleVersion: number;
  dispatchGeneration: number;
  ownerEmployeeId: number;
  recipientPhoneE164: string;
  notAfterMs: number;
}
export class SchedulingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SchedulingError';
  }
}
