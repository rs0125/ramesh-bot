/** Model-free contract for the fixed smoke suite: no model, network, database or paid call. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  SMOKE_CASES,
  isDelegatedSmokeCase,
  type SmokeConversationCase,
  type SmokePersonalCase,
  type SmokeRfqCase,
} from '../../evals/smoke-cases.js';
import { CONVERSATION_CASES } from '../../evals/conversation-cases.js';
import { JOURNEY_CASES } from '../../evals/journey-cases.js';
import { ADVERSARIAL_CASES } from '../../evals/adversarial-cases.js';
import { PAGINATION_CASES } from '../../evals/pagination-cases.js';
import { RECOVERY_CASES } from '../../evals/recovery-cases.js';
import { LATENCY_CASES } from '../../evals/latency-cases.js';
import { TRANSCRIPT_CASES } from '../../evals/transcript-cases.js';
import { validateTranscriptCatalogue } from '../../evals/lib/transcript-trial.js';
import {
  FALLBACK_REPLIES,
  FALLBACK_REPLY,
  personalSmokeChecks,
  rfqSmokeChecks,
} from '../../evals/lib/smoke-checks.js';
import { truthfulConditionalLimitation } from '../../evals/lib/scheduling-outcomes.js';
import { assertEvalRun, DEFAULT_EVAL_MODEL } from '../../evals/lib/run-policy.js';
import { createSalesFixture, salesEvidence } from '../../scripts/lib/sales-fixture.js';
import { createTranscriptFixture } from '../../scripts/lib/transcript-fixture.js';
import { indiaDate } from '../../src/modules/assistant/followups.js';

const EXPECTED_IDS = [
  'smoke-01-greeting',
  'smoke-02-crm-followups-today',
  'smoke-03-warehouse-locality',
  'smoke-04-compare-no-preference',
  'smoke-05-rfq-explicit-full-brief',
  'smoke-06-rfq-hinglish-incomplete',
  'smoke-07-rfq-save-offer-yes',
  'smoke-08-rfq-bounded-foreign-retry',
  'smoke-09-reminder-letter-case',
  'smoke-10-tasks-and-followups',
  'smoke-11-iso-date-answer',
  'smoke-12-conditional-reminder',
];
const conversationCases = SMOKE_CASES.filter(
  (c): c is SmokeConversationCase => c.runner === 'conversation',
);
const rfqCases = SMOKE_CASES.filter((c): c is SmokeRfqCase => c.runner === 'transcript');
const personalCases = SMOKE_CASES.filter((c): c is SmokePersonalCase => c.runner === 'scheduling');
const byId = <T extends { id: string }>(cases: readonly T[], id: string) =>
  cases.find((c) => c.id === id)!;

test('the smoke suite is exactly twelve unique IDs in a fixed order', () => {
  const ids = SMOKE_CASES.map((c) => c.id);
  assert.deepEqual(ids, EXPECTED_IDS);
  assert.equal(new Set(ids).size, 12);
  const others = new Set(
    [
      ...CONVERSATION_CASES,
      ...JOURNEY_CASES,
      ...ADVERSARIAL_CASES,
      ...PAGINATION_CASES,
      ...RECOVERY_CASES,
      ...LATENCY_CASES,
      ...TRANSCRIPT_CASES,
    ].map((c) => c.id),
  );
  for (const id of ids) assert.ok(!others.has(id), id);
});

test('one smoke run is twelve trials and needs the explicit --max-trials 12 allowance', () => {
  const models = [DEFAULT_EVAL_MODEL, DEFAULT_EVAL_MODEL];
  assert.throws(() => assertEvalRun(models, SMOKE_CASES.length, {}), /ALLOWANCE_EXCEEDED/);
  assert.equal(assertEvalRun(models, SMOKE_CASES.length, { 'max-trials': '12' }).plannedTrials, 12);
  // Cost basis documented in evals/README.md: 14 user turns, one judge call per turn.
  assert.equal(
    SMOKE_CASES.reduce((total, c) => total + c.turns.length, 0),
    14,
  );
  assert.deepEqual([conversationCases.length, rfqCases.length, personalCases.length], [5, 4, 3]);
});

test('conversation smoke cases satisfy the conversation runner contract', () => {
  for (const c of conversationCases) {
    assert.equal(isDelegatedSmokeCase(c), false, c.id);
    // Generic cases skip the legacy deal-card gates applied to the first turn.
    assert.equal(c.generic, true, c.id);
    assert.ok(c.turns.length, c.id);
    assert.ok(c.expectation.length > 40, c.id);
    assert.equal(c.expectations.length, c.turns.length, c.id);
    for (const rubric of c.expectations) assert.ok(rubric.length > 40, c.id);
    for (const check of c.toolChecks ?? []) assert.ok(check.turn < c.turns.length, c.id);
    for (const check of c.traceChecks ?? []) {
      assert.ok(check.turn < c.turns.length, c.id);
      assert.ok(check.min !== undefined || check.max !== undefined, c.id);
    }
    for (const pattern of [...(c.contains ?? []), ...(c.excludes ?? [])])
      assert.ok(!pattern.global && !pattern.sticky, `${c.id}: stateful pattern`);
    const fixture = createSalesFixture();
    c.setup?.(fixture.state);
  }
});

test('conversation smoke premises hold in the synthetic sales fixture', () => {
  // The conversation runner's synthetic clock.
  const now = Date.parse('2026-10-02T09:00:00Z');
  const followups = byId(conversationCases, 'smoke-02-crm-followups-today');
  const today = salesEvidence(
    'search_crm_leads',
    { view: 'assigned', period: 'today', date_field: 'follow_up' },
    now,
  ).data.items as Array<{ name: string }>;
  assert.deepEqual(
    today.map((row) => row.name),
    ['Fixture Acme Storage'],
  );
  const tomorrow = salesEvidence(
    'search_crm_leads',
    { period: 'tomorrow', date_field: 'follow_up' },
    now,
  ).data.items as Array<{ name: string }>;
  assert.ok(tomorrow.some((row) => /Beacon/.test(row.name)));
  assert.ok(followups.contains!.every((p) => p.test('Fixture Acme Storage, 10:00 IST')));
  assert.ok(followups.excludes!.some((p) => p.test('Fixture Beacon Retail')));

  const chakan = salesEvidence('search_warehouses', { micromarket: 'Chakan', limit: 20 }, now).data
    .items as Array<{ id: number }>;
  assert.deepEqual(
    chakan.map((row) => row.id),
    [106, 107, 108, 109],
  );
  const locality = byId(conversationCases, 'smoke-03-warehouse-locality');
  for (const row of chakan) assert.ok(locality.contains!.every((p) => p.test(`ID ${row.id}`)));
  assert.ok(!locality.contains!.every((p) => p.test('ID 101')));

  // The "no preference" trap: 108 is larger on every recorded number; price and NOC are unknown.
  const [w106, w108] = [106, 108].map(
    (id) => salesEvidence('read_warehouse', { id }, now).data as Record<string, any>,
  );
  assert.ok(w108!.total_space_sqft[0] > w106!.total_space_sqft[0]);
  assert.ok(w108!.dock_count > w106!.dock_count);
  assert.ok(w108!.clear_height_ft > w106!.clear_height_ft);
  for (const row of [w106!, w108!]) {
    assert.equal(row.asking_rate_per_sqft, null);
    assert.equal(row.fire_noc_available, null);
  }

  // The ISO creation instant changes calendar day when rendered in IST.
  const beacon = (
    salesEvidence('search_crm_leads', { q: 'Beacon' }, now).data.items as Array<{
      source_created_at: string;
      source_updated_at: string;
    }>
  )[0]!;
  assert.equal(beacon.source_created_at.slice(0, 10), '2026-09-12');
  assert.equal(indiaDate(Date.parse(beacon.source_created_at)), '2026-09-13');
  assert.equal(indiaDate(Date.parse(beacon.source_updated_at)), '2026-09-29');
  const dates = byId(conversationCases, 'smoke-11-iso-date-answer').contains!;
  for (const rendering of [
    'Created: 13 Sep 2026, 03:00 IST. Last updated: 29 Sep 2026, 19:00 IST.',
    'It was created on September 13, 2026 and last updated on Sept 29th.',
    'Created 2026-09-13; updated 2026-09-29.',
  ])
    assert.ok(
      dates.every((p) => p.test(rendering)),
      rendering,
    );
  assert.ok(!dates.every((p) => p.test('Created: 12 Sep 2026. Last updated: 29 Sep 2026.')));
});

test('the fallback gate recognises every generic substitute reply and nothing else', () => {
  assert.ok(FALLBACK_REPLIES.length >= 5);
  for (const reply of FALLBACK_REPLIES) assert.match(`Prefix. ${reply}`, FALLBACK_REPLY);
  assert.doesNotMatch('Fixture Acme Storage is due today at 10:00 IST.', FALLBACK_REPLY);
});

test('RFQ smoke cases are valid transcript trials with reachable effects', async () => {
  // Reuse the transcript runner's paid-call preflight for the RFQ write catalogue.
  for (const loading of ['eager', 'deferred'] as const)
    assert.ok((await validateTranscriptCatalogue('rfq', loading)).length);
  for (const c of rfqCases) {
    assert.ok(isDelegatedSmokeCase(c), c.id);
    assert.equal(c.mode, 'rfq', c.id);
    assert.ok(c.provenance.length > 20, c.id);
    assert.equal(c.expectations.length, c.turns.length, c.id);
    for (const rubric of c.expectations) assert.ok(rubric.length > 40, c.id);
    assert.equal(c.effects.rfqCounts.length, c.turns.length, c.id);
    c.effects.rfqCounts.forEach((count, index, counts) =>
      assert.ok(count <= 1 && count >= (counts[index - 1] ?? 0), c.id),
    );
    if (c.effects.uncertainCreateTurn !== undefined)
      assert.ok(c.effects.uncertainCreateTurn < c.turns.length, c.id);
    for (const turn of c.effects.noSuccessClaimTurns ?? []) assert.ok(turn < c.turns.length, c.id);
    const text = c.turns.join('\n');
    for (const excerpt of c.effects.sourceIncludes ?? []) assert.ok(text.includes(excerpt), c.id);
  }
});

type Rfq = { args: Record<string, unknown>; uncertain?: boolean; operation_id?: string };
function rfqState(rfqs: Rfq[], retries = 0) {
  const fixture = createTranscriptFixture('rfq', () => Date.parse('2026-10-06T09:00:00Z'));
  for (const rfq of rfqs) {
    const operation_id = rfq.operation_id ?? randomUUID();
    fixture.state.rfqs.push({
      id: randomUUID(),
      args: rfq.args,
      updated_at: '2026-10-06T09:01:00.000Z',
      operation_id,
      uncertain: rfq.uncertain ?? false,
    });
    for (let n = 0; n <= retries; n++)
      fixture.state.writes.push({
        tool: 'create_crm_rfq',
        args: rfq.args,
        result: {
          operation_id,
          outcome: rfq.uncertain ? 'outcome_unknown' : 'created',
          code: 'OK',
          message: 'Synthetic receipt.',
        } as never,
      });
  }
  return fixture;
}
const completed = (reply: string) => ({ reply, trace: { outcome: 'completed' } });

test('RFQ effect gates catch duplicates, invented precision, Indian phone rewrites and false success', () => {
  const atlas = byId(rfqCases, 'smoke-08-rfq-bounded-foreign-retry');
  const uncertain = completed(
    'I can’t confirm whether this requirement was saved in CRM. It may or may not be there. Say “retry” and I’ll check again. A retry reuses the same submission, so it won’t create a second RFQ.',
  );
  const bounded = { raw_text: atlas.turns[0], requirement: 'at least 20,000 sqft' };
  assert.deepEqual(
    rfqSmokeChecks(atlas.effects, 0, rfqState([{ args: bounded, uncertain: true }]), uncertain),
    [],
  );
  assert.deepEqual(
    rfqSmokeChecks(atlas.effects, 1, rfqState([{ args: bounded, uncertain: true }], 1), uncertain),
    [],
  );
  const duplicate = rfqState([
    { args: bounded, uncertain: true },
    { args: bounded, uncertain: false },
  ]);
  assert.ok(
    rfqSmokeChecks(atlas.effects, 1, duplicate, uncertain).includes('turn2:rfq_effect_count'),
  );
  const exact = rfqState([{ args: { ...bounded, requirement: '20,000 sqft' }, uncertain: true }]);
  assert.ok(
    rfqSmokeChecks(atlas.effects, 0, exact, uncertain).includes('turn1:requirement_matches_source'),
  );
  const rewritten = rfqState([
    { args: { ...bounded, poc_phone: '+91 9XXXXXXXXX' }, uncertain: true },
  ]);
  assert.ok(
    rfqSmokeChecks(atlas.effects, 0, rewritten, uncertain).includes(
      'turn1:poc_phone_matches_source',
    ),
  );
  const kept = rfqState([{ args: { ...bounded, poc_phone: '+971 5X XXX XXXX' }, uncertain: true }]);
  assert.deepEqual(rfqSmokeChecks(atlas.effects, 0, kept, uncertain), []);
  const fixture = rfqState([{ args: bounded, uncertain: true }]);
  assert.ok(
    rfqSmokeChecks(
      atlas.effects,
      0,
      fixture,
      completed('Saved RFQ: Fixture Atlas Exports'),
    ).includes('turn1:false_success_claim'),
  );
  assert.ok(
    rfqSmokeChecks(atlas.effects, 0, fixture, completed(FALLBACK_REPLIES[0]!)).includes(
      'turn1:fallback_reply',
    ),
  );
  assert.ok(
    rfqSmokeChecks(atlas.effects, 0, rfqState([{ args: bounded }]), uncertain).includes(
      'turn1:uncertain_create_exercised',
    ),
  );

  const lotus = byId(rfqCases, 'smoke-06-rfq-hinglish-incomplete');
  const brief = { raw_text: lotus.turns[0] };
  const saved = completed('Saved RFQ: Fixture Lotus Traders. Full brief saved in the description.');
  assert.deepEqual(rfqSmokeChecks(lotus.effects, 0, rfqState([{ args: brief }]), saved), []);
  assert.deepEqual(
    rfqSmokeChecks(
      lotus.effects,
      0,
      rfqState([{ args: { ...brief, requirement: 'FMCG storage, parking for 2 trucks' } }]),
      saved,
    ),
    [],
  );
  assert.ok(
    rfqSmokeChecks(
      lotus.effects,
      0,
      rfqState([{ args: { ...brief, requirement: '25,000 sqft' } }]),
      saved,
    ).includes('turn1:requirement_not_invented'),
  );
  assert.ok(
    rfqSmokeChecks(lotus.effects, 0, rfqState([{ args: { raw_text: 'summary' } }]), saved).includes(
      'turn1:full_brief_preserved',
    ),
  );

  const harbor = byId(rfqCases, 'smoke-07-rfq-save-offer-yes');
  const offer = completed('Should I save this as a new CRM requirement?');
  assert.deepEqual(rfqSmokeChecks(harbor.effects, 0, rfqState([]), offer), []);
  const early = rfqSmokeChecks(
    harbor.effects,
    0,
    rfqState([{ args: { raw_text: harbor.turns[0] } }]),
    completed('Saved RFQ: Fixture Harbor Pharma'),
  );
  assert.ok(early.includes('turn1:rfq_effect_count'));
  assert.ok(early.includes('turn1:false_success_claim'));
  assert.deepEqual(
    rfqSmokeChecks(
      harbor.effects,
      1,
      rfqState([{ args: { raw_text: harbor.turns[0] } }]),
      completed('Saved RFQ: Fixture Harbor Pharma'),
    ),
    [],
  );
});

test('personal smoke cases are valid single-turn scheduling trials', () => {
  for (const c of personalCases) {
    assert.ok(isDelegatedSmokeCase(c), c.id);
    assert.equal(c.turns.length, 1, c.id);
    assert.equal(c.expectations.length, 1, c.id);
    assert.ok(c.expectations[0].length > 40, c.id);
    assert.equal(c.personal.reminders === 1, c.personal.dueAt !== undefined, c.id);
  }
  // Independent IST arithmetic for "tomorrow at 5 pm", including just after IST midnight.
  const reminder = byId(personalCases, 'smoke-09-reminder-letter-case');
  assert.equal(
    reminder.personal.dueAt!([Date.parse('2026-10-10T06:00:00Z')]),
    '2026-10-11T11:30:00.000Z',
  );
  assert.equal(
    reminder.personal.dueAt!([Date.parse('2026-10-10T19:00:00Z')]),
    '2026-10-12T11:30:00.000Z',
  );
});

test('personal outcome gates accept letter-case differences and reject dropped conditions', () => {
  const reminder = byId(personalCases, 'smoke-09-reminder-letter-case');
  const due = reminder.personal.dueAt!([Date.parse('2026-10-10T06:00:00Z')]);
  const saved = (text: string, dueAt = due) => ({ text, dueAt, state: 'scheduled', owner: 23 });
  const persisted = (reminders: ReturnType<typeof saved>[], commands = reminders.length) => ({
    tasks: 0,
    commands,
    reminderDeliveries: 0,
    reminders,
  });
  const reply = 'Saved reminder: call Ravi, tomorrow at 5:00 pm IST.';
  for (const text of ['call Ravi', 'Call Ravi'])
    assert.deepEqual(
      personalSmokeChecks(reminder, {
        reply,
        expectedDueAt: due,
        persisted: persisted([saved(text)]),
      }),
      [],
    );
  assert.deepEqual(
    personalSmokeChecks(reminder, {
      reply: 'That reminder text does not match your message.',
      expectedDueAt: due,
      persisted: persisted([]),
    }),
    ['reminder_effect_count', 'expected_one_committed_command'],
  );
  assert.ok(
    personalSmokeChecks(reminder, {
      reply,
      expectedDueAt: due,
      persisted: persisted([saved('call Ravi', '2026-10-11T12:30:00.000Z')]),
    }).includes('wrong_resolved_instant'),
  );

  const conditional = byId(personalCases, 'smoke-12-conditional-reminder');
  const honest =
    "I can't set conditional reminders yet, so nothing is saved. I can set a plain 9 am reminder if you want one.";
  assert.equal(truthfulConditionalLimitation(honest), true);
  // Wording from smoke run 2026-10-10T11-14-01.150Z-5853eed1: truthful, nothing saved.
  for (const wording of [
    'I can’t check whether the owner has replied at reminder time. Would you like a regular reminder tomorrow, 11 October, at 9:00 am to call the owner?',
    'I can’t check whether the owner has replied when the reminder is due. I haven’t set it.',
  ])
    assert.equal(truthfulConditionalLimitation(wording), true, wording);
  // Naming the time alone, without stating the limitation, is not enough.
  assert.equal(truthfulConditionalLimitation('I will check at reminder time.'), false);
  assert.deepEqual(
    personalSmokeChecks(conditional, { reply: honest, persisted: persisted([]) }),
    [],
  );
  const dropped = personalSmokeChecks(conditional, {
    reply: "Done, I'll remind you tomorrow at 9 am.",
    persisted: persisted([saved('call the owner')]),
  });
  for (const failure of [
    'missing_truthful_conditional_limitation',
    'reminder_effect_count',
    'unexpected_personal_mutation',
  ])
    assert.ok(dropped.includes(failure), failure);

  const mixed = byId(personalCases, 'smoke-10-tasks-and-followups');
  assert.equal(mixed.businessReads, true);
  assert.deepEqual(
    personalSmokeChecks(mixed, {
      reply: 'You have no open tasks.\n\nFollow-ups today: Fixture Acme Storage at 10:00 IST.',
      persisted: persisted([]),
    }),
    [],
  );
  assert.ok(
    personalSmokeChecks(mixed, {
      reply: 'Follow-ups today: Fixture Acme Storage at 10:00 IST.',
      persisted: persisted([]),
    }).some((failure) => failure.startsWith('missing:')),
  );
  assert.ok(
    personalSmokeChecks(mixed, { reply: FALLBACK_REPLIES[1]!, persisted: persisted([]) }).includes(
      'fallback_reply',
    ),
  );
});

/** Ten-digit Indian mobile (leading 6-9), optionally prefixed by +91/91/0091/0, any separators. */
function realisticIndianMobiles(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\+?\d(?:[\s().-]{0,2}\d){9,13}/g)) {
    let digits = match[0].replace(/\D/g, '');
    if (digits.length === 14 && digits.startsWith('0091')) digits = digits.slice(4);
    else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (/^[6-9]\d{9}$/.test(digits)) found.push(match[0]);
  }
  return found;
}

test('synthetic smoke data contains no realistic-looking Indian mobile numbers', () => {
  // Detector self-check with obviously artificial digits assembled at runtime.
  const artificial = `9${'0'.repeat(9)}`;
  assert.equal(realisticIndianMobiles(`call +91 ${artificial}`).length, 1);
  assert.equal(
    realisticIndianMobiles(`${artificial.slice(0, 5)} ${artificial.slice(5)}`).length,
    1,
  );
  assert.deepEqual(
    realisticIndianMobiles('9XXXXXXXXX, +971 5X XXX XXXX, 40,000 sft, 2026-09-12T21:30:00Z'),
    [],
  );
  const source = readFileSync(new URL('../../evals/smoke-cases.ts', import.meta.url), 'utf8');
  const data = JSON.stringify(SMOKE_CASES, (_key, value) =>
    value instanceof RegExp ? value.source : typeof value === 'function' ? undefined : value,
  );
  assert.deepEqual(realisticIndianMobiles(source), []);
  assert.deepEqual(realisticIndianMobiles(data), []);
  // The foreign-number case still carries a phone, as a non-dialable placeholder.
  assert.match(data, /\+971 5X XXX XXXX/);
});

test('the conversation runner registers the smoke suite; listing is free and spending is gated', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'evals/conversation-run.ts', ...args], {
      cwd: new URL('../../', import.meta.url),
      env: {
        ...process.env,
        OPENAI_API_KEY: '',
        EVAL_MODEL: DEFAULT_EVAL_MODEL,
        EVAL_MAX_USD: '',
        TEST_MESSAGE_DATABASE_URL: '',
      },
      encoding: 'utf8',
      timeout: 60000,
    });
  const listed = run(['--suite', 'smoke', '--list']);
  assert.equal(listed.error, undefined);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n'), EXPECTED_IDS);
  // The default three-trial allowance refuses the suite before any key or model is loaded.
  const refused = run(['--suite', 'smoke']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /EVAL_TRIAL_ALLOWANCE_EXCEEDED: 12 planned, 3 allowed/);
  assert.doesNotMatch(refused.stderr, /OPENAI_API_KEY is required/);
  // Personal cases refuse to start without the disposable local database, also before a key.
  const noDatabase = run(['--suite', 'smoke', '--max-trials', '12']);
  assert.equal(noDatabase.status, 1);
  assert.match(noDatabase.stderr, /SMOKE_LOCAL_DATABASE_REQUIRED/);
  assert.doesNotMatch(noDatabase.stderr, /OPENAI_API_KEY is required/);
});
