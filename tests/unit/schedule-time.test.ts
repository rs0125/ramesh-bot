import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatIst,
  nextOccurrence,
  resolveSchedule,
  validateSchedule,
  validateTaskDeadline,
} from '../../src/modules/scheduling/schedule-time.js';

const anchor = Date.parse('2026-10-03T18:29:00.000Z'); // 23:59 IST
test('IST instants and durations use the admitted clock and support dates well beyond 24 hours', () => {
  const explicit = resolveSchedule({ localDate: '2026-11-15', localTime: '10:00' }, anchor);
  assert.equal(explicit.dueAt, '2026-11-15T04:30:00.000Z');
  assert.equal(
    resolveSchedule({ afterMinutes: 6 * 7 * 24 * 60 }, anchor).dueAt,
    '2026-11-14T18:29:00.000Z',
  );
  assert.equal(resolveSchedule({ afterMinutes: 10 }, anchor).dueAt, '2026-10-03T18:39:00.000Z');
  assert.match(formatIst(explicit.dueAt), /15 November 2026.*10:00.*am IST/i);
  assert.equal(
    resolveSchedule({ localDate: '2031-01-01', localTime: '00:00' }, anchor).dueAt,
    '2030-12-31T18:30:00.000Z',
  );
});
test('calendar validation rejects rolled dates, ambiguous clocks and authority-shaped fields', () => {
  for (const input of [
    { localDate: '2027-02-29', localTime: '10:00' },
    { localDate: '2026-10-04', localTime: '8' },
    { localDate: '2026-10-04', localTime: '24:00' },
    { localDate: '2026-10-03', localTime: '08:00' },
    { afterMinutes: 0 },
    { afterMinutes: -1 },
    { afterMinutes: 1.5 },
    { afterMinutes: 10, localTime: '10:00' },
    { afterMinutes: 10, ownerEmployeeId: 5 },
    { localDate: 'tomorrow', localTime: '10:00' },
  ])
    assert.throws(() => resolveSchedule(input, anchor), /INVALID_SCHEDULE/);
  assert.throws(() =>
    validateSchedule({ dueAt: '2027-02-29T00:00:00.000Z', timezone: 'Asia/Kolkata' }),
  );
  assert.throws(() =>
    validateSchedule({ dueAt: '2027-01-01T00:00:00+05:30', timezone: 'Asia/Kolkata' }),
  );
});
test('monthly day31 skips missing dates; last-day and leap-day rules remain distinct', () => {
  const monthly = resolveSchedule(
    {
      localDate: '2026-10-31',
      localTime: '09:00',
      recurrence: { frequency: 'monthly', dayOfMonth: 31 },
    },
    anchor,
  );
  assert.equal(
    nextOccurrence(monthly, new Date(monthly.dueAt))?.toISOString(),
    '2026-12-31T03:30:00.000Z',
  );
  const lastDay = resolveSchedule(
    {
      localDate: '2026-10-31',
      localTime: '09:00',
      recurrence: { frequency: 'monthly', dayOfMonth: 'last' },
    },
    anchor,
  );
  assert.equal(
    nextOccurrence(lastDay, new Date('2028-01-31T03:30:00Z'))?.toISOString(),
    '2028-02-29T03:30:00.000Z',
  );
  assert.equal(
    nextOccurrence(lastDay, new Date('2027-01-31T03:30:00Z'))?.toISOString(),
    '2027-02-28T03:30:00.000Z',
  );
  assert.equal(
    resolveSchedule({ localDate: '2028-02-29', localTime: '12:00' }, anchor).dueAt,
    '2028-02-29T06:30:00.000Z',
  );
});
test('weekly, daily and recurrence endings advance directly across long downtime', () => {
  const weekly = resolveSchedule(
    {
      localDate: '2026-10-05',
      localTime: '09:00',
      recurrence: { frequency: 'weekly', weekdays: [1, 2, 3, 4, 5] },
    },
    anchor,
  );
  assert.equal(
    nextOccurrence(weekly, new Date('2026-10-09T03:30:00Z'))?.toISOString(),
    '2026-10-12T03:30:00.000Z',
  );
  const daily = resolveSchedule(
    { localDate: '2026-10-04', localTime: '09:00', recurrence: { frequency: 'daily' } },
    anchor,
  );
  assert.equal(
    nextOccurrence(daily, new Date('2030-06-01T04:00:00Z'))?.toISOString(),
    '2030-06-02T03:30:00.000Z',
  );
  const ending = {
    ...daily,
    recurrence: { frequency: 'daily' as const, until: '2026-10-05T03:30:00.000Z' },
  };
  assert.equal(
    nextOccurrence(ending, new Date(daily.dueAt))?.toISOString(),
    ending.recurrence.until,
  );
  assert.equal(nextOccurrence(ending, new Date(ending.recurrence.until)), null);
  assert.equal(
    nextOccurrence({ dueAt: daily.dueAt, timezone: 'Asia/Kolkata' }, new Date(daily.dueAt)),
    null,
  );
  assert.equal(nextOccurrence(daily, new Date(anchor))?.toISOString(), daily.dueAt);
  assert.throws(() =>
    resolveSchedule(
      {
        localDate: '2026-10-05',
        localTime: '09:00',
        recurrence: { frequency: 'weekly', weekdays: [2] },
      },
      anchor,
    ),
  );
});
test('date-only task deadlines stay dates and never invent reminder timing', () => {
  assert.deepEqual(
    validateTaskDeadline({ precision: 'date', localDate: '2026-10-09', timezone: 'Asia/Kolkata' }),
    { precision: 'date', localDate: '2026-10-09', timezone: 'Asia/Kolkata' },
  );
  assert.throws(() =>
    validateTaskDeadline({ precision: 'date', localDate: '2026-02-30', timezone: 'Asia/Kolkata' }),
  );
});
