/** Captured failure shapes, synthetic records, real graph and write orchestration. No paid calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesGraph } from '../../src/modules/assistant/sales.graph.js';
import { renderAnswer } from '../../src/modules/assistant/answer-rendering.js';
import { dealDisplayIssues } from '../../src/modules/assistant/deal-display.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import {
  createSalesFixture,
  FIXTURE_JID,
  FIXTURE_LEAD_ID,
} from '../../scripts/lib/sales-fixture.js';
import { createTranscriptFixture } from '../../scripts/lib/transcript-fixture.js';
import { planningResult } from '../fixtures/planning-model.js';
import type { ModelRequest, TextModel } from '../../src/modules/assistant/assistant.types.js';

const result = (text: string) => ({ text, inputTokens: 1, outputTokens: 1 });
const card = (body = 'Recorded requirement: 25,000 sq ft; verify the details.') => ({
  kind: 'crm_record' as const,
  record_id: FIXTURE_LEAD_ID,
  body,
  include_time: false,
});
const approved = { supported: true, repair: 'none', feedback: '', reason: 'none' };

async function run(options: {
  draft: string;
  review: (payload: any, pass: number) => unknown;
  repair?: (payload: any, signal?: AbortSignal) => string | Promise<string>;
  format?: (payload: any) => string;
  expireResearch?: boolean;
  repairDeadlineMs?: number;
  request?: string;
  sourceName?: string;
}) {
  const fixture = createSalesFixture();
  if (options.sourceName)
    fixture.state.mutate = (source, tool) => {
      if (tool === 'read_crm_lead') source.data.name = options.sourceName!;
    };
  const trusted = { key: { remoteJid: FIXTURE_JID }, runId: 'answer-pipeline' };
  const signal = AbortSignal.timeout(10000);
  const open = await fixture.service.openTools(trusted, signal);
  const requests: ModelRequest[] = [];
  const deadlines = { researchDeadlineMs: Date.now() + 8000, replyDeadlineMs: Date.now() + 10000 };
  let reviews = 0,
    sessions = 0;
  const model: TextModel = {
    async complete(request, signal) {
      requests.push(request);
      const plan = planningResult(request);
      if (plan) return plan;
      const payload = JSON.parse(request.messages[0]!.content);
      if (request.stage === 'verifier') {
        if (options.expireResearch) deadlines.researchDeadlineMs = 0;
        if (options.repairDeadlineMs !== undefined)
          deadlines.replyDeadlineMs = Date.now() + options.repairDeadlineMs;
        return result(JSON.stringify(options.review(payload, ++reviews)));
      }
      if (request.stage === 'worker')
        return result((await options.repair?.(payload, signal)) ?? options.draft);
      if (request.stage === 'formatter') return result(options.format?.(payload) ?? options.draft);
      throw new Error(`Unexpected stage ${request.stage}`);
    },
    startToolSession() {
      sessions++;
      let step = 0;
      return {
        async next() {
          return step++ === 0
            ? {
                ...result(''),
                calls: [
                  {
                    id: 'read',
                    name: 'read_crm_lead',
                    arguments: JSON.stringify({ id: FIXTURE_LEAD_ID }),
                  },
                ],
              }
            : { ...result(options.draft), calls: [] };
        },
        accept() {},
      };
    },
  };
  const reply = await buildSalesGraph(model, async () => open, deadlines).invoke(
    {
      input: options.request ?? 'Read the CRM requirement and give me a concise answer.',
      history: [],
      audience: 'dm',
    },
    { signal },
  );
  return { reply, requests, fixture, sessions, evidence: open.run!.evidence };
}

test('explicit CRM record rendering cannot attach dates to a warehouse caveat naming its client', async () => {
  const draft = JSON.stringify({
    answer_blocks: [
      card(),
      {
        kind: 'text',
        text: 'Separate warehouse ID 101. Its area is unrelated to Fixture Acme Storage’s requirement.',
      },
    ],
  });
  const observed = await run({
    draft,
    review: (payload) => {
      assert.equal(payload.rendered_crm_records[0].record_id, FIXTURE_LEAD_ID);
      assert.deepEqual(payload.factual_issues, []);
      assert.equal((payload.answer.match(/Created:/g) ?? []).length, 1);
      assert.doesNotMatch(payload.answer.split('Separate warehouse')[1], /Created:|Last updated:/);
      return approved;
    },
  });
  assert.equal(observed.reply.approved, true);
  assert.doesNotMatch(observed.reply.reply, new RegExp(FIXTURE_LEAD_ID));
  assert.equal(observed.requests.filter((r) => r.stage === 'formatter').length, 0);
});

test('a repeated company field cannot bind separate note and warehouse dates to the CRM card', async () => {
  const observed = await run({
    draft: JSON.stringify({
      answer_blocks: [
        card('• Company: Fixture Acme Storage. POC requires verification.\n• Stage: RFQ received.'),
        { kind: 'text', text: '*2. Recent notes*\nThe notes lookup was unavailable.' },
        {
          kind: 'text',
          text: '*3. Separate warehouse: ID 101*\n• Created: 10 Aug 2025, 6:53 pm IST.',
        },
      ],
    }),
    review: (payload) => {
      assert.deepEqual(payload.factual_issues, []);
      assert.match(payload.answer, /Created: 1 Sept 2026/);
      assert.match(payload.answer, /Created: 10 Aug 2025/);
      return approved;
    },
  });
  assert.equal(observed.reply.approved, true);
  assert.equal(observed.requests.filter((request) => request.stage === 'verifier').length, 1);
});

test('literal CRM names survive style rules while generated stock phrasing still needs repair', async () => {
  for (const stockBody of [false, true]) {
    const observed = await run({
      sourceName: 'Leverage Warehousing',
      draft: JSON.stringify({
        answer_blocks: [
          card(stockBody ? 'Certainly, here are the recorded details.' : 'Recorded details.'),
        ],
      }),
      repair: () => JSON.stringify({ answer_blocks: [card('Recorded details.')] }),
      format: () => JSON.stringify({ answer_blocks: [card('Recorded details.')] }),
      review: (payload, pass) => {
        assert.match(payload.answer, /\*Leverage Warehousing\*/);
        assert.equal(payload.presentation_issues.length, stockBody && pass === 1 ? 1 : 0);
        return approved;
      },
    });
    assert.equal(observed.reply.approved, true);
    assert.equal(observed.requests.filter((r) => r.stage === 'verifier').length, stockBody ? 2 : 1);
    assert.match(observed.reply.reply, /Leverage Warehousing/);
    assert.doesNotMatch(observed.reply.reply, /Certainly/);
  }
});

test('native date corrections from existing evidence survive the research deadline without new tools', async () => {
  const observed = await run({
    request: 'Read this CRM record and give its native creation and update dates.',
    draft: 'Deal: “Fixture Acme Storage”\nRecorded requirement: 25,000 sq ft.',
    expireResearch: true,
    review: (payload, pass) =>
      pass === 1
        ? {
            supported: false,
            repair: 'tools',
            reason: 'incomplete_answer',
            feedback: 'The requested native dates are already available in evidence. Add them.',
          }
        : (assert.match(payload.answer, /Created: 1 Sept 2026/), approved),
    repair: (payload) => {
      assert.equal(payload.tool_budget.research_remaining_ms_at_observation, 0);
      assert.equal(payload.evidence[0].tool, 'read_crm_lead');
      return JSON.stringify({ answer_blocks: [card()] });
    },
  });
  assert.equal(observed.reply.approved, true);
  assert.equal(observed.sessions, 1);
  assert.deepEqual(
    observed.fixture.state.calls.map((c) => c.tool),
    ['read_crm_lead'],
  );
  assert.equal(observed.requests.filter((r) => r.stage === 'worker').length, 1);
  assert.equal(observed.requests.filter((r) => r.stage === 'formatter').length, 0);
  assert.equal(observed.requests.filter((r) => r.stage === 'verifier').length, 2);
});

test('evidence-only repair remains bounded by the original reply deadline', async () => {
  let repaired = 0;
  await assert.rejects(
    run({
      draft: 'Fixture Acme Storage needs space.',
      expireResearch: true,
      repairDeadlineMs: 100,
      review: () => ({
        supported: false,
        repair: 'evidence',
        reason: 'incomplete_answer',
        feedback: 'Use the recorded area.',
      }),
      repair: async (_payload, signal) => {
        repaired++;
        assert.ok(signal);
        signal.throwIfAborted();
        return new Promise<never>((_, reject) => {
          const stalled = setTimeout(
            () => reject(new Error('Repair ignored its original deadline')),
            2000,
          );
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(stalled);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    }),
    (error) => error instanceof Error && error.name === 'TimeoutError',
  );
  assert.equal(repaired, 1);
});

test('an invalid record binding is repaired before review without exposing raw envelope or guessed ID', async () => {
  const observed = await run({
    draft: JSON.stringify({ answer_blocks: [{ ...card(), record_id: 'guessed-identity' }] }),
    repair: (payload) => {
      assert.equal(payload.repair_status, 'rejected');
      assert.match(payload.render_issues[0], /absent from current authorized evidence/);
      return JSON.stringify({ answer_blocks: [card()] });
    },
    review: (payload) => {
      assert.doesNotMatch(payload.answer, /guessed-identity|answer_blocks|record_id/);
      assert.deepEqual(payload.factual_issues, []);
      return approved;
    },
  });
  assert.equal(observed.reply.approved, true);
  assert.equal(observed.requests.filter((r) => r.stage === 'worker').length, 1);
  assert.equal(observed.requests.filter((r) => r.stage === 'verifier').length, 1);
});

test('a rejected format edit goes to evidence repair instead of re-reviewing the old answer', async () => {
  const original = 'Fixture Acme Storage requires 25,000 sq ft. Verify recorded details.';
  const observed = await run({
    draft: original,
    review: (payload, pass) =>
      pass === 1
        ? {
            supported: false,
            repair: 'format',
            reason: 'presentation',
            feedback: 'Use a compact labelled bullet.',
          }
        : (assert.notEqual(payload.answer, original),
          assert.doesNotMatch(payload.answer, /999999/),
          approved),
    format: () => '- Fixture Acme Storage requires 999999 sq ft.',
    repair: (payload) => {
      assert.equal(payload.repair_status, 'rejected');
      assert.equal(payload.previous_reply, original);
      assert.doesNotMatch(JSON.stringify(payload), /999999/);
      return '- Fixture Acme Storage: 25,000 sq ft recorded; verify details.';
    },
  });
  assert.equal(observed.reply.approved, true);
  assert.deepEqual(
    observed.reply.stages.flatMap((s) => (s.answerRepair ? [s.answerRepair] : [])),
    [
      { kind: 'format', outcome: 'rejected' },
      { kind: 'evidence', outcome: 'changed' },
    ],
  );
  assert.equal(observed.requests.filter((r) => r.stage === 'verifier').length, 2);
});

test('unchanged formatter and evidence repairs stop without another identical review', async () => {
  const observed = await run({
    draft: 'Fixture Acme Storage: 25,000 sq ft.',
    review: () => ({
      supported: false,
      repair: 'format',
      reason: 'incomplete_answer',
      feedback: 'The requested comparison is missing.',
    }),
  });
  assert.equal(observed.reply.approved, false);
  assert.equal(observed.reply.unavailable, true);
  assert.equal(observed.requests.filter((r) => r.stage === 'verifier').length, 1);
  assert.equal(observed.requests.filter((r) => r.stage === 'worker').length, 1);
  assert.deepEqual(
    observed.reply.stages.flatMap((s) => (s.answerRepair ? [s.answerRepair.outcome] : [])),
    ['unchanged', 'unchanged'],
  );
});

test('a factual repair still needs review and cannot deliver an unsupported replacement', async () => {
  const observed = await run({
    draft: 'Fixture Acme Storage needs a warehouse.',
    review: (_payload, pass) => ({
      supported: false,
      repair: 'evidence',
      reason: 'unsupported_claim',
      feedback: pass === 1 ? 'Use the recorded requirement.' : 'That area is not supported.',
    }),
    repair: () => 'Fixture Acme Storage requires 999999 sq ft.',
  });
  assert.equal(observed.reply.unavailable, true);
  assert.doesNotMatch(observed.reply.reply, /999999/);
  assert.equal(observed.requests.filter((r) => r.stage === 'verifier').length, 2);
});

test('optional metadata suggestions do not block a supported answer or initiate repairs', async () => {
  const draft = 'Fixture Acme Storage: recorded 25,000 sq ft in Bengaluru; verify details.';
  const observed = await run({
    draft,
    review: () => ({
      supported: false,
      remainder_supported: true,
      reason: 'presentation',
      repair: 'format',
      feedback: 'Optional dates would be useful.',
      findings: [
        {
          severity: 'suggestion',
          kind: 'presentation',
          message: 'Could add native dates.',
          quote: '',
          replacement: null,
          references: [],
        },
      ],
    }),
  });
  assert.equal(observed.reply.approved, true);
  assert.equal(observed.reply.reply, draft);
  assert.equal(
    observed.requests.filter((r) => ['formatter', 'worker'].includes(r.stage)).length,
    0,
  );
});

test('wrong dates still block even when the model reviewer mistakenly approves', async () => {
  const observed = await run({
    draft: '*Fixture Acme Storage*\nCreated: 1 Sept 2025\nLast updated: 29 Sept 2026',
    review: () => approved,
    repair: () => JSON.stringify({ answer_blocks: [card()] }),
  });
  assert.equal(observed.reply.approved, true);
  assert.match(observed.reply.reply, /Created: 1 Sept 2026/);
  assert.equal(observed.requests.filter((r) => r.stage === 'verifier').length, 2);
});

test('CRM renderer refuses absent identities and model-supplied dates, and shows native IST times to the minute', async () => {
  const observed = await run({ draft: 'Recorded requirement read.', review: () => approved });
  for (const block of [
    { ...card(), record_id: 'unavailable-record' },
    { ...card(), record_id: '101' },
    { ...card(), body: 'Created: 1 Jan 2020' },
  ]) {
    const rendered = renderAnswer({ answer_blocks: [block] }, observed.evidence);
    assert.equal(rendered.text, '');
    assert.ok(rendered.issues.length);
  }
  const record = observed.evidence[0]!.result.data;
  record.source_created_at = '2026-09-01T18:30:42.123Z';
  const rendered = renderAnswer(
    { answer_blocks: [{ ...card(), include_time: true }] },
    observed.evidence,
  );
  // Cards show minutes; seconds and milliseconds are noise in chat.
  assert.match(rendered.text, /2 Sept 2026, 00:00 IST/);
  assert.doesNotMatch(rendered.text, /00:00:42/);
  assert.deepEqual(dealDisplayIssues(rendered.text, observed.evidence), []);
  assert.ok(
    dealDisplayIssues(rendered.text.replace('00:00 IST', '00:01 IST'), observed.evidence).length,
  );
  // A time written at finer precision is still checked at that precision.
  const precise = (value: string) => rendered.text.replace('00:00 IST', value);
  assert.deepEqual(dealDisplayIssues(precise('00:00:42.123 IST'), observed.evidence), []);
  assert.ok(dealDisplayIssues(precise('00:00:42.124 IST'), observed.evidence).length);
  record.source_created_at = null;
  record.last_polled_at = new Date().toISOString();
  assert.match(
    renderAnswer({ answer_blocks: [card()] }, observed.evidence).text,
    /Created: Not recorded/,
  );
});

test('a closing heading with nothing under it is dropped; other text blocks are kept', async () => {
  const observed = await run({ draft: 'Recorded requirement read.', review: () => approved });
  const heading = { kind: 'text' as const, text: '*CRM timestamps (IST):*' };
  const closing = renderAnswer({ answer_blocks: [card(), heading] }, observed.evidence);
  assert.deepEqual(closing.issues, []);
  assert.doesNotMatch(closing.text, /CRM timestamps/);
  // An introduction before a card, and a real closing sentence, stay.
  const intro = renderAnswer({ answer_blocks: [heading, card()] }, observed.evidence);
  assert.match(intro.text, /^\*CRM timestamps \(IST\):\*/);
  const sentence = { kind: 'text' as const, text: 'Both need verification before the visit.' };
  assert.match(
    renderAnswer({ answer_blocks: [card(), sentence] }, observed.evidence).text,
    /Both need verification before the visit\.$/,
  );
});

test('ordinary CRM insertion omits optional enrichment and saves once without extra confirmation', async () => {
  for (const materialBlock of [false, true]) {
    const fixture = createTranscriptFixture('rfq', Date.now);
    const text = 'add to crm pls: need 5,000-10,000 sft around HSR / Bellandur, shed preferred';
    const trusted = fixture.trusted(text);
    const requests: ModelRequest[] = [];
    const model: TextModel = {
      async complete(request) {
        requests.push(request);
        const plan = planningResult(request);
        if (plan) return plan;
        if (request.stage === 'verifier')
          return result(
            JSON.stringify({
              supported: false,
              remainder_supported: !materialBlock,
              reason: materialBlock ? 'unsupported_claim' : 'incomplete_answer',
              repair: 'evidence',
              feedback: materialBlock
                ? 'The staged values do not match the request.'
                : 'Optional enrichment could be added later.',
              findings: [
                {
                  severity: materialBlock ? 'blocking' : 'suggestion',
                  kind: 'factual',
                  message: materialBlock
                    ? 'Wrong requested values.'
                    : 'Budget and contact are not supplied and may remain omitted.',
                  quote: '',
                  replacement: null,
                  references: [],
                },
              ],
            }),
          );
        return result(JSON.stringify({ additional_reply: '' }));
      },
      startToolSession() {
        let step = 0;
        return {
          async next() {
            return step++ === 0
              ? {
                  ...result(''),
                  calls: [
                    {
                      id: 'create',
                      name: 'create_crm_rfq',
                      arguments: JSON.stringify({
                        location: 'HSR / Bellandur',
                        requirement: '5,000-10,000 sft',
                      }),
                    },
                  ],
                }
              : { ...result(''), calls: [] };
          },
          accept() {},
        };
      },
    };
    const reply = await new AssistantService(
      { model: 'fixture', timeoutMs: 10000 },
      model,
      undefined,
      undefined,
      undefined,
      fixture.reads,
      { businessWrites: fixture.writes },
    ).prepare(
      {
        chatId: FIXTURE_JID,
        messageId: trusted.runId,
        text,
        sentAtMs: Date.now(),
        fromMe: false,
        isGroup: false,
        mentionsBot: false,
      },
      undefined,
      trusted,
    );
    assert.equal(fixture.state.rfqs.length, materialBlock ? 0 : 1);
    assert.equal(fixture.state.writes.length, materialBlock ? 0 : 1);
    if (!materialBlock) {
      assert.equal(reply.trace.outcome, 'completed');
      assert.equal(fixture.state.rfqs[0]!.args.raw_text, text);
      assert.equal(fixture.state.rfqs[0]!.args.location, 'HSR / Bellandur');
      for (const field of ['city', 'company_name', 'budget', 'poc_name', 'lease_duration'])
        assert.equal(fixture.state.rfqs[0]!.args[field], undefined);
      assert.equal(fixture.state.reads.length, 0);
      assert.doesNotMatch(reply.text, /confirm|before I can|provide.*budget/i);
      assert.equal(requests.filter((r) => r.stage === 'verifier').length, 1);
    } else {
      assert.equal(reply.trace.outcome, 'unavailable');
    }
  }
});
