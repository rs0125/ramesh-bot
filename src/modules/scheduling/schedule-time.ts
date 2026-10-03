/** Modern IST calendar arithmetic. Time comes from admitted messages, never the model or host zone. */
import {
  SCHEDULING_TIMEZONE,
  SchedulingError,
  type RecurrenceRule,
  type ReminderTimeInput,
  type ScheduleSpec,
  type TaskDeadline,
} from './scheduling.types.js';

const DAY = 86400000;
const IST_OFFSET = 330 * 60000;
function invalid(): never {
  throw new SchedulingError('INVALID_SCHEDULE');
}
function only(value: object, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid();
}
export function validateLocalDate(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Modern India uses UTC+05:30. Do not reinterpret historical pre-standard-time dates.
  if (
    year < 2000 ||
    year > 9999 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  )
    invalid();
  return value;
}
function instant(value: string): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    invalid();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).getUTCFullYear() < 2000) invalid();
  if (new Date(ms).toISOString() !== value.replace(/(?<!\.\d{3})Z$/, '.000Z')) invalid();
  return ms;
}
function local(ms: number) {
  const d = new Date(ms + IST_OFFSET);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    milli: d.getUTCMilliseconds(),
    weekday: d.getUTCDay() || 7,
  };
}
function localInstant(date: string, time: string): number {
  validateLocalDate(date);
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) invalid();
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET;
}
function monthDays(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function rule(value: RecurrenceRule, dueAt: number): RecurrenceRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  only(value, ['frequency', 'weekdays', 'dayOfMonth', 'until']);
  if (!['daily', 'weekly', 'monthly'].includes(value.frequency)) invalid();
  const at = local(dueAt);
  if (value.until !== undefined && instant(value.until) < dueAt) invalid();
  if (value.frequency === 'weekly') {
    if (
      !Array.isArray(value.weekdays) ||
      !value.weekdays.length ||
      value.weekdays.length > 7 ||
      value.weekdays.some((n) => !Number.isInteger(n) || n < 1 || n > 7) ||
      new Set(value.weekdays).size !== value.weekdays.length ||
      !value.weekdays.includes(at.weekday) ||
      value.dayOfMonth !== undefined
    )
      invalid();
  } else if (value.weekdays !== undefined) invalid();
  if (value.frequency === 'monthly') {
    if (
      value.dayOfMonth !== 'last' &&
      (!Number.isInteger(value.dayOfMonth) ||
        Number(value.dayOfMonth) < 1 ||
        Number(value.dayOfMonth) > 31)
    )
      invalid();
    if (at.day !== (value.dayOfMonth === 'last' ? monthDays(at.year, at.month) : value.dayOfMonth))
      invalid();
  } else if (value.dayOfMonth !== undefined) invalid();
  return {
    frequency: value.frequency,
    ...(value.weekdays ? { weekdays: [...value.weekdays].sort((a, b) => a - b) } : {}),
    ...(value.dayOfMonth !== undefined ? { dayOfMonth: value.dayOfMonth } : {}),
    ...(value.until ? { until: new Date(instant(value.until)).toISOString() } : {}),
  };
}

export function validateSchedule(value: ScheduleSpec): ScheduleSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  only(value, ['dueAt', 'timezone', 'recurrence']);
  if (value.timezone !== SCHEDULING_TIMEZONE) invalid();
  const ms = instant(value.dueAt);
  return {
    dueAt: new Date(ms).toISOString(),
    timezone: SCHEDULING_TIMEZONE,
    ...(value.recurrence !== undefined ? { recurrence: rule(value.recurrence, ms) } : {}),
  };
}

export function resolveSchedule(input: ReminderTimeInput, anchorMs: number): ScheduleSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isFinite(anchorMs))
    invalid();
  only(input, ['localDate', 'localTime', 'afterMinutes', 'recurrence']);
  let at: number;
  if (input.afterMinutes !== undefined) {
    if (
      !Number.isSafeInteger(input.afterMinutes) ||
      input.afterMinutes < 1 ||
      input.afterMinutes > 4000000000 ||
      input.localDate !== undefined ||
      input.localTime !== undefined ||
      input.recurrence !== undefined
    )
      invalid();
    at = anchorMs + input.afterMinutes * 60000;
  } else at = localInstant(input.localDate!, input.localTime!);
  if (!Number.isFinite(at) || at <= anchorMs || new Date(at).getUTCFullYear() > 9999) invalid();
  return validateSchedule({
    dueAt: new Date(at).toISOString(),
    timezone: SCHEDULING_TIMEZONE,
    ...(input.recurrence !== undefined ? { recurrence: input.recurrence } : {}),
  });
}

/** First calendar slot strictly after `after`; skips missing month dates without looping through downtime. */
export function nextOccurrence(input: ScheduleSpec, after: Date): Date | null {
  const spec = validateSchedule(input);
  const start = Date.parse(spec.dueAt);
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) invalid();
  const recurrence = spec.recurrence;
  let next: number | undefined;
  if (afterMs < start) next = start;
  else if (!recurrence) return null;
  else if (recurrence.frequency === 'daily')
    next = start + (Math.floor((afterMs - start) / DAY) + 1) * DAY;
  else if (recurrence.frequency === 'weekly') {
    const candidate = start + Math.floor((afterMs - start) / DAY) * DAY;
    for (let n = 0; n <= 7; n++) {
      const at = candidate + n * DAY;
      if (at > afterMs && recurrence.weekdays!.includes(local(at).weekday)) {
        next = at;
        break;
      }
    }
  } else {
    const base = local(start);
    const current = local(afterMs);
    for (let shift = 0; shift < 24; shift++) {
      const index = current.year * 12 + current.month - 1 + shift;
      const year = Math.floor(index / 12),
        month = (index % 12) + 1;
      if (year > 9999) return null;
      const days = monthDays(year, month);
      const day = recurrence.dayOfMonth === 'last' ? days : recurrence.dayOfMonth!;
      if (day > days) continue;
      const at =
        Date.UTC(year, month - 1, day, base.hour, base.minute, base.second, base.milli) -
        IST_OFFSET;
      if (at > afterMs && at >= start) {
        next = at;
        break;
      }
    }
  }
  if (
    next === undefined ||
    !Number.isFinite(next) ||
    new Date(next).getUTCFullYear() > 9999 ||
    (recurrence?.until && next > Date.parse(recurrence.until))
  )
    return null;
  return new Date(next);
}

export function validateTaskDeadline(value: TaskDeadline): TaskDeadline {
  if (!value || typeof value !== 'object' || value.timezone !== SCHEDULING_TIMEZONE) invalid();
  if (value.precision === 'date') {
    only(value, ['precision', 'localDate', 'timezone']);
    return { ...value, localDate: validateLocalDate(value.localDate) };
  }
  if (value.precision === 'instant') {
    only(value, ['precision', 'at', 'timezone']);
    return { ...value, at: new Date(instant(value.at)).toISOString() };
  }
  return invalid();
}

export function formatIst(value: string | number | Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) invalid();
  return (
    new Intl.DateTimeFormat('en-IN', {
      timeZone: SCHEDULING_TIMEZONE,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date) + ' IST'
  );
}
