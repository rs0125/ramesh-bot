/** Adversarial execution/presentation contracts use fictional records and no transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import { ContextEngineError } from '../../src/modules/context-engine/context.types.js';
import { dealDisplayIssues, withDealDates } from '../../src/modules/assistant/deal-display.js';
import { chatLayoutIssues } from '../../src/modules/assistant/style.js';
import { planningContext } from '../../src/modules/assistant/planning-context.js';
const trusted = { key: { remoteJid: FIXTURE_JID }, runId: 'adversarial' };
const signal = () => AbortSignal.timeout(5000);
const ga = JSON.stringify({ report: 'overview', period: 'last_7_days' });
const sc = JSON.stringify({ group: 'summary', period: 'last_7_days' });

test('planning reference is derived from live permitted tools and trusted audience', async () => {
  const fixture = createSalesFixture();
  fixture.state.tools = fixture.state.tools.filter(
    (tool) => tool.name === 'get_context' || tool.name === 'search_knowledge',
  );
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  const brief = planningContext(run, 'dm', 'available', true);
  assert.deepEqual(brief.available_source_families, ['context', 'knowledge']);
  assert.deepEqual(brief.available_tools, ['get_context', 'search_knowledge']);
  assert.equal(brief.private_selection_recall_available, true);
  assert.equal(brief.remaining_source_proposals, 24);
  assert.ok(!JSON.stringify(brief).includes('employeeId'));
  for (const denied of [
    planningContext(run, 'group', 'available', true),
    planningContext(undefined, 'dm', 'denied', true),
  ]) {
    assert.deepEqual(denied.available_tools, []);
    assert.deepEqual(denied.available_source_families, []);
    assert.equal(denied.private_selection_recall_available, false);
    assert.equal(denied.remaining_source_proposals, 0);
  }
});

test('cached evidence still requires an active identical employee and a live deadline', async () => {
  const fixture = createSalesFixture();
  fixture.state.allowEvidenceReuse = true;
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  const first = await run.execute('get_context', '{}', signal());
  const second = await run.execute('get_context', '{}', signal());
  assert.equal(second.evidence_id, first.evidence_id);
  assert.equal(second.reused_in_run, true);
  assert.equal(fixture.state.calls.length, 1);
  assert.equal(run.evidence.length, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run.execute('get_context', '{}', controller.signal));
  fixture.state.employeeId++;
  assert.equal((await run.execute('get_context', '{}', signal())).code, 'AUTH_REQUIRED');
  assert.equal(fixture.state.calls.length, 1);
  assert.throws(() => run.delivery(), /ACCESS_DENIED/);
});

test('identical transient reads recover once without altering the requested query', async () => {
  const fixture = createSalesFixture();
  fixture.state.allowEvidenceReuse = true;
  let attempts = 0;
  fixture.state.mutate = (_e, tool) => {
    if (tool === 'ga4_report' && attempts++ === 0)
      throw new ContextEngineError('UNAVAILABLE', true);
  };
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  assert.equal((await run.execute('ga4_report', ga, signal())).retryable, true);
  assert.equal((await run.execute('ga4_report', ga, signal())).ok, true);
  assert.equal((await run.execute('ga4_report', ga, signal())).reused_in_run, true);
  assert.equal(attempts, 2);
  assert.equal(fixture.state.calls.length, 2);
  assert.deepEqual(fixture.state.calls[0]!.args, fixture.state.calls[1]!.args);
  assert.equal(run.evidence.length, 1);
});

test('a persistently failing query stops after two attempts, even if repeatedly proposed', async () => {
  const fixture = createSalesFixture();
  fixture.state.failures.set('ga4_report', new ContextEngineError('UNAVAILABLE', true));
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  for (let i = 0; i < 5; i++) await run.execute('ga4_report', ga, signal());
  assert.equal(fixture.state.calls.length, 2);
  assert.equal(run.remaining, 19);
  assert.equal(run.evidence.length, 0);
  const last = await run.execute('ga4_report', ga, signal());
  assert.equal(last.retryable, false);
  assert.equal(last.suppressed_repeat, true);
});

test('Retry-After applies to changed queries on the same tool, without blocking another source', async () => {
  let now = Date.now();
  const fixture = createSalesFixture(() => now);
  fixture.state.failures.set('ga4_report', new ContextEngineError('RATE_LIMITED', true, 10));
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  await run.execute('ga4_report', ga, signal());
  fixture.state.failures.clear();
  const early = await run.execute('ga4_report', ga, signal());
  assert.equal(early.suppressed_repeat, true);
  assert.equal(early.retry_after_seconds, 10);
  await run.execute('ga4_report', '{"report":"acquisition","period":"last_7_days"}', signal());
  assert.equal(fixture.state.calls.length, 1);
  assert.equal((await run.execute('search_console_report', sc, signal())).ok, true);
  now += 10000;
  assert.equal((await run.execute('ga4_report', ga, signal())).ok, true);
  assert.equal(fixture.state.calls.length, 3);
});

test('configuration failure blocks query variations only for the affected tool', async () => {
  const fixture = createSalesFixture();
  fixture.state.failures.set(
    'ga4_report',
    new ContextEngineError('UNAVAILABLE', false, undefined, {
      sourceCode: 'ANALYTICS_SOURCE_DENIED',
      action: 'check_google_access',
    }),
  );
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  await run.execute('ga4_report', ga, signal());
  const repeated = await run.execute(
    'ga4_report',
    '{"report":"daily","period":"last_7_days"}',
    signal(),
  );
  assert.equal(repeated.suppressed_repeat, true);
  assert.equal(fixture.state.calls.length, 1);
  assert.equal((await run.execute('search_console_report', sc, signal())).ok, true);
  assert.equal(run.blocked, false);
});

test('report-specific unavailability permits a supported report in the same source', async () => {
  const fixture = createSalesFixture();
  fixture.state.mutate = (_e, tool, args) => {
    if (tool === 'ga4_report' && args.report === 'warehouse_interest')
      throw new ContextEngineError('INVALID_ARGUMENTS', false, undefined, {
        sourceCode: 'ANALYTICS_REPORT_UNAVAILABLE',
        action: 'check_capabilities',
      });
  };
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  const unavailable = '{"report":"warehouse_interest","period":"last_7_days"}';
  await run.execute('ga4_report', unavailable, signal());
  assert.equal((await run.execute('ga4_report', unavailable, signal())).suppressed_repeat, true);
  assert.equal((await run.execute('ga4_report', ga, signal())).ok, true);
  assert.equal(fixture.state.calls.length, 2);
});

test('in-run cache cannot extend evidence freshness', async () => {
  let now = Date.now();
  const fixture = createSalesFixture(() => now);
  fixture.state.allowEvidenceReuse = true;
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  const initial = await run.execute('get_context', '{}', signal());
  assert.equal((await run.execute('get_context', '{}', signal())).reused_in_run, true);
  assert.equal(fixture.state.calls.length, 1);
  now += 360001;
  const refreshed = await run.execute('get_context', '{}', signal());
  assert.equal(refreshed.ok, true);
  assert.notEqual(refreshed.evidence_id, initial.evidence_id);
  assert.equal(refreshed.reused_in_run, undefined);
  assert.equal(fixture.state.calls.length, 2);
});

async function dealEvidence() {
  const fixture = createSalesFixture();
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  await run.execute('search_crm_leads', '{"sort":"created_desc","limit":2}', signal());
  return run.evidence;
}

test('inline CRM lists receive per-record native dates, without a shared date bypass', async () => {
  const evidence = await dealEvidence();
  const text =
    '- 3 Oct: Fixture Beacon Retail, RFQ received\n- 2 Oct: Fixture Acme Storage, RFQ received\nCreated: 1 Sep 2026\nLast updated: 29 Sep 2026';
  assert.ok(dealDisplayIssues(text, evidence).some((s) => s.includes('Beacon')));
  const enriched = withDealDates(text, evidence);
  assert.equal((enriched.match(/Created:/g) ?? []).length, 2);
  assert.match(enriched, /Created: 13 Sept 2026/);
  assert.deepEqual(dealDisplayIssues(enriched, evidence), []);
  assert.equal(withDealDates(enriched, evidence), enriched);
});

test('wrong displayed dates are rejected, not silently overwritten', async () => {
  const evidence = await dealEvidence();
  const text = '**Fixture Acme Storage**\nCreated: 1 Sept 2025\nLast updated: 29 Sept 2026';
  assert.equal(withDealDates(text, evidence), text);
  assert.ok(dealDisplayIssues(text, evidence).some((s) => s.includes('Created: 1 Sept 2026')));
  const valid = text.replace('1 Sept 2025', '2026-09-01');
  assert.deepEqual(dealDisplayIssues(valid, evidence), []);
});

test('quoted full RFQ names receive their own dates even when company labels overlap', async () => {
  const evidence = await dealEvidence();
  const rows = evidence[0]!.result.data.items as any[];
  for (const row of rows) row.company_name = 'Fixture Shared Client';
  rows[0].name = '20,000 sft requirement in Fixture North';
  rows[1].name = '50k sqft requirement in Fixture South';
  for (const [open, close] of [
    ['“', '”'],
    ['"', '"'],
    ["'", "'"],
  ]) {
    const reply = `*${open}${rows[0].name}${close}*\nStage: RFQ received\n\n*${open}${rows[1].name}${close}*\nStage: RFQ received`;
    const enriched = withDealDates(reply, evidence);
    assert.equal((enriched.match(/Created:/g) ?? []).length, 2);
    assert.deepEqual(dealDisplayIssues(enriched, evidence), []);
    assert.equal(withDealDates(enriched, evidence), enriched);
    const firstBlock = enriched.split(rows[1].name)[0]!;
    assert.match(firstBlock, /Created: 13 Sept 2026/);
    assert.doesNotMatch(firstBlock, /Created: 1 Sept 2026/);
    assert.ok(dealDisplayIssues(enriched.replace('13 Sept 2026', '14 Sept 2026'), evidence).length);
    const labelled = `*Deal: ${open}${rows[0].name}${close}*\nRecorded requirement\n\n*Deal: ${open}${rows[1].name}${close}*\nRecorded requirement`;
    const labelledDates = withDealDates(labelled, evidence);
    assert.equal((labelledDates.match(/Created:/g) ?? []).length, 2);
    assert.deepEqual(dealDisplayIssues(labelledDates, evidence), []);
  }
  for (const text of [
    '*Fixture Shared Client*',
    `Message draft:\n*“${rows[0].name}”*`,
    `1. Call ${rows[0].name} about the requirement.`,
  ])
    assert.equal(withDealDates(text, evidence), text);
  rows[1].name = rows[0].name;
  const ambiguous = `*“${rows[0].name}”*`;
  assert.equal(withDealDates(ambiguous, evidence), ambiguous);
});

test('inline native dates accept common chat separators without dropping correctness checks', async () => {
  const evidence = await dealEvidence();
  for (const separator of [' • ', ' · ', ' | ', '; ', ', ']) {
    const valid = `1. **Fixture Beacon Retail**\nCreated: **13 Sept 2026**${separator}Last updated: **29 Sept 2026**\n2. **Fixture Acme Storage**\nCreated: **1 Sept 2026**${separator}Last updated: **29 Sept 2026**`;
    assert.deepEqual(dealDisplayIssues(valid, evidence), [], separator);
    assert.equal(withDealDates(valid, evidence), valid);
    assert.equal(
      dealDisplayIssues(valid.replace('13 Sept 2026', '14 Sept 2026'), evidence).length,
      1,
    );
  }
});

test('ordinary action lists and drafts do not become CRM inventory cards', async () => {
  const evidence = await dealEvidence();
  for (const text of [
    '1. Contact Fixture Acme Storage about the next step.',
    'I can draft a message for Fixture Acme Storage.',
    'Message draft:\n- Fixture Acme Storage needs a follow-up.',
    '> Fixture Acme Storage needs a follow-up.',
  ]) {
    assert.equal(withDealDates(text, evidence), text);
    assert.deepEqual(dealDisplayIssues(text, evidence), []);
  }
});

test('a warehouse caveat mentioning the client does not acquire the CRM dates', async () => {
  const evidence = await dealEvidence();
  const reply =
    '*Fixture Acme Storage*\nCreated: 1 Sep 2026\nLast updated: 29 Sep 2026\n\n*Separate warehouse*\n- ID 101\n- Recorded area: 51,000 sq ft.\n- The listing is not verified. Its area is unrelated to Fixture Acme Storage’s requirement.';
  assert.equal(withDealDates(reply, evidence), reply);
  assert.deepEqual(dealDisplayIssues(reply, evidence), []);
  for (const prefix of ['1. ', '- 3 Oct: ', '### 1. ', '- Company: ']) {
    const card = prefix + 'Fixture Acme Storage, Bengaluru';
    assert.match(withDealDates(card, evidence), /Created: 1 Sept 2026/);
  }
});

test('CRM dates accept both bare and parenthesized IST without accepting a wrong day', async () => {
  const evidence = await dealEvidence();
  for (const timezone of [' IST', ' (IST)']) {
    const reply = `1. **Fixture Acme Storage**\nCreated: 1 Sept 2026${timezone}\nLast updated: 29 Sept 2026${timezone}`;
    assert.deepEqual(dealDisplayIssues(reply, evidence), []);
    assert.equal(withDealDates(reply, evidence), reply);
    assert.ok(dealDisplayIssues(reply.replace('1 Sept 2026', '2 Sept 2026'), evidence).length);
  }
});

test('captured lookup dates accept accurate native IST times without masking false times', async () => {
  const evidence = await dealEvidence();
  const reply =
    '*Fixture Acme Storage*\nStage: RFQ Received\nCreated: 1 Sep 2026, 2:00 pm IST\nLast updated: 29 Sep 2026, 7:00 pm IST';
  for (const valid of [
    reply,
    reply
      .replaceAll('Sep', 'Sept')
      .replace('2:00 pm IST', '14:00 (IST)')
      .replace('7:00 pm IST', '19:00:00 (IST)'),
  ]) {
    assert.deepEqual(dealDisplayIssues(valid, evidence), []);
    assert.equal(withDealDates(valid, evidence), valid);
  }
  for (const invalid of [
    reply.replace('2:00 pm', '2:00 am'),
    reply.replace('2:00 pm', '2:01 pm'),
    reply.replace('7:00 pm', '19:00:01'),
    reply.replace('7:00 pm', '19:60'),
    reply.replace('2:00 pm', '14:00 pm'),
    reply.replace('1 Sep', '2 Sep'),
    reply.replace('IST', 'UTC'),
  ])
    assert.ok(dealDisplayIssues(invalid, evidence).length, invalid);
  const row = (evidence[0]!.result.data.items as any[]).find((r) => r.name.includes('Acme'));
  row.source_created_at = null;
  row.last_polled_at = '2026-09-01T08:30:00Z';
  assert.ok(
    dealDisplayIssues(reply, evidence).some((issue) => issue.includes('Created: Not recorded')),
  );
});

test('native IST times respect midnight rollover and noon rather than the host timezone', async () => {
  const evidence = await dealEvidence();
  const row = (evidence[0]!.result.data.items as any[]).find((r) => r.name.includes('Acme'));
  row.source_created_at = '2026-09-01T18:30:42Z';
  row.source_updated_at = '2026-09-29T06:30:00Z';
  const reply =
    '*Fixture Acme Storage*\nCreated: 2 Sep 2026, 12:00 am IST\nLast updated: 29 Sep 2026, 12:00 pm IST';
  assert.deepEqual(dealDisplayIssues(reply, evidence), []);
  assert.deepEqual(dealDisplayIssues(reply.replace('12:00 am', '00:00:42'), evidence), []);
  assert.ok(dealDisplayIssues(reply.replace('12:00 am', '00:00:41'), evidence).length);
  assert.ok(dealDisplayIssues(reply.replace('2 Sep', '1 Sep'), evidence).length);
});

test('duplicate company labels cannot receive dates from a guessed record', async () => {
  const evidence = await dealEvidence();
  const rows = evidence[0]!.result.data.items as any[];
  rows[0].name = rows[1].name;
  const text = '- Fixture Acme Storage, Bengaluru';
  assert.equal(withDealDates(text, evidence), text);
});

test('missing native dates remain absent despite fresh mirror polling', async () => {
  const evidence = await dealEvidence();
  const row = (evidence[0]!.result.data.items as any[]).find((r) => r.name.includes('Acme'));
  row.source_created_at = null;
  row.last_polled_at = new Date().toISOString();
  assert.match(withDealDates('Fixture Acme Storage', evidence), /Created: Not recorded/);
});

test('runtime chat guard includes the same stock phrases used by paid evals', () => {
  assert.ok(chatLayoutIssues('Leverage your morning for this.').length);
  assert.deepEqual(chatLayoutIssues('Start with the client deck, then prepare for tomorrow.'), []);
});

test('native date fields end at sentence boundaries without accepting incorrect or ambiguous dates', async () => {
  const evidence = await dealEvidence();
  for (const month of ['Sept', 'Sept.']) {
    const reply = `### 1. Fixture Acme Storage\nCreated: 1 ${month} 2026. Last updated: 29 ${month} 2026. Dates in IST.`;
    assert.deepEqual(dealDisplayIssues(reply, evidence), []);
    assert.equal(withDealDates(reply, evidence), reply);
    assert.ok(
      dealDisplayIssues(reply.replace(`29 ${month} 2026`, `30 ${month} 2026`), evidence).length,
    );
    assert.ok(
      dealDisplayIssues(
        reply.replace(`29 ${month} 2026`, `29 ${month} 2026 or 30 ${month} 2026`),
        evidence,
      ).length,
    );
  }
});
