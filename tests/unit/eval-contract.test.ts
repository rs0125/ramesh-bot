import test from 'node:test';
import assert from 'node:assert/strict';
import { junit } from '../../evals/lib/report.js';
import { CONVERSATION_CASES } from '../../evals/conversation-cases.js';
import { JOURNEY_CASES } from '../../evals/journey-cases.js';
import { ADVERSARIAL_CASES } from '../../evals/adversarial-cases.js';
import { traceViolations } from '../../evals/lib/trace-checks.js';
import { loadPrompt, promptManifest } from '../../src/modules/assistant/prompt-files.js';
import { createSalesFixture, salesEvidence } from '../../scripts/lib/sales-fixture.js';

test('CI dataset has unique scenarios covering every assistant domain', () => {
  const cases = [...CONVERSATION_CASES, ...JOURNEY_CASES, ...ADVERSARIAL_CASES];
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  assert.ok(cases.length >= 50);
  for (const category of ['assistant', 'crm', 'supply', 'knowledge', 'analytics', 'boundaries'])
    assert.ok(cases.some((c) => c.category === category));
  for (const c of cases) {
    assert.ok(c.turns.length);
    assert.ok(c.expectation.length > 40);
    for (const check of c.toolChecks ?? []) assert.ok(check.turn < c.turns.length);
    for (const check of c.traceChecks ?? []) {
      assert.ok(check.turn < c.turns.length);
      assert.ok(check.min !== undefined || check.max !== undefined);
      if (check.min !== undefined && check.max !== undefined) assert.ok(check.min <= check.max);
    }
  }
});
test('trace gates distinguish proposals, actual attempts and executed recall', () => {
  const turns = [
    {
      calls: [{ tool: 'ga4_report' }, { tool: 'ga4_report' }],
      local_calls: [{ name: 'recall_business_context' }],
      proposed_tools: [{ name: 'ga4_report' }, { name: 'ga4_report' }, { name: 'ga4_report' }],
    },
  ];
  assert.deepEqual(
    traceViolations(
      [
        { turn: 0, name: 'ga4_report', min: 2, max: 2 },
        { turn: 0, name: 'recall_business_context', min: 1 },
      ],
      turns,
    ),
    [],
  );
  assert.equal(
    traceViolations([{ turn: 0, name: 'ga4_report', phase: 'proposed', max: 2 }], turns).length,
    1,
  );
  assert.equal(traceViolations([{ turn: 0, name: 'search_crm_leads', min: 1 }], turns).length, 1);
  assert.equal(traceViolations([{ turn: 1, max: 1 }], turns).length, 1);
});
test('JUnit retains every failure and escapes untrusted judgment text', () => {
  const xml = junit({
    runId: 'test',
    model: 'test',
    promptHash: 'test',
    passed: 0,
    total: 1,
    durationMs: 1000,
    results: [
      {
        case: 'x<&',
        trial: 1,
        passed: false,
        checks: ['wrong "scope"'],
        durationMs: 1000,
        judge: { reason: '</failure><system-out>secret' },
      },
    ],
  });
  assert.ok(xml.includes('failures="1"'));
  assert.ok(xml.includes('&lt;/failure&gt;'));
  assert.ok(!xml.includes('<system-out>'));
});
test('prompt manifest includes formatter/verifier assets and the personal-assistant role', () => {
  assert.ok(loadPrompt('chief-of-staff').includes('personal chief of staff'));
  const manifest = promptManifest();
  for (const name of [
    'converser',
    'chief-of-staff',
    'formatter',
    'business-formatter',
    'verifier',
    'legacy-read-converser',
    'evidence-policy',
    'planning-reference',
  ])
    assert.match(manifest[name]!, /^[a-f0-9]{64}$/);
});

test('fictional CRM paging agrees with totals and queries do not rewrite dates or stages', () => {
  const now = Date.parse('2026-10-02T04:30:00Z');
  const seen = new Map<string, any>();
  let cursor: string | undefined;
  do {
    const data = salesEvidence(
      'search_crm_leads',
      { limit: 2, ...(cursor ? { cursor } : {}) },
      now,
    ).data;
    for (const item of data.items as any[]) {
      assert.ok(!seen.has(item.id));
      seen.set(item.id, item);
    }
    cursor = data.nextCursor as string | undefined;
  } while (cursor);
  const summary = salesEvidence('crm_summary', { group_by: 'stage' }, now).data;
  assert.equal(seen.size, summary.total);
  for (const group of summary.groups as any[])
    assert.equal([...seen.values()].filter((r) => r.stage === group.value).length, group.count);
  const today = salesEvidence('search_crm_leads', { follow_up_status: 'today' }, now).data
    .items as any[];
  const overdue = salesEvidence('search_crm_leads', { follow_up_status: 'overdue' }, now).data
    .items as any[];
  assert.equal(today.length, 1);
  assert.equal(overdue.length, 2);
  assert.ok(!today.some((t) => overdue.some((o) => o.id === t.id)));
  assert.deepEqual(salesEvidence('search_crm_leads', { stage: 'SITE_VISIT' }, now).data.items, []);
  for (const r of [...today, ...overdue]) assert.deepEqual(r, seen.get(r.id));
  const latest = salesEvidence(
    'search_crm_leads',
    { stage: 'RFQ_RECEIVED', sort: 'created_desc', limit: 2 },
    now,
  ).data.items as any[];
  assert.match(latest[0].name, /Beacon/);
  assert.match(latest[1].name, /Acme/);
});
test('fictional warehouse scope, totals and detail fields remain consistent', () => {
  const query = salesEvidence('search_warehouses', { city: 'Bengaluru', limit: 10 }).data;
  const summary = salesEvidence('warehouse_summary', { city: 'Bengaluru' }).data;
  assert.equal((query.items as any[]).length, summary.total);
  for (const row of query.items as any[])
    assert.deepEqual(salesEvidence('read_warehouse', { id: row.id }).data, row);
  assert.deepEqual(salesEvidence('search_warehouses', { city: 'NoSuchCity' }).data.items, []);
  assert.throws(() => salesEvidence('read_warehouse', { id: 999999 }));
});

test('unavailable analytics scenario agrees across discovery and report failure', () => {
  const fixture = createSalesFixture();
  JOURNEY_CASES.find((c) => c.id === 'analytics-unsupported-report')!.setup!(fixture.state);
  const discovery = salesEvidence('analytics_capabilities', {});
  fixture.state.mutate!(discovery, 'analytics_capabilities', {});
  const reports = (discovery.data.ga4 as any).reports;
  assert.equal(reports.find((r: any) => r.name === 'warehouse_interest').available, false);
  assert.equal(reports.find((r: any) => r.name === 'overview').available, true);
  const args = { report: 'warehouse_interest', period: 'last_7_days' };
  assert.throws(() => fixture.state.mutate!(salesEvidence('ga4_report', args), 'ga4_report', args));
});

test('date-query gates accept equivalent follow-up windows without weakening scope or field checks', async () => {
  const { matchesQuery } = await import('../../evals/lib/query-equivalence.js');
  assert.equal(
    matchesQuery(
      'search_crm_leads',
      { view: 'assigned', follow_up_status: 'today' },
      { view: 'assigned', period: 'today', date_field: 'follow_up' },
      '2026-10-02',
    ),
    true,
  );
  assert.equal(
    matchesQuery(
      'search_crm_leads',
      { view: 'assigned', date_field: 'follow_up', date_from: '2026-10-03', date_to: '2026-10-03' },
      { view: 'assigned', period: 'tomorrow', date_field: 'follow_up' },
      '2026-10-02',
    ),
    true,
  );
  assert.equal(
    matchesQuery(
      'search_crm_leads',
      { view: 'accessible', follow_up_status: 'today' },
      { view: 'assigned', period: 'today', date_field: 'follow_up' },
      '2026-10-02',
    ),
    false,
  );
  assert.equal(
    matchesQuery(
      'search_crm_leads',
      { view: 'assigned', date_field: 'created', date_from: '2026-10-02', date_to: '2026-10-02' },
      { view: 'assigned', period: 'today', date_field: 'follow_up' },
      '2026-10-02',
    ),
    false,
  );
  assert.equal(
    matchesQuery(
      'ga4_report',
      { report: 'landing_pages', date_from: '2026-09-01', date_to: '2026-09-30' },
      { report: 'landing_pages', period: 'last_month' },
      '2026-10-02',
    ),
    true,
  );
});

test('date gates reject a literal period with the wrong CRM field and accept both equivalent spellings', async () => {
  const { matchesQuery } = await import('../../evals/lib/query-equivalence.js');
  for (const actual of [
    { period: 'today' },
    { date_field: 'created', period: 'today' },
    { date_field: 'updated', period: 'today' },
  ])
    assert.equal(
      matchesQuery(
        'search_crm_leads',
        actual,
        { date_field: 'follow_up', period: 'today' },
        '2026-10-02',
      ),
      false,
    );
  assert.equal(
    matchesQuery(
      'search_crm_leads',
      { period: 'today', date_field: 'created' },
      { date_field: 'created', period: 'today' },
      '2026-10-02',
    ),
    true,
  );
  assert.equal(
    matchesQuery(
      'search_crm_leads',
      { follow_up_status: 'today' },
      { date_field: 'follow_up', date_from: '2026-10-02', date_to: '2026-10-02' },
      '2026-10-02',
    ),
    true,
  );
  assert.equal(
    matchesQuery(
      'search_crm_leads',
      { period: 'today', date_from: '2026-10-02', date_to: '2026-10-02' },
      { period: 'today' },
      '2026-10-02',
    ),
    false,
  );
  assert.equal(
    matchesQuery(
      'ga4_report',
      { report: 'overview', date_from: '2026-09-25', date_to: '2026-10-01' },
      { report: 'overview', period: 'last_7_days' },
      '2026-10-02',
    ),
    true,
  );
  assert.equal(
    matchesQuery(
      'search_crm_leads',
      { date_field: 'follow_up', date_from: '2026-09-25', date_to: '2026-10-01' },
      { date_field: 'follow_up', period: 'last_7_days' },
      '2026-10-02',
    ),
    false,
  );
  assert.equal(
    matchesQuery(
      'ga4_report',
      { date_from: '2026-10-01', date_to: '2026-10-31' },
      { period: 'this_month' },
      '2026-10-02',
    ),
    false,
  );
});
test('source calendar query gates remain correct across the India/Los Angeles midnight boundary', async () => {
  const { sourceDate } = await import('../../src/modules/assistant/analytics-evidence.js');
  const { matchesQuery } = await import('../../evals/lib/query-equivalence.js');
  const clock = Date.parse('2026-10-01T19:00:00Z');
  const gscDay = sourceDate('America/Los_Angeles', clock);
  assert.equal(gscDay, '2026-10-01');
  assert.equal(sourceDate('Asia/Kolkata', clock), '2026-10-02');
  assert.equal(
    matchesQuery(
      'search_console_report',
      { date_from: '2026-09-24', date_to: '2026-09-30' },
      { period: 'last_7_days' },
      gscDay,
    ),
    true,
  );
  assert.equal(
    matchesQuery(
      'search_console_report',
      { date_from: '2026-09-25', date_to: '2026-10-01' },
      { period: 'last_7_days' },
      gscDay,
    ),
    false,
  );
});
test('missing-date scenario also removes native dates from successful detail reads', () => {
  const fixture = createSalesFixture();
  ADVERSARIAL_CASES.find((c) => c.id === 'adversarial-polling-is-not-created')!.setup!(
    fixture.state,
  );
  for (const tool of ['search_crm_leads', 'read_crm_lead'] as const) {
    const args = tool === 'search_crm_leads' ? {} : { id: '00000000-0000-4000-8000-000000000101' };
    const result = salesEvidence(tool, args);
    fixture.state.mutate!(result, tool, args);
    for (const row of (tool === 'search_crm_leads' ? result.data.items : [result.data]) as any[]) {
      assert.equal(row.source_created_at, null);
      assert.equal(row.source_updated_at, null);
      assert.ok(row.mirror_updated_at);
    }
  }
});
test('per-turn grader rejects missing, duplicated, contradictory and unexplained verdicts', async () => {
  const { parseVerdict, evidenceClocks } = await import('../../evals/lib/judge.js');
  const good = {
    turn: 1,
    continuity: true,
    grounded: true,
    formatting: true,
    usefulness: true,
    findings: [],
  };
  const bad = {
    ...good,
    usefulness: false,
    findings: [
      {
        criterion: 'usefulness',
        claim: 'Ignored requested result',
        evidence: 'Successful source read was available',
      },
    ],
  };
  const parsed = parseVerdict(JSON.stringify({ turns: [bad, { ...good, turn: 2 }] }), 2);
  assert.equal(parsed.usefulness, false);
  assert.equal(parsed.turns[1]!.usefulness, true);
  for (const turns of [
    [good],
    [good, good],
    [
      { ...good, usefulness: false },
      { ...good, turn: 2 },
    ],
    [
      { ...good, findings: bad.findings },
      { ...good, turn: 2 },
    ],
  ])
    assert.throws(() => parseVerdict(JSON.stringify({ turns }), 2));
  const clocks = evidenceClocks({ generatedAt: '2026-10-02T09:20:00Z' });
  assert.match(clocks[0]!.ist, /14:50:00/);
  assert.match(clocks[0]!.utc, /09:20:00/);
});

test('query-to-page analytics preserve per-query totals instead of copying unrelated aggregate rows', () => {
  const queries = salesEvidence('search_console_report', { group: 'query', period: 'last_28_days' })
    .data.items as any[];
  for (const query of queries) {
    const pages = salesEvidence('search_console_report', {
      group: 'query_page',
      period: 'last_28_days',
      query_equals: query.dimensions.query,
    }).data.items as any[];
    assert.ok(pages.every((p) => p.dimensions.query === query.dimensions.query));
    assert.equal(
      pages.reduce((n, p) => n + p.metrics.clicks, 0),
      query.metrics.clicks,
    );
    assert.equal(
      pages.reduce((n, p) => n + p.metrics.impressions, 0),
      query.metrics.impressions,
    );
  }
});

test('case-insensitive filters accept equivalent literals while exact query/path filters remain strict', async () => {
  const { matchesQuery } = await import('../../evals/lib/query-equivalence.js');
  const clock = '2026-10-02';
  assert.equal(
    matchesQuery(
      'search_console_report',
      { query_not_contains: 'wareongo' },
      { query_not_contains: 'WareOnGo' },
      clock,
    ),
    true,
  );
  assert.equal(
    matchesQuery(
      'search_console_report',
      { query_not_contains: 'different' },
      { query_not_contains: 'WareOnGo' },
      clock,
    ),
    false,
  );
  assert.equal(
    matchesQuery(
      'search_console_report',
      { query_equals: 'warehouse' },
      { query_equals: 'Warehouse' },
      clock,
    ),
    false,
  );
  assert.equal(
    matchesQuery(
      'search_console_report',
      { page_equals: 'https://example.test/X' },
      { page_equals: 'https://example.test/x' },
      clock,
    ),
    false,
  );
});
test('outcome tool alternatives allow equivalent routes while all-call scope gates still reject widening', async () => {
  const { satisfiesToolCheck } = await import('../../evals/lib/tool-contracts.js');
  const clock = '2026-10-02T09:00:00Z';
  assert.equal(
    satisfiesToolCheck(
      { turn: 0, name: 'crm_briefing', alternatives: ['search_crm_leads'] },
      [{ tool: 'search_crm_leads', args: { view: 'assigned' } }],
      clock,
    ),
    true,
  );
  const scoped = {
    turn: 0,
    name: 'search_crm_leads' as const,
    args: { view: 'assigned' },
    every: true,
  };
  assert.equal(
    satisfiesToolCheck(
      scoped,
      [
        { tool: 'search_crm_leads', args: { view: 'assigned' } },
        { tool: 'search_crm_leads', args: { view: 'accessible' } },
      ],
      clock,
    ),
    false,
  );
  assert.equal(satisfiesToolCheck(scoped, [], clock), false);
  assert.equal(
    satisfiesToolCheck(
      { turn: 0, name: 'search_console_report', anyArgs: [{ query_not_contains: 'WareOnGo' }] },
      [{ tool: 'search_console_report', args: { query_not_contains: 'wareongo' } }],
      clock,
    ),
    true,
  );
});

test('regrading preserves hard checks and refuses incomplete or private reports', async () => {
  const { retainedHardChecks, assertCompletePublicRun } = await import(
    '../../evals/lib/regrade.js'
  );
  assert.deepEqual(
    retainedHardChecks([
      'turn1:judge:grounded',
      'private_history_leak',
      'turn2:tool_contract:crm_summary',
      'trial_error',
    ]),
    ['private_history_leak', 'turn2:tool_contract:crm_summary', 'trial_error'],
  );
  const complete = {
    inputIntegrity: true,
    syntheticClock: '2026-10-02',
    scenarios: ['case-a'],
    trials: 1,
    total: 1,
    results: [{ case: 'case-a', trial: 1, checks: [], turns: [] }],
  };
  assert.doesNotThrow(() => assertCompletePublicRun(complete));
  assert.throws(() => assertCompletePublicRun({ ...complete, inputIntegrity: false }));
  assert.throws(() => assertCompletePublicRun({ ...complete, total: 2 }));
  assert.throws(() =>
    assertCompletePublicRun({
      ...complete,
      scenarios: ['private-01'],
      results: [{ ...complete.results[0], case: 'private-01' }],
    }),
  );
  assert.throws(() =>
    assertCompletePublicRun({
      ...complete,
      trials: 2,
      total: 2,
      results: [complete.results[0], complete.results[0]],
    }),
  );
});

test('causal judging hides every future turn and preserves an earlier failure', async () => {
  const { turnJudgeInput, judgeTurns } = await import('../../evals/lib/turn-judge.js');
  const turns = [
    { text: 'First request', reply: 'Unhelpful response', evidence: [] },
    {
      text: 'FUTURE_REQUEST_SENTINEL',
      reply: 'Later good response',
      evidence: [{ fact: 'FUTURE_EVIDENCE_SENTINEL' }],
    },
  ];
  const first = JSON.stringify(turnJudgeInput('FUTURE_EXPECTATION_SENTINEL', turns, 0));
  assert.ok(!first.includes('FUTURE_REQUEST_SENTINEL'));
  assert.ok(!first.includes('FUTURE_EVIDENCE_SENTINEL'));
  assert.ok(!first.includes('FUTURE_EXPECTATION_SENTINEL'));
  const explicit = ['First request only', 'FUTURE_EXPECTATION_SENTINEL'];
  assert.ok(!JSON.stringify(turnJudgeInput(explicit, turns, 0)).includes(explicit[1]!));
  assert.equal(turnJudgeInput(explicit, turns, 1).current_turn_expectation, explicit[1]);
  assert.throws(() => turnJudgeInput(['Missing second expectation'], turns, 0));
  assert.equal(
    turnJudgeInput('EXPECTED_LABEL_SENTINEL', [turns[0]!], 0).current_turn_expectation,
    undefined,
  );
  assert.deepEqual(turnJudgeInput('Two-step task.', turns, 1).preceding_conversation, [
    { user: 'First request', assistant: 'Unhelpful response' },
  ]);
  let calls = 0,
    usage = 0;
  const verdict = await judgeTurns(
    {
      complete: async (request) => {
        const payload = JSON.parse(request.messages[0]!.content);
        assert.equal(payload.turns.length, 1);
        const useful = calls++ > 0;
        return {
          text: JSON.stringify({
            turns: [
              {
                turn: 1,
                continuity: true,
                grounded: true,
                formatting: true,
                usefulness: useful,
                findings: useful
                  ? []
                  : [
                      {
                        criterion: 'usefulness',
                        claim: 'Did not answer',
                        evidence: 'First request is unanswered',
                      },
                    ],
              },
            ],
          }),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    },
    'Judge the current answer.',
    'Two-step task.',
    turns,
    AbortSignal.timeout(1000),
    () => usage++,
  );
  assert.equal(calls, 2);
  assert.equal(usage, 2);
  assert.equal(verdict.usefulness, false);
  assert.deepEqual(
    verdict.turns.map((t) => [t.turn, t.usefulness]),
    [
      [1, false],
      [2, true],
    ],
  );
});
