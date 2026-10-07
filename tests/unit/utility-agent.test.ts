/** Tools participate in the real graph with synthetic models/sources only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planningResult } from '../fixtures/planning-model.js';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { UtilityToolRun } from '../../src/modules/assistant/utility-tools.js';
import { businessRecall } from '../../src/modules/assistant/business-recall.js';
import { toolDeliverySchema } from '../../src/modules/assistant/tool-evidence.js';
import type {
  ModelRequest,
  TextModel,
  ToolSessionRequest,
} from '../../src/modules/assistant/assistant.types.js';

const now = Date.parse('2026-10-03T04:00:00Z');
const signal = () => AbortSignal.timeout(5000);
const trusted = { key: { remoteJid: FIXTURE_JID }, runId: 'utilities' };
const message = {
  chatId: FIXTURE_JID,
  messageId: 'utilities',
  text: 'Research Acme and calculate 20000 times 22.',
  fromMe: false,
  isGroup: false,
  mentionsBot: false,
  sentAtMs: now,
};
const response = (text: string) => ({ text, inputTokens: 1, outputTokens: 1 });

function model(calls: Array<{ name: string; args: object }>) {
  const requests: ModelRequest[] = [],
    sessions: ToolSessionRequest[] = [],
    outputs: unknown[] = [];
  const text =
    'The calculated amount is 440000. Public company information: https://example.com/company';
  const instance: TextModel = {
    async complete(request) {
      requests.push(request);
      return (
        planningResult(request) ??
        response(
          request.stage === 'verifier'
            ? JSON.stringify({ supported: true, feedback: '', repair: 'none' })
            : text,
        )
      );
    },
    startToolSession(request) {
      sessions.push(request);
      let index = 0;
      return {
        async next(remaining) {
          const call = remaining > 0 ? calls[index++] : undefined;
          return {
            ...response(call ? '' : text),
            calls: call
              ? [{ id: `call-${index}`, name: call.name, arguments: JSON.stringify(call.args) }]
              : [],
          };
        },
        accept(_id, output) {
          outputs.push(output);
        },
      };
    },
  };
  return { instance, requests, sessions, outputs };
}

test('search, read and calculate are advertised and independently grounded through formatter/verifier', async () => {
  const fixture = createSalesFixture(() => now);
  const fake = model([
    { name: 'web_search', args: { query: 'Acme' } },
    { name: 'read_webpage', args: { url: 'https://example.com/company' } },
    { name: 'calculate', args: { expression: '20000*22' } },
  ]);
  let providerCalls = 0;
  const assistant = new AssistantService(
    { model: 'synthetic', timeoutMs: 5000, tavilyApiKey: 'fixture-secret' },
    fake.instance,
    undefined,
    undefined,
    undefined,
    fixture.service,
    {
      now: () => now,
      utilityFetch: async (url) => {
        providerCalls++;
        return Response.json(
          String(url).endsWith('/search')
            ? {
                results: [
                  {
                    title: 'Acme',
                    url: 'https://example.com/company',
                    content: 'Public company description.',
                  },
                ],
              }
            : {
                results: [
                  { url: 'https://example.com/company', raw_content: 'Public company details.' },
                ],
                failed_results: [],
              },
        );
      },
    },
  );
  const reply = await assistant.prepare(message, signal(), trusted);
  assert.equal(reply.trace.outcome, 'completed');
  const receipt = toolDeliverySchema.parse(reply.businessEvidence);
  assert.equal(receipt.historicalOnly, true);
  assert.deepEqual(receipt.checks, []);
  assert.deepEqual(
    receipt.history?.activity.map((item) => item.tool),
    ['web_search', 'read_webpage', 'calculate'],
  );
  assert.deepEqual(receipt.history?.activity[2]?.arguments, { expression: '20000*22' });
  assert.equal((receipt.history?.activity[2]?.result as { value: string }).value, '440000');
  const fresh = (await fixture.service.openTools(trusted, signal())).run!;
  const history = businessRecall(
    [
      {
        role: 'assistant',
        content: '[protected]',
        protectedReply: {
          text: reply.text,
          receipt,
        },
      },
    ],
    fresh,
    now,
  );
  assert.match(history.messages[0]!.content, /440000/);
  assert.match(history.messages[0]!.content, /Public company details/);
  assert.ok(!JSON.stringify(receipt).includes('fixture-secret'));
  assert.equal(providerCalls, 2);
  assert.equal(fixture.state.calls.length, 0);
  assert.equal(fake.sessions[0]!.tools.length, 20);
  for (const stage of ['formatter', 'verifier']) {
    const input = JSON.parse(
      fake.requests.find((request) => request.stage === stage)!.messages[0]!.content,
    );
    assert.equal(input.utility_evidence.length, 3);
    assert.equal(input.utility_evidence[2].result.value, '440000');
    assert.equal(input.utility_evidence[0].result.results[0].url, 'https://example.com/company');
    assert.deepEqual(input.evidence, []);
  }
  assert.equal(JSON.stringify(fake.requests).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(fake.sessions).includes('fixture-secret'), false);
});

test('group and denied callers do not discover or execute harness utilities', async () => {
  for (const chatId of ['unknown@s.whatsapp.net', 'group@g.us']) {
    const fixture = createSalesFixture(() => now);
    const fake = model([]);
    let names: string[] = [];
    const assistant = new AssistantService(
      { model: 'synthetic', timeoutMs: 5000, tavilyApiKey: 'fixture' },
      fake.instance,
      undefined,
      undefined,
      undefined,
      fixture.service,
      {
        now: () => now,
        observeContext: (context) => {
          names = context.tools.map((tool) => tool.name);
        },
        utilityFetch: async () => {
          throw new Error('No provider call allowed');
        },
      },
    );
    await assistant.prepare({ ...message, chatId, isGroup: chatId.endsWith('@g.us') }, signal(), {
      ...trusted,
      key: { remoteJid: chatId },
    });
    assert.deepEqual(names, []);
  }
});

test('utilities share the business proposal budget and reject binding changes before accepting results', async () => {
  const fixture = createSalesFixture(() => now);
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  const utilities = new UtilityToolRun('fixture', async () => {
    fixture.state.employeeId = 24;
    return Response.json({
      results: [{ title: 'Acme', url: 'https://example.com', content: 'Public' }],
    });
  });
  const before = run.remaining;
  assert.equal(
    (
      await run.executeUtility(
        (authorize) => utilities.execute('calculate', '{"expression":"1+1"}', signal(), authorize),
        signal(),
      )
    ).ok,
    true,
  );
  assert.equal(run.remaining, before - 1);
  const failed = await run.executeUtility(
    (authorize) => utilities.execute('web_search', '{"query":"Acme"}', signal(), authorize),
    signal(),
  );
  assert.equal(failed.code, 'AUTH_REQUIRED');
  assert.equal(run.blocked, true);
  assert.equal(utilities.evidence.length, 1);
  assert.equal(utilities.usedWeb, false);
  let called = false;
  await run.executeUtility(async () => {
    called = true;
    return {};
  }, signal());
  assert.equal(called, false);
});

test('mixed answers retain business receipts and recall never certifies stale public research', async () => {
  const fixture = createSalesFixture(() => now);
  const fake = model([
    { name: 'get_context', args: {} },
    { name: 'web_search', args: { query: 'Acme' } },
  ]);
  const assistant = new AssistantService(
    { model: 'synthetic', timeoutMs: 5000, tavilyApiKey: 'fixture' },
    fake.instance,
    undefined,
    undefined,
    undefined,
    fixture.service,
    {
      now: () => now,
      utilityFetch: async () =>
        Response.json({
          results: [{ title: 'Acme', url: 'https://example.com', content: 'Public' }],
        }),
    },
  );
  const reply = await assistant.prepare(message, signal(), trusted);
  const receipt = toolDeliverySchema.parse(reply.businessEvidence);
  assert.equal(receipt.publicWebUsed, true);
  assert.deepEqual(
    receipt.checks.map((check) => check.tool),
    ['get_context'],
  );
  assert.equal(await fixture.service.canDeliver(trusted.key, receipt, signal()), true);
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  const recall = businessRecall(
    [
      {
        role: 'assistant',
        content: 'Protected reply',
        protectedReply: { text: reply.text, receipt },
      },
    ],
    run,
    now,
  );
  const recalled = await recall.execute(JSON.stringify(recall.targets[0]), signal());
  assert.equal(recalled.ok, true);
  assert.equal(recalled.public_web_requires_refresh, true);
  assert.equal(recalled.previous_reply_verified, false);
  assert.equal(recalled.previous_reply, undefined);
  assert.equal((recalled.fresh_evidence as unknown[]).length, 1);
});
