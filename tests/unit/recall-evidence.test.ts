import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRecall } from '../../src/modules/assistant/recall-evidence.js';
import type { ToolEvidence } from '../../src/modules/assistant/tool-evidence.js';

function evidence(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  data: Record<string, unknown>,
): ToolEvidence {
  return {
    id,
    tool,
    arguments: args,
    result: {
      source_path: '/api/v1/fixture',
      status: 200,
      data,
      meta: { requestId: id, generatedAt: '2026-10-03T04:00:00Z' },
    },
  };
}
const warehouse = (evidenceId: string, id: number, rent = 20) =>
  evidence(evidenceId, 'read_warehouse', { id }, { id, city: 'Synthetic City', rent });
function recalled(sources: ToolEvidence[], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    turn: 1,
    previous_reply_verified: true,
    previous_reply: 'OLD_SUPPORTED_ANSWER',
    requested_checks: sources.length,
    refreshed_checks: sources.length,
    unavailable_checks: [],
    source_record_checks: sources.map((entry) => ({
      evidence_id: entry.id,
      same_records: true,
      same_order: true,
    })),
    fresh_evidence: sources.map((entry) => ({
      evidence_id: entry.id,
      tool: entry.tool,
      arguments: entry.arguments,
      data: entry.result.data,
    })),
    pagination: [{ OLD_PAGINATION: true }],
    continuations: [{ OLD_CONTINUATION: true }],
    ...extra,
  };
}

test('an equal replacement with canonical arguments retains prior prose and remaps all supporting IDs', () => {
  const old = evidence(
    'old-lead',
    'read_crm_lead',
    { id: 'synthetic-lead', filter: { a: 1, b: 2 } },
    { id: 'synthetic-lead', name: 'Synthetic Client' },
  );
  const replacement = evidence(
    'new-lead',
    'read_crm_lead',
    { filter: { b: 2, a: 1 }, id: 'synthetic-lead' },
    structuredClone(old.result.data),
  );
  const value = recalled([old]);
  const snapshot = structuredClone(value);
  const result = currentRecall(value, [old], [replacement])!;
  assert.equal(result.previous_reply_verified, true);
  assert.equal(result.previous_reply, 'OLD_SUPPORTED_ANSWER');
  assert.deepEqual(result.source_record_checks, [
    { evidence_id: 'new-lead', same_records: true, same_order: true },
  ]);
  assert.equal((result.fresh_evidence as any[])[0].evidence_id, 'new-lead');
  assert.deepEqual(result.pagination, []);
  assert.deepEqual(result.continuations, []);
  assert.deepEqual(value, snapshot);
});

test('a changed replacement removes old prose but preserves independently authorized selection with fresh values', () => {
  const old = warehouse('old', 101, 20),
    current = warehouse('new', 101, 35);
  const result = currentRecall(
    recalled([old], {
      displayed_selection: [{ kind: 'warehouse', id: 101, position: 2, evidence_id: 'old' }],
      selection_count: 3,
      selection_status: 'partial',
      selection_source: 'receipt',
    }),
    [old],
    [current],
  )!;
  assert.equal(result.previous_reply_verified, false);
  assert.equal(result.previous_reply, undefined);
  assert.equal(result.selection_status, 'partial');
  assert.deepEqual(result.displayed_selection, [
    { kind: 'warehouse', id: 101, position: 2, evidence_id: 'new' },
  ]);
  assert.equal((result.fresh_evidence as any[])[0].data.rent, 35);
  assert.doesNotMatch(
    JSON.stringify(result),
    /OLD_SUPPORTED_ANSWER|OLD_PAGINATION|OLD_CONTINUATION|"rent":20/,
  );
});

test('revoking all active warehouse evidence hides identities, arguments, old values and prose', () => {
  const old = warehouse('old-private', 991234, 876543);
  const result = currentRecall(
    recalled([old], {
      displayed_selection: [
        { kind: 'warehouse', id: 991234, position: 1, evidence_id: 'old-private' },
      ],
      selection_count: 1,
    }),
    [old],
    [],
  )!;
  assert.deepEqual(result.displayed_selection, []);
  assert.equal(result.selection_status, 'unavailable');
  assert.deepEqual(result.fresh_evidence, []);
  assert.equal(result.previous_reply, undefined);
  assert.doesNotMatch(JSON.stringify(result), /991234|876543|old-private|OLD_SUPPORTED_ANSWER/);
});

test('an unrelated retired source does not remove an authorized selected warehouse', () => {
  const selected = warehouse('warehouse', 101);
  const unrelated = evidence(
    'other-query',
    'search_crm_leads',
    { view: 'accessible' },
    { items: [{ id: 'unrelated-lead' }], nextCursor: null },
  );
  const value = recalled([selected], {
    previous_reply_verified: false,
    displayed_selection: [{ kind: 'warehouse', id: 101, position: 1, evidence_id: selected.id }],
    selection_count: 1,
  });
  const result = currentRecall(value, [selected, unrelated], [selected])!;
  assert.equal(result.selection_status, 'complete');
  assert.equal((result.displayed_selection as any[])[0].id, 101);
  assert.deepEqual(result.unavailable_checks, []);
  assert.equal(result.previous_reply, undefined);
});

test('one changed or missing supporting read invalidates the whole historical prose', () => {
  const first = warehouse('first', 101),
    second = warehouse('second', 202);
  for (const active of [[first], [first, warehouse('new-second', 202, 40)]]) {
    const result = currentRecall(recalled([first, second]), [first, second], active)!;
    assert.equal(result.previous_reply_verified, false);
    assert.equal(result.previous_reply, undefined);
    assert.ok((result.fresh_evidence as any[]).some((entry) => entry.data.id === 101));
  }
});

test('same entity IDs under a different tool or scope cannot authorize historical prose or selected records', () => {
  const old = warehouse('old', 101);
  const otherScope = evidence(
    'different-scope',
    'read_warehouse',
    { id: 202 },
    { id: 101, rent: 20 },
  );
  const search = evidence(
    'search',
    'search_warehouses',
    {},
    { items: [{ id: 101, rent: 20 }], nextCursor: null },
  );
  const result = currentRecall(
    recalled([old], {
      displayed_selection: [{ kind: 'warehouse', id: 101, position: 1, evidence_id: 'old' }],
      selection_count: 1,
    }),
    [old],
    [otherScope, search],
  )!;
  assert.equal(result.previous_reply, undefined);
  assert.deepEqual(result.displayed_selection, []);
  assert.deepEqual(result.fresh_evidence, []);
});

test('pagination uses active replacement and continuation pages, without stale cursor or unrelated scope', () => {
  const old = evidence(
    'old-page',
    'search_warehouses',
    { city: 'Synthetic City', limit: 1 },
    { items: [{ id: 101 }], nextCursor: 'stale-cursor' },
  );
  const first = evidence(
    'new-page',
    'search_warehouses',
    { limit: 1, city: 'Synthetic City' },
    { items: [{ id: 101 }], nextCursor: 'current-cursor' },
  );
  const second = evidence(
    'page-two',
    'search_warehouses',
    { city: 'Synthetic City', limit: 1, cursor: 'current-cursor' },
    { items: [{ id: 202 }], nextCursor: null },
  );
  const unrelated = evidence(
    'other-city',
    'search_warehouses',
    { city: 'Another City' },
    { items: [{ id: 303 }], nextCursor: 'unrelated-cursor' },
  );
  const result = currentRecall(recalled([old]), [old], [first, second, unrelated])!;
  assert.equal(result.previous_reply, undefined);
  assert.equal((result.pagination as any[])[0].status, 'exhausted');
  assert.equal((result.pagination as any[])[0].unique_records, 2);
  assert.deepEqual(result.continuations, []);
  assert.deepEqual(
    (result.fresh_evidence as any[]).map((entry) => entry.evidence_id),
    ['new-page', 'page-two'],
  );
  assert.doesNotMatch(JSON.stringify(result), /stale-cursor|unrelated-cursor|Another City/);
});

test('a newer changed accepted read wins over an older equal duplicate', () => {
  const old = warehouse('old', 101, 20),
    current = warehouse('new', 101, 35);
  const result = currentRecall(recalled([old]), [old], [old, current])!;
  assert.equal(result.previous_reply, undefined);
  assert.deepEqual(
    (result.fresh_evidence as any[]).map((entry) => entry.data.rent),
    [35],
  );
});

test('failure and malformed recall cannot preserve hidden business fields', () => {
  const failed = currentRecall(
    { ok: false, code: 'ACCESS_DENIED', previous_reply: 'PRIVATE', fresh_evidence: [{ id: 101 }] },
    [],
    [],
  );
  assert.deepEqual(failed, { ok: false, code: 'ACCESS_DENIED' });
  assert.equal(currentRecall({ ok: true, previous_reply: 'PRIVATE' }, [], []), undefined);
  assert.equal(
    currentRecall({ ok: true, source_record_checks: [{}], previous_reply: 'PRIVATE' }, [], []),
    undefined,
  );
});

test('a duplicate superseded search page cannot re-enter fresh evidence through pagination', () => {
  const old = evidence(
    'old-page',
    'search_warehouses',
    { city: 'Synthetic City' },
    { items: [{ id: 101, rent: 20 }], nextCursor: 'stale' },
  );
  const latest = evidence(
    'current-page',
    'search_warehouses',
    { city: 'Synthetic City' },
    { items: [{ id: 101, rent: 40 }], nextCursor: null },
  );
  const result = currentRecall(recalled([old]), [old], [old, latest])!;
  assert.equal(result.previous_reply, undefined);
  assert.deepEqual(
    (result.fresh_evidence as any[]).map((entry) => entry.evidence_id),
    ['current-page'],
  );
  assert.equal((result.pagination as any[])[0].status, 'exhausted');
  assert.doesNotMatch(JSON.stringify(result), /"rent":20|"stale"/);
});
