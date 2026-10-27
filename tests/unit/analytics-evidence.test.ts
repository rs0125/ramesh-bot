import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsFixture } from '../../scripts/lib/analytics-fixture.js';
import {
  verifyToolEvidence,
  toolEvidenceFingerprint,
} from '../../src/modules/assistant/tool-evidence.js';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';

const now = Date.parse('2026-10-02T01:00:00Z');
test('fictional Search Console comparison CTR agrees with clicks and impressions in each period', () => {
  const data = analyticsFixture(
    'search_console_report',
    { group: 'summary', period: 'last_7_days', compare_to: 'previous_period' },
    now,
  ).data as any;
  const metrics = new Map<string, any>(
    data.comparison.metrics.map((metric: any) => [metric.name, metric]),
  );
  for (const period of ['current', 'previous'])
    assert.ok(
      Math.abs(
        metrics.get('ctr')[period] -
          metrics.get('clicks')[period] / metrics.get('impressions')[period],
      ) < 1e-12,
    );
  assert.equal(metrics.get('ctr').percentage_point_change, 0);
});
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
test('Ads capability refreshes preserve account identity and availability in the fingerprint', () => {
  const first = analyticsFixture('analytics_capabilities', {}, now);
  first.data.google_ads = {
    status: 'available',
    account: { id: '1234567890', currency: 'INR' },
    source_fetched_at: new Date(now).toISOString(),
  };
  const refreshed = structuredClone(first);
  (refreshed.data.google_ads as any).source_fetched_at = new Date(now + 5000).toISOString();
  assert.equal(toolEvidenceFingerprint(first), toolEvidenceFingerprint(refreshed));
  (refreshed.data.google_ads as any).status = 'unavailable';
  assert.notEqual(toolEvidenceFingerprint(first), toolEvidenceFingerprint(refreshed));
  const otherSourceChanged = structuredClone(first);
  (otherSourceChanged.data.ga4 as any).status = 'unavailable';
  (otherSourceChanged.data.ga4 as any).error_code = 'ANALYTICS_SOURCE_TIMEOUT';
  assert.notEqual(toolEvidenceFingerprint(first), toolEvidenceFingerprint(otherSourceChanged));
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

test('scoped capability receipts ignore unrelated source health and retain selected-source changes', async () => {
  const fixture = createSalesFixture(() => now),
    signal = AbortSignal.timeout(5000),
    key = { remoteJid: FIXTURE_JID };
  const opened = await fixture.service.openTools({ key, runId: 'scoped-ads' }, signal);
  assert(opened.run);
  assert.equal(
    (
      await opened.run.execute(
        'analytics_capabilities',
        JSON.stringify({ source: 'google_ads' }),
        signal,
      )
    ).ok,
    true,
  );
  const receipt = opened.run.delivery();
  assert.equal(await fixture.service.canDeliver(key, receipt, signal), true);
  fixture.state.mutate = (evidence, tool, args) => {
    if (tool === 'analytics_capabilities' && args.source === 'ga4') {
      (evidence.data.ga4 as any).status = 'unavailable';
      (evidence.data.ga4 as any).error_code = 'ANALYTICS_SOURCE_TIMEOUT';
    }
  };
  assert.equal(await fixture.service.canDeliver(key, receipt, signal), true);
  fixture.state.mutate = (evidence, tool) => {
    if (tool === 'analytics_capabilities') (evidence.data.google_ads as any).status = 'unavailable';
  };
  let failure: unknown;
  assert.equal(
    await fixture.service.canDeliver(key, receipt, signal, (reason, tool) => {
      failure = { reason, tool };
    }),
    false,
  );
  assert.deepEqual(failure, { reason: 'SOURCE_CHANGED', tool: 'analytics_capabilities' });
  fixture.state.mutate = undefined;
  fixture.state.active = false;
  assert.equal(await fixture.service.canDeliver(key, receipt, signal), false);
});
test('scoped capabilities bind the selected source and reject mixed-source payloads', () => {
  for (const source of ['ga4', 'search_console', 'google_ads']) {
    const args = { source },
      evidence = analyticsFixture('analytics_capabilities', args, now);
    assert.doesNotThrow(() => verifyToolEvidence('analytics_capabilities', args, evidence, now));
    const changed = structuredClone(evidence);
    changed.data.requested_source = source === 'ga4' ? 'google_ads' : 'ga4';
    assert.throws(() => verifyToolEvidence('analytics_capabilities', args, changed, now));
    const mixed = structuredClone(evidence);
    mixed.data[source === 'ga4' ? 'google_ads' : 'ga4'] = { status: 'available', reports: [] };
    assert.throws(() => verifyToolEvidence('analytics_capabilities', args, mixed, now));
    const refreshed = analyticsFixture('analytics_capabilities', args, now + 5000);
    assert.equal(toolEvidenceFingerprint(evidence), toolEvidenceFingerprint(refreshed));
    (refreshed.data[source] as any).status = 'unavailable';
    assert.notEqual(toolEvidenceFingerprint(evidence), toolEvidenceFingerprint(refreshed));
  }
});
