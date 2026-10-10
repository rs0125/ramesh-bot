/** LangSmith tracing with an in-memory client: span tree, gate spans, and outage isolation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RunTree } from 'langsmith/run_trees';
import { Client } from 'langsmith';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import type { TextModel } from '../../src/modules/assistant/assistant.types.js';
import type { GreetingCandidate } from '../../src/modules/greetings/greeting.types.js';
import {
  traceGate,
  traceTurn,
  tracedModel,
  tracingEnabled,
} from '../../src/infrastructure/observability/tracing.js';

const message: GreetingCandidate = {
  chatId: 'fake@s.whatsapp.net',
  senderId: 'fake@s.whatsapp.net',
  messageId: 'm1',
  sentAtMs: Date.now(),
  isGroup: false,
  fromMe: false,
  mentionsBot: false,
  text: 'hey',
};
const config = { model: 'gpt-5.6-terra', timeoutMs: 2000 };
const model: TextModel = {
  async complete(request) {
    return { text: `${request.stage} reply`, inputTokens: 1, outputTokens: 1 };
  },
};
// The shared client is private SDK state; tests replace it to capture runs offline.
const setSharedClient = (client: Client | undefined) => {
  (RunTree as unknown as { sharedClient?: Client }).sharedClient = client;
};
type Recorded = { id: string; name: string; parent_run_id?: string };
function memoryClient() {
  const runs = new Map<string, Recorded>();
  const client = {
    tracingMode: undefined,
    async createRun(run: Recorded) {
      runs.set(run.id, { id: run.id, name: run.name, parent_run_id: run.parent_run_id });
    },
    async updateRun() {},
  };
  return { runs, client: client as unknown as Client };
}
const settle = async () => {
  await awaitAllCallbacks();
  await new Promise((resolve) => setTimeout(resolve, 50));
};

test('tracing is a no-op unless LANGSMITH_TRACING=true', async () => {
  const previous = process.env.LANGSMITH_TRACING;
  delete process.env.LANGSMITH_TRACING;
  delete process.env.LANGCHAIN_TRACING_V2;
  try {
    assert.equal(tracingEnabled(), false);
    assert.equal(tracedModel(model), model);
    assert.equal(
      await traceTurn(
        {},
        { metadata: {}, tags: [] },
        async () => 7,
        () => ({}),
      ),
      7,
    );
  } finally {
    if (previous !== undefined) process.env.LANGSMITH_TRACING = previous;
  }
});

test('a turn records a root span with graph nodes, model calls and gate spans nested under it', async () => {
  process.env.LANGSMITH_TRACING = 'true';
  process.env.LANGSMITH_API_KEY = 'test-only';
  const memory = memoryClient();
  setSharedClient(memory.client);
  try {
    const traced = tracedModel(model);
    assert.notEqual(traced, model);
    assert.equal(tracedModel(traced), traced, 'wrapping is idempotent');
    const reply = await new AssistantService(config, model).prepare(message);
    assert.equal(reply.text, 'formatter reply');
    await traceTurn(
      { input: 'gate' },
      { metadata: {}, tags: [] },
      async () => {
        traceGate({ stage: 'executor', code: 'BATCH_NOT_ALLOWED', blocking: false });
      },
      () => ({}),
    );
    await settle();
    const runs = [...memory.runs.values()];
    const named = (name: string) => runs.filter((run) => run.name === name);
    const ancestors = (run: Recorded) => {
      const chain: string[] = [];
      for (let parent = run.parent_run_id; parent; parent = memory.runs.get(parent)?.parent_run_id)
        chain.push(memory.runs.get(parent)?.name ?? '?');
      return chain;
    };
    assert.equal(named('ramesh.turn').length, 2);
    for (const stage of ['converser', 'formatter']) {
      const [call] = named(`model.${stage}`);
      assert.ok(call, `model.${stage} span`);
      const chain = ancestors(call!);
      assert.equal(chain[0], stage, `model.${stage} nests under its graph node`);
      assert.equal(chain.at(-1), 'ramesh.turn');
    }
    const [gate] = named('gate:BATCH_NOT_ALLOWED');
    assert.ok(gate);
    assert.deepEqual(ancestors(gate!), ['ramesh.turn']);
  } finally {
    setSharedClient(undefined);
    delete process.env.LANGSMITH_TRACING;
  }
});

test('an unreachable tracing endpoint never fails or delays a reply', async () => {
  process.env.LANGSMITH_TRACING = 'true';
  process.env.LANGSMITH_API_KEY = 'test-only';
  setSharedClient(
    new Client({
      apiUrl: 'http://127.0.0.1:9',
      apiKey: 'test-only',
      autoBatchTracing: false,
      callerOptions: { maxRetries: 0 },
    }),
  );
  // The SDK reports upload failures on the console; capture them instead of printing.
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const agent = new AssistantService(config, model);
    const started = Date.now();
    const reply = await agent.prepare(message);
    assert.equal(reply.text, 'formatter reply');
    assert.equal(reply.trace.outcome, 'completed');
    assert.ok(Date.now() - started < 1000, 'tracing failures stay in the background');
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    console.error = original;
    setSharedClient(undefined);
    delete process.env.LANGSMITH_TRACING;
  }
});
