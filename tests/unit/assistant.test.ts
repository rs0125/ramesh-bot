/** Real LangGraph orchestration with a model fake: isolation, cancellation, style and delivery-aware memory. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AssistantService,
  UNAVAILABLE_REPLY,
} from '../../src/modules/assistant/assistant.service.js';
import type { ModelRequest, TextModel } from '../../src/modules/assistant/assistant.types.js';
import type { GreetingCandidate } from '../../src/modules/greetings/greeting.types.js';
import { ConversationMemory } from '../../src/modules/assistant/conversation-memory.js';
import { loadAssistantConfig } from '../../src/config/assistant.js';

const message = (patch: Partial<GreetingCandidate> = {}): GreetingCandidate => ({
  chatId: 'fake@s.whatsapp.net',
  senderId: 'fake@s.whatsapp.net',
  messageId: 'm1',
  sentAtMs: Date.now(),
  isGroup: false,
  fromMe: false,
  mentionsBot: false,
  text: 'hey',
  ...patch,
});
const result = (text: string) => ({ text, inputTokens: 10, outputTokens: 5 });
function fake() {
  const calls: ModelRequest[] = [];
  const model: TextModel = {
    async complete(request) {
      calls.push(request);
      return result(
        request.stage === 'converser' ? 'I can help with that.' : 'Yes — I can help with that.',
      );
    },
  };
  return { model, calls };
}
const config = { model: 'gpt-5.6-terra', timeoutMs: 2000 };

test('both graph stages execute, formatter receives draft, and the final em-dash guard applies', async () => {
  const { model, calls } = fake();
  const agent = new AssistantService(config, model);
  const reply = await agent.prepare(message());
  assert.deepEqual(
    calls.map((call) => call.stage),
    ['converser', 'formatter'],
  );
  assert.equal(JSON.parse(calls[1]!.messages[0]!.content).draft, 'I can help with that.');
  assert.equal(reply.text, 'Yes, I can help with that.');
  assert.equal(reply.trace.outcome, 'completed');
  assert.equal(reply.trace.stages.length, 2);
});

test('unsent replies never enter memory; sent history is bounded and isolated by sender and audience', async () => {
  const { model, calls } = fake();
  const agent = new AssistantService(config, model);
  const original = message({
    isGroup: true,
    chatId: 'fake@g.us',
    senderId: 'alice@lid',
    text: 'My client is Kavya.',
  });
  await agent.prepare(original);
  const accepted = await agent.prepare({ ...original, messageId: 'm2', text: 'hello again' });
  assert.equal(calls[2]!.messages.length, 1, 'unsent first turn is absent');
  accepted.onSent?.();
  accepted.onSent?.();
  await agent.prepare({ ...original, messageId: 'm3', text: 'continue' });
  assert.equal(calls[4]!.messages.length, 3, 'commit is idempotent');
  await agent.prepare({ ...original, senderId: 'bob@lid' });
  assert.equal(calls[6]!.messages.length, 1);
  await agent.prepare(message({ senderId: 'alice@lid' }));
  assert.equal(calls[8]!.messages.length, 1);
  agent.clear(original);
  await agent.prepare(original);
  assert.equal(calls[10]!.messages.length, 1);
});

test('memory expires and evicts older conversations and complete turns', () => {
  let now = 0;
  const memory = new ConversationMemory(() => now, 100, 2);
  for (let i = 0; i < 20; i++) memory.remember('a', `q${i}`, `a${i}`);
  assert.equal(memory.get('a').length, 12);
  assert.equal(memory.get('a')[0]!.content, 'q14');
  memory.remember('b', 'q', 'a');
  memory.remember('c', 'q', 'a');
  assert.deepEqual(memory.get('a'), []);
  now = 101;
  assert.deepEqual(memory.get('b'), []);
  assert.deepEqual(memory.get('c'), []);
});

test('generation errors produce an honest fallback without committing hallucinated history', async () => {
  const agent = new AssistantService(config, {
    async complete() {
      throw new Error('secret provider body');
    },
  });
  const reply = await agent.prepare(message());
  assert.equal(reply.text, UNAVAILABLE_REPLY);
  assert.equal(reply.trace.outcome, 'unavailable');
  assert.equal(reply.onSent, undefined);
  assert.ok(!JSON.stringify(reply).includes('secret'));
});

test('disconnect cancellation aborts the model and never starts the formatter', async () => {
  const controller = new AbortController();
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let calls = 0;
  const agent = new AssistantService(config, {
    async complete(_request, signal) {
      calls++;
      start();
      return new Promise((_, reject) =>
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
      );
    },
  });
  const pending = agent.prepare(message(), controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending);
  assert.equal(calls, 1);
});

test('total deadline cancels a stalled model; oversized input never calls it', async () => {
  let calls = 0;
  const agent = new AssistantService(
    { ...config, timeoutMs: 20 },
    {
      async complete(_request, signal) {
        calls++;
        return new Promise((_, reject) =>
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
        );
      },
    },
  );
  assert.equal((await agent.prepare(message())).trace.outcome, 'unavailable');
  assert.equal(
    (await agent.prepare(message({ text: 'x'.repeat(6001) }))).trace.outcome,
    'input_rejected',
  );
  assert.equal(calls, 1);
});

test('Terra configuration is explicit, optional without a key, and bounded', () => {
  assert.equal(loadAssistantConfig({}), undefined);
  const configured = loadAssistantConfig({ OPENAI_API_KEY: 'test-only-key' });
  assert.equal(configured?.model, 'gpt-5.6-terra');
  assert.throws(() => loadAssistantConfig({ OPENAI_API_KEY: 'x', AGENT_TIMEOUT_MS: '999999' }));
  assert.throws(() => loadAssistantConfig({ OPENAI_API_KEY: 'x', AGENT_MAX_OUTPUT_TOKENS: '0' }));
});
