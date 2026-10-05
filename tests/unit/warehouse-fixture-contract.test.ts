/** Synthetic contract checks only: no model, network, database or transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSalesFixture,
  FIXTURE_JID,
  FIXTURE_LEAD_ID,
  SALES_CATALOGUE,
  salesEvidence,
} from '../../scripts/lib/sales-fixture.js';
import { schemaAccepts } from '../../src/modules/context-engine/read-contract.js';

const now = Date.parse('2026-10-05T05:00:00Z');
const messy = { messyWarehouseFacts: true };
const ids = (args: Record<string, unknown>) =>
  (
    salesEvidence('search_warehouses', { city: 'Bengaluru', ...args }, now, messy).data
      .items as Array<{ id: number }>
  ).map((row) => row.id);

test('catalogue supports bounded recorded-context detail reads and permissive defaults', () => {
  const read = SALES_CATALOGUE.find((tool) => tool.name === 'read_warehouse')!;
  assert.equal(schemaAccepts(read.inputSchema, { id: 101, context_fields: ['compliances'] }), true);
  assert.equal(
    schemaAccepts(read.inputSchema, { id: 101, context_fields: ['owner_phone'] }),
    false,
  );
  const search = SALES_CATALOGUE.find((tool) => tool.name === 'search_warehouses')!;
  assert.match(JSON.stringify(search.inputSchema), /Default true in permissive mode/);
});

test('structured and narrative requirements survive detail and assessment without inventing note coverage', () => {
  const detail = salesEvidence('read_crm_lead', { id: FIXTURE_LEAD_ID }, now).data;
  const assessment = salesEvidence('assess_shortlist', { lead_id: FIXTURE_LEAD_ID }, now).data;
  const context = assessment.requirement_context as any;
  assert.deepEqual(context.description, detail.description);
  assert.equal(context.description.state, 'present');
  assert.match(context.description.text, /Fully compliant/);
  assert.match(context.description.text, /no numeric dock, height or power minimum/);
  assert.equal(context.notes.status, 'not_loaded');
  assert.equal((assessment.requirements as unknown[]).length, 9);
  assert.deepEqual(assessment.candidates, []);
});

test('assessment keeps explicit user overrides distinct from recorded facts and does not alter the fixture', () => {
  const assessment = salesEvidence(
    'assess_shortlist',
    { lead_id: FIXTURE_LEAD_ID, warehouse_ids: [101], area_min_sqft: 27000, area_max_sqft: 29000 },
    now,
  ).data;
  const area = (assessment.requirements as any[]).find((item) => item.field === 'area_sqft');
  assert.deepEqual(area.recorded_value, { kind: 'exact', value: 25000 });
  assert.deepEqual(area.effective_value, { kind: 'explicit_bounds', min: 27000, max: 29000 });
  assert.equal(area.source, 'employee_override');
  assert.equal(area.override_differs_from_record, true);
  assert.equal(
    salesEvidence('read_crm_lead', { id: FIXTURE_LEAD_ID }, now).data.requirement_sqft,
    25000,
  );
  assert.equal(
    (assessment.candidates as any[])[0].checks.find((item: any) => item.field === 'area_sqft')
      .state,
    'conflict',
  );
});

test('unknown and ranged numeric candidates are included by default and excluded only as requested', () => {
  assert.deepEqual(ids({ clear_height_min_ft: 29 }), [102, 103]);
  assert.deepEqual(ids({ clear_height_min_ft: 29, include_unknown: 'false' }), [103]);
  assert.deepEqual(ids({ clear_height_min_ft: 29, match_mode: 'strict' }), []);
  assert.deepEqual(
    ids({ clear_height_min_ft: 29, match_mode: 'strict', include_unknown: 'true' }),
    [102],
  );
  assert.deepEqual(ids({ docks_min: 3, docks_max: 3, include_unknown: 'false' }), [101, 103]);
  assert.deepEqual(ids({ docks_min: 3, docks_max: 3, match_mode: 'strict' }), [103]);
  const policy = salesEvidence('search_warehouses', {}, now).data.matching_policy as any;
  assert.equal(policy.include_unknown, true);
  assert.equal(policy.range_matching, 'overlap');
});

test('array areas are separate options, unknown is not zero, and exact fire filters stay exact', () => {
  assert.deepEqual(ids({ area_min_sqft: 27000, area_max_sqft: 28000 }), [102, 103, 104, 105]);
  assert.deepEqual(ids({ area_min_sqft: 45000, include_unknown: 'false' }), []);
  assert.deepEqual(ids({ area_min_sqft: 45000 }), [105]);
  assert.deepEqual(
    ids({ area_min_sqft: 27000, offered_area_max_sqft: 27000, include_unknown: 'false' }),
    [102],
  );
  assert.deepEqual(ids({ fire_noc: 'true' }), [101]);
  assert.deepEqual(ids({ fire_noc: 'false', include_unknown: 'true' }), [105]);
  assert.deepEqual(ids({ fire_noc: 'unknown' }), [102, 103, 104]);
});

test('source prose is retained when numeric parsing cannot interpret a value; detail selection omits unrelated context', () => {
  const row = salesEvidence('read_warehouse', { id: 102 }, now, messy).data as any;
  assert.equal(row.clear_height_ft, null);
  assert.equal(row.field_evidence.clear_height_ft.kind, 'unknown');
  assert.match(row.field_evidence.clear_height_ft.recorded_source.text, /roof bracing/);
  const selected = salesEvidence(
    'read_warehouse',
    { id: 102, context_fields: ['compliances'] },
    now,
    messy,
  ).data as any;
  assert.deepEqual(Object.keys(selected.recorded_context), ['compliances']);
  assert.equal(selected.recorded_context.compliances.state, 'present');
  assert.equal('floor_strength_per_sqm' in selected.recorded_context, false);
});

test('summaries, paginated discovery and detail retain the same synthetic record facts', () => {
  const args = { city: 'Bengaluru', clear_height_min_ft: 29, limit: 1 };
  const first = salesEvidence('search_warehouses', args, now, messy).data;
  const second = salesEvidence(
    'search_warehouses',
    { ...args, cursor: first.nextCursor },
    now,
    messy,
  ).data;
  const items = [...(first.items as any[]), ...(second.items as any[])];
  assert.equal(salesEvidence('warehouse_summary', args, now, messy).data.total, items.length);
  assert.deepEqual(
    first.matching_policy,
    salesEvidence('warehouse_summary', args, now, messy).data.matching_policy,
  );
  for (const row of items)
    assert.deepEqual(salesEvidence('read_warehouse', { id: row.id }, now, messy).data, row);
});

test('fixtures refresh reads like production unless a cache test explicitly opts in', async () => {
  const fixture = createSalesFixture(() => now);
  const signal = new AbortController().signal;
  const run = (
    await fixture.service.openTools(
      { key: { remoteJid: FIXTURE_JID }, runId: 'fixture-refresh' },
      signal,
    )
  ).run!;
  const first = await run.execute('read_warehouse', '{"id":101}', signal);
  fixture.state.mutate = (result, tool) => {
    if (tool === 'read_warehouse') result.data.fire_noc_available = false;
  };
  const second = await run.execute('read_warehouse', '{"id":101}', signal);
  assert.equal(second.ok, true);
  assert.equal(second.reused_in_run, undefined);
  assert.notEqual(second.evidence_id, first.evidence_id);
  assert.equal(fixture.state.calls.length, 2);
  assert.equal(run.evidence[0]!.result.data.fire_noc_available, false);
});
