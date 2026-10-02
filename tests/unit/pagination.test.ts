import test from 'node:test';
import assert from 'node:assert/strict';
import {
  paginationCoverage,
  paginationContinuations,
  cyclicCursor,
} from '../../src/modules/assistant/pagination.js';
import type { ToolEvidence } from '../../src/modules/assistant/tool-evidence.js';
import { createSalesFixture, FIXTURE_JID, salesEvidence } from '../../scripts/lib/sales-fixture.js';

const now = Date.parse('2026-10-02T04:00:00Z');
const signal = () => AbortSignal.timeout(5000);
function page(ids: number[], cursor?: string, nextCursor: string | null = null): ToolEvidence {
  const args = { city: 'Bengaluru', limit: 25, ...(cursor ? { cursor } : {}) };
  const result = salesEvidence('search_warehouses', args, now);
  result.data.items = ids.map((id) => ({ id }));
  result.data.nextCursor = nextCursor;
  return { id: `page-${cursor ?? 'start'}`, tool: 'search_warehouses', arguments: args, result };
}

test('linked pages count unique IDs and preserve evidence despite overlap and page-size changes', () => {
  const pages = [page([1, 2], undefined, 'fixture:2'), page([2, 3], 'fixture:2')];
  pages[1]!.arguments.limit = 2;
  pages[1]!.arguments.response_format = 'detailed';
  const original = structuredClone(pages);
  assert.deepEqual(paginationCoverage(pages), [
    {
      tool: 'search_warehouses',
      query: { city: 'Bengaluru' },
      pages: 2,
      unique_records: 3,
      duplicate_records: 1,
      status: 'exhausted',
      cross_request_snapshot: false,
    },
  ]);
  assert.deepEqual(pages, original);
});

test('empty continuation is not exhaustion and disconnected recall pages remain unlinked', () => {
  assert.equal(paginationCoverage([page([], undefined, 'fixture:0')])[0]!.status, 'more_available');
  assert.equal(paginationCoverage([page([4], 'fixture:4')])[0]!.status, 'unlinked');
  assert.equal(
    paginationCoverage([page([], undefined, 'fixture:0'), page([1], 'fixture:0')])[0]!.status,
    'exhausted',
  );
  assert.equal(
    paginationCoverage([page([1], undefined, 'fixture:2'), page([4], 'fixture:4')])[0]!.status,
    'unlinked',
  );
  assert.equal(paginationCoverage([page([1]), page([1, 2])])[0]!.status, 'unlinked');
});

test('filters, sort and tool isolate traversals; cycles remain partial', () => {
  const pages = [
    page([1], undefined, 'fixture:1'),
    page([2], 'fixture:1', 'fixture:2'),
    page([3], 'fixture:2', 'fixture:1'),
  ];
  assert.equal(paginationCoverage(pages)[0]!.status, 'cursor_cycle');
  assert.deepEqual(paginationContinuations(pages), []);
  assert.equal(
    cyclicCursor(pages, 'search_warehouses', { city: 'Bengaluru', cursor: 'fixture:1', limit: 1 }),
    true,
  );
  assert.equal(
    cyclicCursor(pages, 'search_warehouses', { city: 'Pune', cursor: 'fixture:1' }),
    false,
  );
  assert.equal(
    cyclicCursor(pages, 'search_warehouses', {
      city: 'Bengaluru',
      sort: 'created_desc',
      cursor: 'fixture:1',
    }),
    false,
  );
  const crm = structuredClone(pages[0]!);
  crm.tool = 'search_crm_leads';
  const other = page([1]);
  other.arguments.city = 'Pune';
  assert.equal(paginationCoverage([...pages, crm, other]).length, 3);
});

test('recall continuations preserve each current query and omit exhausted traversals without mutating evidence', () => {
  const ongoing = page([], undefined, 'fixture:0');
  ongoing.arguments.sort = 'created_desc';
  const exhausted = page([1]);
  exhausted.arguments.city = 'Pune';
  const disconnected = page([4], 'fixture:4', 'fixture:5');
  disconnected.arguments.city = 'Mumbai';
  const pages = [ongoing, exhausted, disconnected];
  const original = structuredClone(pages);
  const next = paginationContinuations(pages);
  assert.equal(next.length, 2);
  assert.deepEqual(next[0]!.arguments, {
    city: 'Bengaluru',
    limit: 25,
    sort: 'created_desc',
    cursor: 'fixture:0',
  });
  assert.equal(next[1]!.coverage.status, 'unlinked');
  assert.equal(next[1]!.arguments.cursor, 'fixture:5');
  assert.deepEqual(pages, original);
});

test('executor blocks a cyclic continuation without another source call or loss of accepted pages', async () => {
  const fixture = createSalesFixture(() => now);
  fixture.state.warehouseCount = 75;
  fixture.state.mutate = (result, tool, args) => {
    if (tool === 'search_warehouses' && args.cursor) result.data.nextCursor = args.cursor;
  };
  const run = (
    await fixture.service.openTools({ key: { remoteJid: FIXTURE_JID }, runId: 'test' }, signal())
  ).run!;
  const args = { city: 'Bengaluru', limit: 25 };
  assert.equal((await run.execute('search_warehouses', JSON.stringify(args), signal())).ok, true);
  const continuation = { ...args, cursor: 'fixture:25' };
  const second = await run.execute('search_warehouses', JSON.stringify(continuation), signal());
  assert.equal(second.ok, true);
  assert.equal(run.pagination[0]!.unique_records, 50);
  const calls = fixture.state.calls.length;
  const stopped = await run.execute(
    'search_warehouses',
    JSON.stringify({ ...continuation, limit: 10 }),
    signal(),
  );
  assert.equal(stopped.code, 'PAGINATION_STALLED');
  assert.equal(fixture.state.calls.length, calls);
  assert.equal(run.evidence.length, 2);
  assert.equal(run.pagination[0]!.status, 'cursor_cycle');
  fixture.state.active = false;
  assert.equal(
    (await run.execute('search_warehouses', JSON.stringify(args), signal())).code,
    'AUTH_REQUIRED',
  );
});

test('broad fictional fixture has consistent detail, summary and overlapping paginated records', async () => {
  const fixture = createSalesFixture(() => now);
  fixture.state.warehouseCount = 75;
  fixture.state.warehousePageOverlap = true;
  const run = (
    await fixture.service.openTools({ key: { remoteJid: FIXTURE_JID }, runId: 'test' }, signal())
  ).run!;
  let cursor: string | null = null;
  do {
    const output = await run.execute(
      'search_warehouses',
      JSON.stringify({
        city: 'Bengaluru',
        sort: 'created_desc',
        limit: 25,
        ...(cursor ? { cursor } : {}),
      }),
      signal(),
    );
    assert.equal(output.ok, true);
    cursor = (output.data as { nextCursor: string | null }).nextCursor;
  } while (cursor);
  assert.equal(run.pagination[0]!.unique_records, 75);
  assert.equal(run.pagination[0]!.duplicate_records, 3);
  assert.equal(run.pagination[0]!.status, 'exhausted');
  const summary = await run.execute(
    'warehouse_summary',
    JSON.stringify({ city: 'Bengaluru' }),
    signal(),
  );
  assert.equal((summary.data as { total: number }).total, 75);
  const detail = await run.execute('read_warehouse', '{"id":175}', signal());
  assert.equal(detail.ok, true);
  assert.match(JSON.stringify(detail.data), /100000/);
});
