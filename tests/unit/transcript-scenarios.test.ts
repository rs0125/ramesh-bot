/** Preflight the transcript fixtures through actual write/read orchestration, without paid models. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTranscriptFixture,
  TRANSCRIPT_NOTE_ID,
} from '../../scripts/lib/transcript-fixture.js';
import { FIXTURE_LEAD_ID } from '../../scripts/lib/sales-fixture.js';
import {
  VISAKHAPATNAM_RFQ,
  COIMBATORE_RFQ,
  TRANSCRIPT_CASES,
} from '../../evals/transcript-cases.js';
import { transcriptChecks, validateTranscriptCatalogue } from '../../evals/lib/transcript-trial.js';
const signal = () => AbortSignal.timeout(5000);
const base = {
  company_name: 'Fixture Meridian Logistics',
  location: 'Visakhapatnam',
  requirement: '25,000 sft',
  micro_market: 'Anywhere',
  budget: 'market rate',
  lease_duration: { value: 'LONG_TERM', quote: 'Long term' },
};

test('every transcript catalogue constructs both eager and deferred provider tools before spending', async () => {
  for (const mode of ['rfq', 'notes', 'recall'] as const) {
    const eager = await validateTranscriptCatalogue(mode, 'eager');
    const deferred = await validateTranscriptCatalogue(mode, 'deferred');
    assert.ok(eager.length);
    assert.ok(deferred.length);
    if (mode !== 'recall') assert.ok(deferred.some((t) => t.type === 'namespace'));
  }
});

test('each transcript fixture admits its CRM search, detail and related-note responses', async () => {
  for (const mode of ['rfq', 'notes', 'recall'] as const) {
    const fixture = createTranscriptFixture(mode, () => Date.parse('2026-10-06T09:00:00Z'));
    const reads = (await fixture.reads.openTools(fixture.trusted('Read the fixture'), signal()))
      .run!;
    for (const [name, args] of [
      ['search_crm_leads', { q: 'Fixture Acme' }],
      ['read_crm_lead', { id: FIXTURE_LEAD_ID }],
      ['read_crm_lead_context', { id: FIXTURE_LEAD_ID, section: 'notes' }],
    ] as const) {
      const result = await reads.execute(name, JSON.stringify(args), signal());
      assert.equal(result.ok, true, `${mode}:${name}`);
    }
    assert.equal(reads.failures.length, 0);
  }
});

test('add this uses exact earlier source; a separate RFQ keeps its own absent fields and uncertain recovery never creates twice', async () => {
  let now = Date.parse('2026-10-06T09:00:00Z');
  const fixture = createTranscriptFixture('rfq', () => now);
  const source = fixture.trusted(VISAKHAPATNAM_RFQ);
  now += 60000;
  const trusted = fixture.trusted('add this to crm as a separate rfq');
  const run = (await fixture.writes.open(trusted, signal()))!;
  assert.ok(run);
  const sources = await run.execute('write_sources', '{}', signal());
  assert.match(JSON.stringify(sources), /Visakhapatnam/);
  await run.execute(
    'create_crm_rfq',
    JSON.stringify({ ...base, _source_message_ids: [source.commandMessages![0]!.id] }),
    signal(),
  );
  assert.equal(fixture.state.rfqs.length, 0, 'staging cannot dispatch');
  const receipt = await run.finalize(signal());
  assert.equal(fixture.state.rfqs.length, 1);
  assert.equal(fixture.state.rfqs[0]!.args.raw_text, VISAKHAPATNAM_RFQ);
  assert.match(receipt!.text, /Visakhapatnam/);
  now += 60000;
  fixture.state.uncertainNextCreate = true;
  const secondTrusted = fixture.trusted(COIMBATORE_RFQ);
  const second = (await fixture.writes.open(secondTrusted, signal()))!;
  await second.execute(
    'create_crm_rfq',
    JSON.stringify({
      company_name: base.company_name,
      location: 'Coimbatore',
      requirement: '30,000 sft',
      micro_market: 'Anywhere',
    }),
    signal(),
  );
  await second.finalize(signal());
  assert.equal(fixture.state.rfqs.length, 2);
  const saved = fixture.state.rfqs[1]!;
  assert.equal(saved.args.raw_text, COIMBATORE_RFQ);
  assert.equal(saved.args.budget, undefined);
  assert.equal(saved.args.lease_duration, undefined);
  assert.ok(saved.uncertain);
  const attemptsBeforeRetry = fixture.state.writes.length;
  await fixture.writes.recover(fixture.trusted('retry'), signal());
  assert.equal(fixture.state.rfqs.length, 2);
  assert.equal(fixture.state.writes.length, attemptsBeforeRetry + 1);
  assert.equal(fixture.state.writes.at(-1)!.result.operation_id, saved.operation_id);
  assert.equal(fixture.state.writes.at(-1)!.result.outcome, 'outcome_unknown');
  const calls = fixture.state.writes.length;
  fixture.trusted('An unrelated question');
  assert.equal(await fixture.writes.recover(fixture.trusted('retry'), signal()), undefined);
  assert.equal(fixture.state.writes.length, calls, 'unrelated retry cannot select the older write');
});

test('Both edits the existing note; a single versioned undo restores exact text and leaves the note attached', async () => {
  let now = Date.parse('2026-10-06T09:00:00Z');
  const fixture = createTranscriptFixture('notes', () => now);
  const trusted = fixture.trusted('Both');
  const reads = (await fixture.reads.openTools(trusted, signal())).run!;
  await reads.execute(
    'list_crm_note_changes',
    JSON.stringify({ deal_id: FIXTURE_LEAD_ID }),
    signal(),
  );
  await reads.execute(
    'read_crm_note',
    JSON.stringify({ deal_id: FIXTURE_LEAD_ID, note_id: TRANSCRIPT_NOTE_ID }),
    signal(),
  );
  assert.equal(reads.failures.length, 0);
  const run = (await fixture.writes.open(trusted, signal()))!;
  await run.execute(
    'update_crm_note',
    JSON.stringify({
      deal_id: FIXTURE_LEAD_ID,
      note_id: TRANSCRIPT_NOTE_ID,
      expected_updated_at: fixture.state.notes.get(TRANSCRIPT_NOTE_ID)!.updated_at,
      title: 'Fire advisory',
      body: 'Fire advisory',
    }),
    signal(),
  );
  await run.finalize(signal());
  assert.equal(fixture.state.writes[0]!.result.outcome, 'updated');
  const note = fixture.state.notes.get(TRANSCRIPT_NOTE_ID)!;
  assert.equal(note.title, 'Fire advisory');
  assert.equal(note.body, 'Fire advisory');
  now += 60000;
  const undoTrusted = fixture.trusted('Undo the edit first.');
  const undoRead = (await fixture.reads.openTools(undoTrusted, signal())).run!;
  await undoRead.execute(
    'list_crm_note_changes',
    JSON.stringify({ deal_id: FIXTURE_LEAD_ID }),
    signal(),
  );
  assert.equal(undoRead.failures.length, 0);
  const undo = (await fixture.writes.open(undoTrusted, signal()))!;
  await undo.execute(
    'undo_crm_note',
    JSON.stringify({ deal_id: FIXTURE_LEAD_ID, original_operation_id: note.operation }),
    signal(),
  );
  const receipt = await undo.finalize(signal());
  const restored = fixture.state.notes.get(TRANSCRIPT_NOTE_ID)!;
  assert.equal(restored.title, 'Fire NOC requirement');
  assert.equal(restored.body, 'They want fire NOC.');
  assert.ok(restored.attached);
  assert.match(receipt!.text, /Fire NOC requirement/);
  assert.match(receipt!.text, /They want fire NOC\./);
  const fresh = (await fixture.reads.openTools(fixture.trusted('Read the note'), signal())).run!;
  await fresh.execute(
    'read_crm_note',
    JSON.stringify({ deal_id: FIXTURE_LEAD_ID, note_id: TRANSCRIPT_NOTE_ID }),
    signal(),
  );
  assert.equal(fresh.failures.length, 0);
  assert.equal(fixture.state.reads.at(-1)!.result.data.undo_available, false);
});

test('a stale note version cannot overwrite current text; forwarding and revoked access grant no write', async () => {
  const fixture = createTranscriptFixture('notes', () => Date.parse('2026-10-06T09:00:00Z'));
  const run = (await fixture.writes.open(fixture.trusted('Change both fields'), signal()))!;
  await run.execute(
    'update_crm_note',
    JSON.stringify({
      deal_id: FIXTURE_LEAD_ID,
      note_id: TRANSCRIPT_NOTE_ID,
      expected_updated_at: '2026-10-03T08:00:00.000Z',
      title: 'Fire advisory',
      body: 'Fire advisory',
    }),
    signal(),
  );
  await run.finalize(signal());
  assert.equal(fixture.state.writes[0]!.result.code, 'CRM_NOTE_CHANGED');
  assert.equal(fixture.state.notes.get(TRANSCRIPT_NOTE_ID)!.title, 'Fire NOC requirement');
  assert.equal(
    await fixture.writes.open(fixture.trusted('Change both fields', true), signal()),
    undefined,
  );
  fixture.state.active = false;
  const trusted = fixture.trusted('Show the previous note');
  assert.equal(await fixture.writes.open(trusted, signal()), undefined);
  assert.equal((await fixture.reads.openTools(trusted, signal())).status, 'denied');
});

test('scenario oracles fail missing real effects, copied fields and private redisclosure', () => {
  const fixture = createTranscriptFixture('rfq', Date.now);
  const turn = {
    reply: 'Saved.',
    calls: [],
    local_calls: [],
    protected: false,
    trace: { outcome: 'completed' },
  };
  assert.ok(
    transcriptChecks(TRANSCRIPT_CASES[0]!, 1, fixture, turn).includes('turn2:rfq_effect_count'),
  );
  fixture.state.rfqs.push({
    id: 'synthetic-first',
    args: { ...base, raw_text: VISAKHAPATNAM_RFQ },
    updated_at: new Date().toISOString(),
    operation_id: 'first-operation',
    uncertain: false,
  });
  assert.ok(
    transcriptChecks(TRANSCRIPT_CASES[0]!, 1, fixture, {
      ...turn,
      reply:
        'The creation is pending independent review; it has not been created yet.\nSaved RFQ: Fixture Meridian Logistics',
    }).includes('turn2:no_stale_precommit_status'),
  );
  fixture.state.rfqs.push({
    id: 'synthetic-second',
    args: { ...base, location: 'Coimbatore', requirement: '30,000 sft', raw_text: COIMBATORE_RFQ },
    updated_at: new Date().toISOString(),
    operation_id: 'second-operation',
    uncertain: true,
  });
  assert.ok(
    transcriptChecks(TRANSCRIPT_CASES[0]!, 2, fixture, turn).includes('turn3:no_field_carryover'),
  );
  const recall = createTranscriptFixture('recall', Date.now);
  assert.ok(
    transcriptChecks(TRANSCRIPT_CASES[2]!, 2, recall, {
      ...turn,
      reply: 'Acme needs 25,000 sq ft',
    }).includes('turn3:no_private_history_leak'),
  );
});
