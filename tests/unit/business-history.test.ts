import { executeRecall } from '../fixtures/business-recall.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSalesFixture,
  FIXTURE_JID,
  FIXTURE_LEAD_ID,
} from '../../scripts/lib/sales-fixture.js';
import { businessRecall } from '../../src/modules/assistant/business-recall.js';
import {
  BUSINESS_HISTORY_PREFIX,
  ToolHistory,
} from '../../src/modules/assistant/business-history.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { ContextEngineError } from '../../src/modules/context-engine/context.types.js';
import { toolDeliverySchema } from '../../src/modules/assistant/tool-evidence.js';
import { contextFixture } from '../fixtures/chat-context.js';
import { planningResult } from '../fixtures/planning-model.js';
import type { ChatMessage, TextModel } from '../../src/modules/assistant/assistant.types.js';
import { contextTokens } from '../../src/modules/assistant/chat-context.js';
import {
  historicalReply,
  projectToolReply,
} from '../../src/modules/assistant/tool-history-recall.js';
import { createHash } from 'node:crypto';

const signal = () => AbortSignal.timeout(10000);
const trusted = { key: { remoteJid: FIXTURE_JID }, runId: 'historical-crm' };
const text = 'Fixture Acme Storage: the RFQ required 30,000 sq ft; budget was market rate.';

test('historical non-retryable failures do not blacklist a tool in a new turn', async () => {
  const fixture = createSalesFixture();
  const first = (await fixture.service.openTools(trusted, signal())).run!;
  fixture.state.failures.set('read_crm_lead', new ContextEngineError('UNAVAILABLE', false));
  await first.execute('read_crm_lead', JSON.stringify({ id: FIXTURE_LEAD_ID }), signal());
  assert.equal(first.historyDelivery()!.activity![0]!.retryable, false);
  fixture.state.failures.delete('read_crm_lead');
  const fresh = (
    await fixture.service.openTools({ ...trusted, runId: 'genuine-new-retry' }, signal())
  ).run!;
  const recall = businessRecall(
    [
      {
        role: 'assistant',
        content: PRIVATE_HISTORY_REPLY,
        protectedReply: { text: 'The lookup failed earlier.', receipt: first.historyDelivery() },
      },
    ],
    fresh,
  );
  assert.match(recall.messages[0]!.content, /not_current/);
  assert.match(recall.messages[0]!.content, /history does not blacklist tools/);
  assert.ok(fresh.tools.some((tool) => tool.name === 'read_crm_lead'));
  const before = fixture.state.calls.length;
  assert.equal(
    (await fresh.execute('read_crm_lead', JSON.stringify({ id: FIXTURE_LEAD_ID }), signal())).ok,
    true,
  );
  assert.equal(fixture.state.calls.length, before + 1);
});

test('shared history bounds output and never retains credential fields or raw errors', async () => {
  const history = new ToolHistory(Date.now);
  await assert.rejects(
    history.track('future_tool', '{}', async () => {
      throw new Error('PRIVATE_EXCEPTION');
    }),
  );
  history.record('future_tool', '{}', {
    ok: false,
    code: 'UNAVAILABLE',
    message: 'PRIVATE_ERROR_BODY',
  });
  history.record('future_tool', '{"authorization":"PRIVATE_ARGUMENT"}', {
    ok: true,
    nested: { access_token: 'PRIVATE_RESULT', value: 'useful result' },
  });
  assert.deepEqual(
    history.activity.map((entry) => entry.status),
    ['interrupted', 'failed', 'succeeded'],
  );
  assert.doesNotMatch(JSON.stringify(history.snapshot()), /PRIVATE_/);
  assert.match(JSON.stringify(history.snapshot()), /useful result/);
  for (let n = 0; n < 40; n++)
    history.record('future_tool', JSON.stringify({ n }), { ok: true, body: 'x'.repeat(10000) });
  assert.ok(history.snapshot().omittedCount! > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(history.snapshot())) < 25000);
  assert.equal(history.activity.at(-1)?.arguments?.n, 39);
  assert.equal(history.activity.at(-1)?.resultOmitted, true);
});

test('result pressure compacts bodies before losing failed, uncertain or successful attempts', () => {
  const history = new ToolHistory(Date.now);
  history.record('read_crm_lead', '{"id":"earlier"}', {
    ok: false,
    code: 'UNAVAILABLE',
    retryable: false,
  });
  history.record('create_crm_lead', '{}', undefined, {
    status: 'uncertain',
    phase: 'recovery',
    operationId: 'existing-operation',
  });
  for (let n = 0; n < 16; n++)
    history.record('search_warehouses', JSON.stringify({ limit: 3, q: `Query ${n}` }), {
      ok: true,
      data: { fields: Array.from({ length: 5 }, (_, i) => `${n}:${i}:` + 'source '.repeat(80)) },
    });
  assert.equal(history.activity.length, 18);
  assert.equal(history.snapshot().omittedCount, undefined);
  assert.deepEqual(history.activity[0]?.arguments, { id: 'earlier' });
  assert.equal(history.activity[0]?.retryable, false);
  assert.equal(history.activity[1]?.status, 'uncertain');
  assert.equal(history.activity[1]?.operationId, 'existing-operation');
  assert.ok(
    history.activity.slice(2).some((entry) => entry.result === undefined && entry.resultOmitted),
  );
  assert.ok(
    history.activity
      .slice(2)
      .every((entry) => entry.status === 'succeeded' && entry.arguments?.limit === 3),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(history.snapshot())) < 25000);
});
async function setup() {
  const fixture = createSalesFixture();
  const original = (await fixture.service.openTools(trusted, signal())).run!;
  await original.execute('read_crm_lead', JSON.stringify({ id: FIXTURE_LEAD_ID }), signal());
  const history: ChatMessage[] = [
    { role: 'user', content: 'Pull the Acme CRM request.' },
    {
      role: 'assistant',
      content: PRIVATE_HISTORY_REPLY,
      protectedReply: { text, receipt: original.delivery() },
    },
  ];
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  return { fixture, original, history, run };
}

test('CRM answer, exact selectors and outcomes are visible without rereading or promoting stale facts', async () => {
  const { fixture, history, run } = await setup();
  const before = fixture.state.calls.length;
  const recall = businessRecall(history, run);
  assert.match(recall.messages[1]!.content, /30,000 sq ft/);
  assert.match(recall.messages[1]!.content, /read_crm_lead/);
  assert.match(recall.messages[1]!.content, /succeeded/);
  assert.ok(recall.messages[1]!.content.includes(FIXTURE_LEAD_ID));
  assert.equal(fixture.state.calls.length, before);
  assert.deepEqual(run.evidence, []);
  assert.equal(run.delivery()?.historicalOnly, true);
  assert.deepEqual(run.delivery()?.checks, []);
  assert.ok(!JSON.stringify(recall.messages).includes('fingerprint'));
  assert.ok(!JSON.stringify(recall.messages).includes('protectedReply'));
  fixture.state.failures.set('read_crm_lead', new ContextEngineError('UNAVAILABLE'));
  assert.equal((await executeRecall(recall, '{}', signal())).refresh_status, 'partial');
  assert.ok(
    recall.messages[1]!.content.includes(text),
    'a failed refresh cannot erase the delivered answer',
  );
});

test('a failed read and successful retry retain their own parameters and distinct outcomes', async () => {
  const { fixture, run } = await setup();
  const args = { view: 'accessible', limit: 10 };
  fixture.state.failures.set('search_crm_leads', new ContextEngineError('UNAVAILABLE', true));
  await run.execute('search_crm_leads', JSON.stringify(args), signal());
  const failed = run.delivery()!;
  assert.equal(failed.historicalOnly, true);
  assert.equal(failed.activity?.[0]?.status, 'failed');
  fixture.state.failures.delete('search_crm_leads');
  await run.execute('search_crm_leads', JSON.stringify(args), signal());
  const receipt = run.delivery()!;
  assert.deepEqual(
    receipt.activity?.map((item) => [item.status, item.arguments]),
    [
      ['failed', args],
      ['succeeded', args],
    ],
  );
  assert.equal(receipt.activity?.[0]?.code, 'UNAVAILABLE');
  assert.ok(receipt.activity?.[1]?.records?.some((record) => record.id === FIXTURE_LEAD_ID));
  assert.equal(receipt.checks.length, 1);
});

test('unsafe or oversized tool arguments are explicitly omitted from historical activity', async () => {
  const { run } = await setup();
  await run.execute(
    'search_crm_leads',
    JSON.stringify({ authorization: 'SECRET_VALUE' }),
    signal(),
  );
  await run.execute('search_crm_leads', JSON.stringify({ q: 'X'.repeat(3000) }), signal());
  assert.ok(
    run
      .delivery()!
      .activity!.every((item) => item.argumentsOmitted === true && item.arguments === undefined),
  );
  assert.ok(!JSON.stringify(run.delivery()).includes('SECRET_VALUE'));
});

test('standalone CRM context survives compaction and restart, expires, and is cleared by forgetting', async () => {
  const { history, run } = await setup();
  const memory = contextFixture();
  memory.reassign(run.employeeId);
  await memory.context.prepare(...memory.turn(1, '/pins'));
  memory.add(2, history[0]!);
  memory.add(3, history[1]!);
  for (let n = 4; n < 45; n++)
    memory.add(n, { role: 'user', content: `Unrelated conversation ${n}` });
  await memory.context.prepare(...memory.turn(45, 'Continue'));
  assert.ok(memory.requests.length > 0);
  assert.ok(
    memory.requests.every((request) => !JSON.stringify(request).includes(text)),
    'exact business bodies are retained separately from generated notes',
  );
  memory.advance(2);
  const restarted = await memory
    .create()
    .prepare(...memory.turn(46, 'What budget did you show for that RFQ?'));
  const recall = businessRecall(restarted!.history, run, memory.now());
  assert.ok(recall.messages.some((message) => message.content.includes(text)));
  assert.ok(recall.messages.some((message) => message.content.includes(FIXTURE_LEAD_ID)));
  assert.equal(businessRecall(restarted!.history, undefined, memory.now()).available, false);
  await memory.context.prepare(...memory.turn(47, '/forget context'));
  assert.ok(
    !(await memory.create().prepare(...memory.turn(48, 'Continue')))!.history.some(
      (entry) => entry.protectedReply,
    ),
  );
  assert.ok(
    !businessRecall(restarted!.history, run, memory.now() + 31 * 86400000).messages.some((entry) =>
      entry.content.includes(text),
    ),
  );
});

test('internal receipt bookkeeping does not evict two bounded answers and tool trails after compaction', async () => {
  const { original, run } = await setup();
  const memory = contextFixture();
  memory.reassign(run.employeeId);
  const receipts = [structuredClone(original.delivery()!), structuredClone(original.delivery()!)];
  for (const [index, receipt] of receipts.entries()) {
    const trail = new ToolHistory(() => memory.now());
    for (let call = 0; call < 4; call++) {
      const items = Array.from({ length: 10 }, (_, row) => ({
        value: createHash('sha256').update(`synthetic:${index}:${call}:${row}`).digest('hex'),
      }));
      trail.record('search_crm_leads', JSON.stringify({ limit: 10, q: `Sample ${index}` }), {
        ok: true,
        data: { items },
      });
    }
    // Rolling-compatible receipts contain both the legacy trail and canonical history.
    receipt.activity = trail.activity;
    receipt.history = trail.snapshot();
    receipt.preparedAt = new Date(memory.now()).toISOString();
  }
  const replies = receipts.map((receipt, index) => ({
    text:
      index === 0
        ? 'Original sample: Acme and Beta; overlap Acme.'
        : 'Corrected sample: Gamma; no overlap.',
    receipt,
  }));
  assert.ok(
    contextTokens(replies) > 6000,
    'internal duplicated receipt data exceeds the model budget',
  );
  assert.ok(
    contextTokens(
      replies.map((reply) => projectToolReply(historicalReply(reply, memory.now())!).content),
    ) < 6000,
    'both actual historical projections fit the model budget',
  );
  await memory.context.prepare(...memory.turn(1, '/pins'));
  memory.add(2, { role: 'user', content: 'Show the original sample and overlap.' });
  memory.add(3, { role: 'assistant', content: PRIVATE_HISTORY_REPLY, protectedReply: replies[0]! });
  memory.add(4, { role: 'user', content: 'Correct the second sample only.' });
  memory.add(5, { role: 'assistant', content: PRIVATE_HISTORY_REPLY, protectedReply: replies[1]! });
  for (let n = 6; n < 48; n++) memory.add(n, { role: 'user', content: `Unrelated chat ${n}` });
  await memory.context.prepare(...memory.turn(48, 'Continue'));
  const restored = await memory
    .create()
    .prepare(...memory.turn(49, 'What was the original overlap and what queries did you run?'));
  const recall = businessRecall(restored!.history, run, memory.now());
  const projected = recall.messages.map((message) => message.content).join('\n');
  for (const reply of replies)
    assert.ok(
      projected.includes(reply.text),
      'both original and corrected delivered answers survive',
    );
  assert.match(projected, /Sample 0/);
  assert.match(projected, /Sample 1/);
  assert.match(projected, /search_crm_leads/);
  assert.match(projected, /succeeded/);
  assert.equal(businessRecall(restored!.history, undefined, memory.now()).available, false);
});

test('large tool histories preserve both clients, failed replies and their requests after compaction and restart', async () => {
  const { original, run, fixture } = await setup();
  const memory = contextFixture();
  memory.reassign(run.employeeId);
  const replies = [
    'Client A separate property: 2. ID 105.',
    'The Client B shortlist could not be delivered.',
  ].map((text, index) => {
    const receipt = structuredClone(original.delivery()!);
    const trail = new ToolHistory(() => memory.now() + index);
    trail.record(
      'read_crm_lead_context',
      JSON.stringify({ id: `client-${index}`, section: 'notes' }),
      { ok: false, code: 'UNAVAILABLE', retryable: false },
    );
    for (let call = 0; call < 12; call++)
      trail.record('search_crm_leads', JSON.stringify({ q: `Client ${index}`, limit: 10 }), {
        ok: true,
        data: {
          items: Array.from({ length: 10 }, (_, row) => ({
            value: createHash('sha256').update(`large:${index}:${call}:${row}`).digest('hex'),
          })),
        },
      });
    receipt.history = trail.snapshot();
    receipt.activity = trail.activity;
    receipt.preparedAt = new Date(memory.now() + index).toISOString();
    receipt.displayedRecords =
      index === 0 ? [{ kind: 'warehouse', id: 105, position: 2 }] : undefined;
    return { text, receipt };
  });
  assert.ok(
    contextTokens(
      replies.map((reply) => projectToolReply(historicalReply(reply, memory.now())!).content),
    ) > 6000,
  );
  await memory.context.prepare(...memory.turn(1, '/pins'));
  memory.add(2, { role: 'user', content: 'Read Client A and separately describe warehouse105.' });
  memory.add(3, { role: 'assistant', content: PRIVATE_HISTORY_REPLY, protectedReply: replies[0]! });
  memory.add(4, {
    role: 'user',
    content: 'Switch to Client B lab; 5000 to10000sqft shed, ground floor. Give3options.',
  });
  memory.add(5, { role: 'assistant', content: PRIVATE_HISTORY_REPLY, protectedReply: replies[1]! });
  const before = await memory.context.prepare(...memory.turn(6, 'Pause for the count'));
  const originalIds = businessRecall(before!.history, run, memory.now()).targets;
  for (let n = 6; n < 48; n++) memory.add(n, { role: 'user', content: `Unrelated exchange ${n}` });
  await memory.context.prepare(...memory.turn(48, 'Continue'));
  const restored = await memory
    .create()
    .prepare(...memory.turn(49, 'Back to Client B second option'));
  const recall = businessRecall(restored!.history, run, memory.now());
  assert.deepEqual(recall.targets, originalIds);
  const projected = recall.messages
    .filter((message) => message.content.startsWith(BUSINESS_HISTORY_PREFIX))
    .map((message) => JSON.parse(message.content.slice(BUSINESS_HISTORY_PREFIX.length)));
  assert.equal(projected.length, 2);
  assert.equal(
    projected[0].original_request,
    'Read Client A and separately describe warehouse105.',
  );
  assert.match(projected[1].original_request, /Client B lab/);
  assert.deepEqual(
    projected.map((value) => value.reply),
    replies.map((reply) => reply.text),
  );
  assert.ok(projected.every((value) => value.tool_activity.length === 13));
  assert.ok(projected.every((value) => value.tool_activity[0].code === 'UNAVAILABLE'));
  assert.ok(
    projected.some((value) =>
      value.tool_activity.some(
        (activity: any) => activity.resultOmitted && activity.result === undefined,
      ),
    ),
  );
  const reads = fixture.state.calls.length;
  assert.equal(
    (
      await recall.execute(
        JSON.stringify({ turn_id: recall.targets[1]!.turn_id, positions: [2] }),
        signal(),
      )
    ).code,
    'SELECTION_NOT_FOUND',
  );
  assert.equal(
    fixture.state.calls.length,
    reads,
    'failed Client B answer cannot borrow Client A option2',
  );
  assert.equal(businessRecall(restored!.history, undefined, memory.now()).available, false);
});

test('history-only replies recheck current identity at delivery and cannot claim refreshed evidence', async () => {
  const { fixture, history, run } = await setup();
  businessRecall(history, run);
  const receipt = run.delivery()!;
  assert.ok(toolDeliverySchema.safeParse(receipt).success);
  assert.equal(await fixture.service.canDeliver(trusted.key, receipt, signal()), true);
  const fresh = (await fixture.service.openTools(trusted, signal())).run!;
  const recalled = await executeRecall(
    businessRecall(
      [{ role: 'assistant', content: PRIVATE_HISTORY_REPLY, protectedReply: { text, receipt } }],
      fresh,
    ),
    '{}',
    signal(),
  );
  assert.equal(recalled.previous_reply_verified, false);
  assert.deepEqual(recalled.fresh_evidence, []);
  fixture.state.active = false;
  assert.equal(await fixture.service.canDeliver(trusted.key, receipt, signal()), false);
  assert.equal(
    toolDeliverySchema.safeParse({ ...receipt, historicalOnly: undefined }).success,
    false,
  );
});

test('generation failure retains completed read attempts without claiming success for the answer', async () => {
  const fixture = createSalesFixture();
  let steps = 0;
  const model: TextModel = {
    async complete(request) {
      const planned = planningResult(request);
      if (planned) return planned;
      throw new Error('Synthetic model failure');
    },
    startToolSession() {
      return {
        async next() {
          if (steps++ === 0)
            return {
              text: '',
              calls: [
                {
                  id: 'read',
                  name: 'read_crm_lead',
                  arguments: JSON.stringify({ id: FIXTURE_LEAD_ID }),
                },
              ],
              inputTokens: 1,
              outputTokens: 1,
            };
          throw new Error('Synthetic model failure');
        },
        accept() {},
      };
    },
  };
  const service = new AssistantService(
    { model: 'fixture', timeoutMs: 10000 },
    model,
    undefined,
    undefined,
    undefined,
    fixture.service,
  );
  const result = await service.prepare(
    {
      chatId: FIXTURE_JID,
      messageId: 'failed-answer',
      text: 'Pull the Acme CRM request.',
      sentAtMs: Date.now(),
      isGroup: false,
      fromMe: false,
      mentionsBot: false,
    },
    signal(),
    trusted,
  );
  assert.equal(result.trace.outcome, 'unavailable');
  const receipt = toolDeliverySchema.parse(result.businessEvidence);
  assert.equal(receipt.historicalOnly, true);
  assert.deepEqual(receipt.checks, []);
  assert.equal(receipt.activity?.[0]?.status, 'succeeded');
  assert.deepEqual(receipt.activity?.[0]?.arguments, { id: FIXTURE_LEAD_ID });
  assert.equal(await fixture.service.canDeliver(trusted.key, receipt, signal()), true);
});

test('planner, worker, formatter and reviewer retain the earlier CRM answer beyond their ordinary tail', async () => {
  const { fixture, history } = await setup();
  history.push(
    ...Array.from({ length: 12 }, (_, i) => ({ role: 'user' as const, content: `Aside ${i}` })),
  );
  const stages = new Set<string>();
  const check = (stage: string, messages: ChatMessage[]) => {
    stages.add(stage);
    assert.ok(
      JSON.stringify(messages).includes('30,000 sq ft'),
      `${stage} lost the delivered answer`,
    );
    assert.ok(JSON.stringify(messages).includes(BUSINESS_HISTORY_PREFIX.trim()));
  };
  const model: TextModel = {
    startToolSession(request) {
      check('worker', request.messages);
      return {
        async next() {
          return {
            text: 'Earlier I showed the budget as market rate.',
            calls: [],
            inputTokens: 1,
            outputTokens: 1,
          };
        },
        accept() {},
      };
    },
    async complete(request) {
      check(request.stage, request.messages);
      return (
        planningResult(request) ?? {
          text:
            request.stage === 'verifier'
              ? '{"supported":true,"feedback":""}'
              : 'Earlier I showed the budget as market rate.',
          inputTokens: 1,
          outputTokens: 1,
        }
      );
    },
  };
  const service = new AssistantService(
    { model: 'fixture', timeoutMs: 10000 },
    model,
    undefined,
    undefined,
    async () => history,
    fixture.service,
  );
  const before = fixture.state.calls.length;
  const result = await service.prepare(
    {
      chatId: FIXTURE_JID,
      messageId: 'follow-up',
      text: 'What budget did you show for that RFQ?',
      sentAtMs: Date.now(),
      isGroup: false,
      fromMe: false,
      mentionsBot: false,
    },
    signal(),
    trusted,
  );
  assert.equal(result.trace.outcome, 'completed');
  assert.match(result.text, /market rate/);
  assert.equal(fixture.state.calls.length, before);
  assert.ok(['converser', 'planner', 'worker', 'verifier'].every((stage) => stages.has(stage)));
  assert.equal(
    await fixture.service.canDeliver(trusted.key, result.businessEvidence, signal()),
    true,
  );
});
