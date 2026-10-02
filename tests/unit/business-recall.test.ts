import { planningResult } from '../fixtures/planning-model.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import { businessRecall, RECALL_TOOL } from '../../src/modules/assistant/business-recall.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';
import { dealDisplayFacts, dealDisplayIssues } from '../../src/modules/assistant/deal-display.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import type {
  ChatMessage,
  TextModel,
  ToolSessionRequest,
} from '../../src/modules/assistant/assistant.types.js';
const trusted = { key: { remoteJid: FIXTURE_JID }, runId: 'test' };
const signal = () => AbortSignal.timeout(5000);

async function setup() {
  const fixture = createSalesFixture();
  const original = (await fixture.service.openTools(trusted, signal())).run!;
  await original.execute('search_crm_leads', '{"view":"accessible","limit":10}', signal());
  const history: ChatMessage[] = [
    { role: 'user', content: 'Show our current deals.' },
    {
      role: 'assistant',
      content: PRIVATE_HISTORY_REPLY,
      protectedReply: {
        text: '1. Fixture Acme Storage\n2. Fixture Beacon Retail',
        receipt: original.delivery(),
      },
    },
  ];
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  return { fixture, history, run, original };
}

test('recall restores selection/order only after fresh registered reads; metadata never enters messages', async () => {
  const { fixture, history, run } = await setup();
  const recall = businessRecall(history, run);
  assert.equal(recall.available, true);
  assert.ok(!JSON.stringify(recall.messages).includes('Fixture Acme'));
  assert.ok(!JSON.stringify(recall.messages).includes('protectedReply'));
  assert.match(recall.messages[1]!.content, /business turn 1/);
  const output = await recall.execute('{}', signal());
  assert.equal(output.previous_reply_verified, true);
  assert.equal(output.previous_reply, history[1]!.protectedReply!.text);
  assert.equal(fixture.state.calls.length, 2);
  assert.equal(run.evidence.length, 1);
  assert.equal(await fixture.service.canDeliver(trusted.key, run.delivery(), signal()), true);
});

test('changed results and revoked access cannot reveal the old answer', async () => {
  const { fixture, history, run } = await setup();
  fixture.state.mutate = (result, tool) => {
    if (tool === 'search_crm_leads') (result.data.items as any[])[0].name = 'New permitted label';
  };
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.equal(output.previous_reply_verified, false);
  assert.equal(output.previous_reply, undefined);
  assert.ok(!JSON.stringify(output).includes('Fixture Acme'));
  fixture.state.active = false;
  const denied = await businessRecall(history, run).execute('{}', signal());
  assert.equal(denied.code, 'ACCESS_DENIED');
  assert.ok(!JSON.stringify(denied).includes('Fixture Acme'));
});

test('cross-employee, expired-window and legacy receipts never become recallable', async () => {
  const { history, run } = await setup();
  assert.equal(businessRecall(history, undefined).available, false);
  const changed = structuredClone(history);
  (changed[1]!.protectedReply!.receipt as any).employeeId++;
  assert.equal(businessRecall(changed, run).available, false);
  assert.equal(businessRecall(history, run, Date.now() + 86401000).available, false);
  changed[1]!.protectedReply!.receipt = { kind: 'legacy' };
  assert.equal(businessRecall(changed, run).available, false);
});

test('recall reuses current evidence and does not let tool arguments choose an identity', async () => {
  const { fixture, history, run } = await setup();
  await run.execute('search_crm_leads', '{"view":"accessible","limit":10}', signal());
  const before = fixture.state.calls.length;
  const recall = businessRecall(history, run);
  assert.equal((await recall.execute('{"employeeId":1}', signal())).code, 'INVALID_ARGUMENTS');
  assert.equal((await recall.execute('{}', signal())).previous_reply_verified, true);
  assert.equal(fixture.state.calls.length, before);
  assert.equal((await recall.execute('{}', signal())).code, 'ALREADY_RECALLED');
});

test('native dates use IST, missing dates stay missing and deal UUIDs fail presentation checks', async () => {
  const { original } = await setup();
  const facts = dealDisplayFacts(original.evidence);
  assert.equal(facts[1]?.created, '13 Sept 2026');
  (original.evidence[0]!.result.data.items as any[])[0].source_created_at = null;
  (original.evidence[0]!.result.data.items as any[])[0].last_polled_at = new Date().toISOString();
  assert.equal(dealDisplayFacts(original.evidence)[0]?.created, 'Not recorded');
  assert.ok(dealDisplayIssues(`ID: ${facts[0]!.internal_id}`, original.evidence).length);
  assert.ok(dealDisplayIssues('Fixture Acme Storage', original.evidence).length);
  assert.ok(
    dealDisplayIssues('1. **Fixture Acme Storage**\nBengaluru warehouse', original.evidence).length,
  );
  assert.deepEqual(
    dealDisplayIssues(
      'I can draft a visit confirmation for Fixture Acme Storage, but cannot send it.',
      original.evidence,
    ),
    [],
  );
  assert.deepEqual(
    dealDisplayIssues('Warehouse 101: good area; availability needs checking.', original.evidence),
    [],
  );
});

test('graph keeps protected metadata out of every model request and exposes recall only to the bound employee', async () => {
  const { fixture, history } = await setup();
  const sessions: ToolSessionRequest[] = [];
  const model: TextModel = {
    startToolSession(request) {
      sessions.push(request);
      return {
        next: async () => ({ text: 'Hey!', calls: [], inputTokens: 1, outputTokens: 1 }),
        accept() {},
      };
    },
    async complete(request) {
      const planning = planningResult(request);
      if (planning) return planning;
      assert.ok(!JSON.stringify(request).includes('Fixture Acme'));
      assert.ok(!JSON.stringify(request).includes('protectedReply'));
      return {
        text: request.stage === 'verifier' ? '{"supported":true,"feedback":""}' : 'Hey!',
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  const assistant = new AssistantService(
    { model: 'fixture', timeoutMs: 5000 },
    model,
    undefined,
    undefined,
    async () => history,
    fixture.service,
  );
  const message = {
    messageId: 'chat',
    chatId: FIXTURE_JID,
    text: 'hey',
    fromMe: false,
    isGroup: false,
    mentionsBot: false,
    sentAtMs: Date.now(),
  };
  const before = fixture.state.calls.length;
  await assistant.prepare(message, signal(), trusted);
  assert.equal(fixture.state.calls.length, before);
  assert.ok(sessions[0]?.tools.some((t) => t.name === RECALL_TOOL));
  assert.ok(!JSON.stringify(sessions[0]?.messages).includes('Fixture Acme'));
  fixture.state.active = false;
  await assistant.prepare(message, signal(), trusted);
  assert.deepEqual(sessions[1]?.tools, []);
});
