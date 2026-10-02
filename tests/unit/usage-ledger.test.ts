import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryUsageLedger } from '../../src/modules/usage/memory-ledger.js';
import {
  type UsageReservation,
  type UsageSettlement,
} from '../../src/modules/usage/usage.types.js';

const reservation = (changes: Partial<UsageReservation> = {}): UsageReservation => ({
  id: randomUUID(),
  accountId: 'fixture-account',
  purpose: 'evaluation',
  runId: 'fixture-run',
  subjectId: 'employee-internal-ref',
  stage: 'worker',
  model: 'fixture-model',
  operation: 'responses',
  priceVersion: 'fixture-prices-v1',
  reservedMicros: 60,
  buckets: [{ key: 'campaign:fixture', limitMicros: 100 }],
  enforce: true,
  ...changes,
});
const settlement = (actualMicros: number): UsageSettlement => ({
  state: 'settled',
  actualMicros,
  inputTokens: 20,
  outputTokens: 10,
  durationMs: 200,
});

test('concurrent reservations cannot overspend a shared bucket; denial leaves no row', async () => {
  const ledger = new MemoryUsageLedger();
  const results = await Promise.allSettled([
    ledger.reserve(reservation()),
    ledger.reserve(reservation()),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected?.reason.code, 'USAGE_BUDGET_EXCEEDED');
  assert.deepEqual(await ledger.summarize('fixture-account', 'evaluation', 'fixture-run'), {
    requestCount: 1,
    settledRequests: 0,
    pendingRequests: 1,
    unknownRequests: 0,
    knownActualMicros: 0,
    heldMicros: 60,
    unpricedRequests: 0,
    costComplete: false,
  });
});

test('run, actor-day, organization-day and campaign constraints are all enforced atomically', async () => {
  const ledger = new MemoryUsageLedger();
  await ledger.reserve(
    reservation({
      buckets: [
        { key: 'run:a', limitMicros: 200 },
        { key: 'actor:a:day:1', limitMicros: 100 },
        { key: 'org:day:1', limitMicros: 200 },
        { key: 'campaign:fixture', limitMicros: 200 },
      ],
    }),
  );
  await assert.rejects(
    ledger.reserve(
      reservation({
        runId: 'another-run',
        buckets: [
          { key: 'run:b', limitMicros: 200 },
          { key: 'actor:a:day:1', limitMicros: 100 },
          { key: 'org:day:1', limitMicros: 200 },
          { key: 'campaign:fixture', limitMicros: 200 },
        ],
      }),
    ),
    { code: 'USAGE_BUDGET_EXCEEDED', bucketKey: 'actor:a:day:1' },
  );
  // A new actor/day bucket does not inherit yesterday's consumption.
  await ledger.reserve(reservation({ buckets: [{ key: 'actor:a:day:2', limitMicros: 100 }] }));
});

test('settlement releases only the unused reservation and records token metadata without double counting', async () => {
  const ledger = new MemoryUsageLedger();
  const first = reservation();
  await ledger.reserve(first);
  await ledger.settle(first.id, { ...settlement(20), cachedInputTokens: 5, reasoningTokens: 3 });
  await ledger.reserve(reservation({ reservedMicros: 80 }));
  await assert.rejects(ledger.reserve(reservation({ reservedMicros: 1 })), {
    code: 'USAGE_BUDGET_EXCEEDED',
  });
  const summary = await ledger.summarize(first.accountId, first.purpose, first.runId);
  assert.equal(summary.knownActualMicros, 20);
  assert.equal(summary.heldMicros, 80);
  assert.equal(summary.settledRequests, 1);
});

test('unknown provider outcomes retain reservations instead of silently returning budget', async () => {
  const ledger = new MemoryUsageLedger();
  const first = reservation();
  await ledger.reserve(first);
  await ledger.settle(first.id, {
    state: 'unknown',
    actualMicros: null,
    durationMs: 90000,
    status: 504,
  });
  await assert.rejects(ledger.reserve(reservation()), { code: 'USAGE_BUDGET_EXCEEDED' });
  const summary = await ledger.summarize(first.accountId, first.purpose, first.runId);
  assert.equal(summary.heldMicros, 60);
  assert.equal(summary.knownActualMicros, 0);
  assert.equal(summary.unknownRequests, 1);
  assert.equal(summary.costComplete, false);
});

test('unpriced observed requests block later strict admission into any matching bucket', async () => {
  const ledger = new MemoryUsageLedger();
  const first = reservation({ reservedMicros: null, enforce: false });
  await ledger.reserve(first);
  await assert.rejects(ledger.reserve(reservation({ reservedMicros: null })), {
    code: 'USAGE_PRICE_UNKNOWN',
  });
  await assert.rejects(ledger.reserve(reservation()), { code: 'USAGE_ACCOUNTING_UNKNOWN' });
  await ledger.settle(first.id, { state: 'unknown', actualMicros: null, durationMs: 1 });
  const summary = await ledger.summarize(first.accountId, first.purpose, first.runId);
  assert.equal(summary.unpricedRequests, 1);
  assert.equal(summary.knownActualMicros, 0);
  assert.equal(summary.costComplete, false);
  await ledger.reserve(reservation({ buckets: [{ key: 'unrelated', limitMicros: 100 }] }));
});

test('a priced settlement resolves an initially unpriced reservation', async () => {
  const ledger = new MemoryUsageLedger();
  const first = reservation({ reservedMicros: null, enforce: false });
  await ledger.reserve(first);
  await ledger.settle(first.id, settlement(10));
  await ledger.reserve(reservation());
  assert.equal(
    (await ledger.summarize(first.accountId, first.purpose, first.runId)).unpricedRequests,
    0,
  );
});

test('actual overage is preserved and blocks future admissions even when already spent', async () => {
  const ledger = new MemoryUsageLedger();
  const first = reservation();
  await ledger.reserve(first);
  await ledger.settle(first.id, settlement(110));
  await assert.rejects(ledger.reserve(reservation({ reservedMicros: 0 })), {
    code: 'USAGE_BUDGET_EXCEEDED',
  });
  const summary = await ledger.summarize(first.accountId, first.purpose, first.runId);
  assert.equal(summary.knownActualMicros, 110);
  assert.equal(summary.heldMicros, 0);
  assert.equal(summary.costComplete, true);
});

test('observe mode records budget violations for later strict admission', async () => {
  const ledger = new MemoryUsageLedger();
  await ledger.reserve(reservation({ reservedMicros: 150, enforce: false }));
  await assert.rejects(ledger.reserve(reservation()), { code: 'USAGE_BUDGET_EXCEEDED' });
});

test('replayed reservations and settlements are idempotent; altered ones cannot rewrite history', async () => {
  const ledger = new MemoryUsageLedger();
  const first = reservation({
    buckets: [
      { key: 'b', limitMicros: 100 },
      { key: 'a', limitMicros: 100 },
    ],
  });
  await ledger.reserve(first);
  await ledger.reserve({
    ...first,
    id: first.id.toUpperCase(),
    buckets: [...first.buckets].reverse(),
  });
  await assert.rejects(ledger.reserve({ ...first, reservedMicros: 59 }), {
    code: 'USAGE_RESERVATION_CONFLICT',
  });
  await ledger.settle(first.id, settlement(20));
  await ledger.settle(first.id, {
    durationMs: 200,
    outputTokens: 10,
    actualMicros: 20,
    state: 'settled',
    inputTokens: 20,
  });
  await assert.rejects(ledger.settle(first.id, settlement(21)), {
    code: 'USAGE_SETTLEMENT_CONFLICT',
  });
  await assert.rejects(ledger.settle(randomUUID(), settlement(20)), {
    code: 'USAGE_RESERVATION_NOT_FOUND',
  });
  assert.equal(
    (await ledger.summarize(first.accountId, first.purpose, first.runId)).requestCount,
    1,
  );
});

test('unknown settlements cannot be overwritten by a retry with different evidence', async () => {
  const ledger = new MemoryUsageLedger();
  const first = reservation();
  await ledger.reserve(first);
  const unknown: UsageSettlement = { state: 'unknown', actualMicros: null, durationMs: 1 };
  await ledger.settle(first.id, unknown);
  await ledger.settle(first.id, unknown);
  await assert.rejects(ledger.settle(first.id, settlement(0)), {
    code: 'USAGE_SETTLEMENT_CONFLICT',
  });
});

test('account and purpose consumption are separate; fixed ledgers cannot switch scope', async () => {
  const ledger = new MemoryUsageLedger();
  await ledger.reserve(reservation());
  await ledger.reserve(reservation({ purpose: 'production' }));
  await ledger.reserve(reservation({ accountId: 'other-account' }));
  assert.equal(
    (await ledger.summarize('fixture-account', 'production', 'fixture-run')).requestCount,
    1,
  );
  const fixed = new MemoryUsageLedger('fixture-account', 'evaluation');
  await assert.rejects(
    fixed.reserve(reservation({ purpose: 'production' })),
    /USAGE_SCOPE_MISMATCH/,
  );
  await assert.rejects(
    fixed.summarize('other-account', 'evaluation', 'fixture-run'),
    /USAGE_SCOPE_MISMATCH/,
  );
  assert.throws(() => new MemoryUsageLedger('fixture-account'), /INVALID_USAGE_SCOPE/);
});

test('invalid, fractional and unsafe amounts are rejected without admitting requests', async () => {
  const ledger = new MemoryUsageLedger();
  await assert.rejects(ledger.reserve(reservation({ buckets: [] })), /INVALID_USAGE_BUCKETS/);
  for (const amount of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(
      ledger.reserve(reservation({ reservedMicros: amount })),
      /INVALID_USAGE_NUMBER/,
    );
  await assert.rejects(
    ledger.reserve(
      reservation({
        buckets: [
          { key: 'same', limitMicros: 10 },
          { key: 'same', limitMicros: 20 },
        ],
      }),
    ),
    /DUPLICATE_USAGE_BUCKET/,
  );
  const first = reservation();
  await ledger.reserve(first);
  await assert.rejects(
    ledger.settle(first.id, { ...settlement(20), actualMicros: null }),
    /INVALID_USAGE_SETTLEMENT/,
  );
  await assert.rejects(
    ledger.settle(first.id, { ...settlement(20), inputTokens: NaN }),
    /INVALID_USAGE_NUMBER/,
  );
  await assert.rejects(
    ledger.settle(first.id, { ...settlement(20), audioSeconds: Infinity }),
    /INVALID_USAGE_NUMBER/,
  );
  await assert.rejects(
    ledger.settle(first.id, { ...settlement(20), status: 0 }),
    /INVALID_USAGE_STATUS/,
  );
});

test('large cumulative amounts never round into apparently available budget', async () => {
  const ledger = new MemoryUsageLedger();
  const large = { reservedMicros: Number.MAX_SAFE_INTEGER, enforce: false };
  await ledger.reserve(reservation(large));
  await ledger.reserve(reservation(large));
  await assert.rejects(
    ledger.reserve(
      reservation({
        reservedMicros: 0,
        buckets: [{ key: 'campaign:fixture', limitMicros: Number.MAX_SAFE_INTEGER }],
      }),
    ),
    { code: 'USAGE_BUDGET_EXCEEDED' },
  );
  await assert.rejects(
    ledger.summarize('fixture-account', 'evaluation', 'fixture-run'),
    /USAGE_TOTAL_OVERFLOW/,
  );
});

test('caller mutation cannot reduce a recorded reservation; empty summaries are complete', async () => {
  const ledger = new MemoryUsageLedger();
  const first = reservation();
  await ledger.reserve(first);
  first.reservedMicros = 0;
  first.buckets[0]!.key = 'changed';
  await assert.rejects(ledger.reserve(reservation()), { code: 'USAGE_BUDGET_EXCEEDED' });
  const summary = await ledger.summarize('fixture-account', 'evaluation', 'no-requests');
  assert.equal(summary.requestCount, 0);
  assert.equal(summary.costComplete, true);
});
