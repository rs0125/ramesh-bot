import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsFixture } from '../../scripts/lib/analytics-fixture.js';
import {
  verifyToolEvidence,
  toolEvidenceFingerprint,
} from '../../src/modules/assistant/tool-evidence.js';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';

const now = Date.parse('2026-10-02T01:00:00Z');
test('analytics uses each source calendar and citation-safe filters', () => {
  for (const [tool, args] of [
    ['ga4_report', { report: 'overview', period: 'last_7_days', compare_to: 'previous_period' }],
    [
      'search_console_report',
      {
        group: 'query_page',
        query_equals: 'warehouse bengaluru',
        page_equals: 'https://example.test/warehouses/bengaluru',
        country: 'ind',
      },
    ],
    ['ga4_report', { report: 'form_performance', landing_page_contains: '/warehouses' }],
    ['analytics_capabilities', {}],
  ] as const) {
    const evidence = analyticsFixture(tool, args, now);
    assert.doesNotThrow(() => verifyToolEvidence(tool, args, evidence, now));
    if (tool === 'search_console_report') {
      assert.equal((evidence.data.query_context as any).local_date, '2026-10-01');
      assert.ok(!evidence.source_path.includes('warehouse bengaluru'));
    }
  }
});
test('reread provenance changes are harmless but changed metrics or quality are not', () => {
  const args = { report: 'overview', period: 'last_7_days', compare_to: 'previous_period' };
  const first = analyticsFixture('ga4_report', args, now),
    second = analyticsFixture('ga4_report', args, now + 5000);
  assert.equal(toolEvidenceFingerprint(first), toolEvidenceFingerprint(second));
  (second.data.items as any[])[0].metrics.sessions++;
  assert.notEqual(toolEvidenceFingerprint(first), toolEvidenceFingerprint(second));
  const third = analyticsFixture('ga4_report', args, now);
  (third.data.quality as any).provisional = !(third.data.quality as any).provisional;
  assert.notEqual(toolEvidenceFingerprint(first), toolEvidenceFingerprint(third));
});
test('invalid analytics envelope, filter, comparison and component evidence fail closed', () => {
  const args = { report: 'overview', period: 'last_7_days', compare_to: 'previous_period' };
  const mutations = [
    (d: any) => {
      d.source.system = 'search_console';
    },
    (d: any) => {
      d.query_context.timezone = 'America/Los_Angeles';
    },
    (d: any) => {
      d.query_context.period = 'today';
    },
    (d: any) => {
      d.pagination.returned_count = 7;
    },
    (d: any) => {
      d.served_at = '2020-01-01T00:00:00Z';
    },
    (d: any) => {
      d.source_fetched_at = '2020-01-01T00:00:00Z';
    },
    (d: any) => {
      d.items[0].metrics.sessions = NaN;
    },
    (d: any) => {
      d.comparison.baseline.source_fetched_at = '2020-01-01T00:00:00Z';
    },
    (d: any) => {
      d.comparison.baseline.query_context.date_from = '2026-01-01';
    },
  ];
  for (const mutate of mutations) {
    const e = analyticsFixture('ga4_report', args, now);
    mutate(e.data);
    assert.throws(() => verifyToolEvidence('ga4_report', args, e, now));
  }
  const form = analyticsFixture('ga4_report', { report: 'form_performance' }, now);
  (form.data.form_performance as any).components[1].served_at = '2020-01-01T00:00:00Z';
  assert.throws(() => verifyToolEvidence('ga4_report', { report: 'form_performance' }, form, now));
});
test('analytics delivery and recall receipts survive harmless retrieval clock changes', async () => {
  let clock = now;
  const fixture = createSalesFixture(() => clock),
    signal = AbortSignal.timeout(5000),
    key = { remoteJid: FIXTURE_JID };
  const opened = await fixture.service.openTools({ key, runId: 'analytics' }, signal);
  assert.ok(opened.run?.tools.some((t) => t.name === 'ga4_report'));
  assert.equal(
    (
      await opened.run!.execute(
        'ga4_report',
        JSON.stringify({ report: 'overview', period: 'last_7_days' }),
        signal,
      )
    ).ok,
    true,
  );
  const receipt = opened.run!.delivery();
  clock += 5000;
  assert.equal(await fixture.service.canDeliver(key, receipt, signal), true);
  fixture.state.mutate = (e, t) => {
    if (t === 'ga4_report') (e.data.items as any[])[0].metrics.sessions = 999;
  };
  assert.equal(await fixture.service.canDeliver(key, receipt, signal), false);
  fixture.state.active = false;
  assert.equal(await fixture.service.canDeliver(key, receipt, signal), false);
});
