/** Full assistant graph recovery with synthetic provider responses and live fictional sources. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import { planningResult } from '../fixtures/planning-model.js';
import {
  AssistantService,
  UNAVAILABLE_REPLY,
} from '../../src/modules/assistant/assistant.service.js';
import {
  CheckpointError,
  type AgentCheckpointBegin,
  type AgentCheckpointMetadata,
  type AgentCheckpointSession,
  type AgentCheckpointStore,
} from '../../src/modules/assistant/checkpoint.types.js';
import { replayModelResponse } from '../../src/modules/assistant/model-replay.js';
import type {
  ModelRequest,
  ModelResult,
  TextModel,
  ToolSessionRequest,
} from '../../src/modules/assistant/assistant.types.js';
import type {
  GreetingCandidate,
  TrustedReplyContext,
} from '../../src/modules/greetings/greeting.types.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fixedTime = Date.parse('2026-10-03T08:00:00Z');
const message: GreetingCandidate = {
  chatId: FIXTURE_JID,
  senderId: FIXTURE_JID,
  messageId: 'synthetic-message',
  sentAtMs: fixedTime,
  fromMe: false,
  isGroup: false,
  mentionsBot: false,
  text: 'Check the warehouse filters and tell me the recorded warehouse count.',
};
const trusted: TrustedReplyContext = {
  runId: 'synthetic-durable-job',
  key: { remoteJid: FIXTURE_JID },
  checkpointLease: { leaseToken: 'synthetic-lease' },
};
const modelResult = (text: string): ModelResult => ({ text, inputTokens: 1, outputTokens: 1 });

/** Durable serialization, exact request matching and suffix invalidation, without a DB. */
class Store implements AgentCheckpointStore, AgentCheckpointSession {
  metadata!: AgentCheckpointMetadata;
  binding?: unknown;
  readonly rows = new Map<number, { request: unknown; response: unknown }>();
  readonly policies = new Map<string, unknown>();
  readonly consumed = { tool: 0, web: 0, bytes: 0 };
  readonly begins: AgentCheckpointBegin[] = [];
  readonly reused: number[] = [];
  failure?: CheckpointError;
  async begin(input: AgentCheckpointBegin) {
    this.begins.push(clone(input));
    if (!this.metadata)
      this.metadata = {
        requestTimeMs: input.requestTimeMs,
        startedAtMs: input.startedAtMs ?? Date.now(),
        deadlineAtMs: input.deadlineAtMs,
      };
    if (this.binding && !isDeepStrictEqual(this.binding, clone(input.binding))) this.rows.clear();
    this.binding = clone(input.binding);
    return this;
  }
  async read<T>(index: number, request: unknown): Promise<T | undefined> {
    if (this.failure) throw this.failure;
    const row = this.rows.get(index);
    if (row && isDeepStrictEqual(row.request, clone(request))) {
      this.reused.push(index);
      return clone(row.response) as T;
    }
    for (const key of this.rows.keys()) if (key >= index) this.rows.delete(key);
    return undefined;
  }
  async save(index: number, request: unknown, response: unknown) {
    if (this.failure) throw this.failure;
    this.rows.set(index, { request: clone(request), response: clone(response) });
  }
  async policy<T>(key: string, update?: (previous: T | undefined) => T) {
    if (this.failure) throw this.failure;
    if (update) this.policies.set(key, clone(update(this.policies.get(key) as T | undefined)));
    const value = this.policies.get(key);
    return value === undefined ? undefined : (clone(value) as T);
  }
  async consume(resource: 'tool' | 'web' | 'bytes', amount: number) {
    if (this.failure) throw this.failure;
    this.consumed[resource] += amount;
    return this.consumed[resource] <= { tool: 28, web: 6, bytes: 1000000 }[resource];
  }
}

function replayModel(options: { abort?: AbortController; afterAccepted?: number } = {}) {
  const generated: string[] = [];
  const nextRequests: unknown[] = [];
  const accepted: unknown[] = [];
  const model: TextModel = {
    async complete(request: ModelRequest, signal) {
      signal?.throwIfAborted();
      const response = await replayModelResponse({ kind: 'complete', request }, async () => {
        generated.push(request.stage);
        const planning = planningResult(request);
        if (planning) return planning;
        if (request.stage === 'verifier')
          return modelResult(JSON.stringify({ supported: true, feedback: '', repair: 'format' }));
        const body = JSON.parse(request.messages[0]!.content) as { draft: string };
        return modelResult(body.draft);
      });
      signal?.throwIfAborted();
      return response.response;
    },
    startToolSession(initial: ToolSessionRequest) {
      let step = 0;
      const outputs: Array<{ id: string; output: Record<string, unknown> }> = [];
      return {
        async next(remainingCalls, signal) {
          signal.throwIfAborted();
          const request = clone({ kind: 'tool-step', initial, outputs, step, remainingCalls });
          nextRequests.push(request);
          const response = await replayModelResponse(request, async () => {
            generated.push(`worker:${step}`);
            const name =
              remainingCalls > 0 ? ['warehouse_filters', 'warehouse_summary'][step] : undefined;
            const summary = outputs.find(
              (item) => (item.output.data as { total?: number } | undefined)?.total !== undefined,
            );
            const total = (summary?.output.data as { total: number } | undefined)?.total;
            return {
              ...modelResult(
                name
                  ? ''
                  : total === undefined
                    ? "I couldn't load a warehouse count for this account."
                    : `${total} recorded warehouses. Confirm current availability with the owner.`,
              ),
              calls: name ? [{ id: `call-${step}`, name, arguments: '{}' }] : [],
            };
          });
          signal.throwIfAborted();
          step++;
          return response.response;
        },
        accept(id, output) {
          outputs.push({ id, output: clone(output) as Record<string, unknown> });
          accepted.push(clone(output));
          if (options.afterAccepted === outputs.length)
            options.abort!.abort(new Error('synthetic disconnect'));
        },
      };
    },
  };
  return { model, generated, nextRequests, accepted };
}

function setup() {
  let clock = fixedTime;
  const fixture = createSalesFixture(() => clock);
  const store = new Store();
  const service = (model: TextModel, timeoutMs = 120000) =>
    new AssistantService(
      { model: 'offline-synthetic-provider', timeoutMs },
      model,
      undefined,
      undefined,
      undefined,
      fixture.service,
      { checkpoints: store, now: () => clock },
    );
  return {
    fixture,
    store,
    service,
    advance: () => {
      clock += 60000;
    },
  };
}

test('new assistant instance resumes completed steps after one or two live reads, without reusing source authorization', async (t) => {
  for (const count of [1, 2])
    await t.test(`disconnect after ${count} accepted read(s)`, async () => {
      const h = setup();
      const abort = new AbortController();
      const first = replayModel({ abort, afterAccepted: count });
      await assert.rejects(
        h.service(first.model).prepare(message, abort.signal, trusted),
        /synthetic disconnect/,
      );
      assert.equal(h.fixture.state.calls.length, count);
      assert.equal(h.store.rows.size, count + 2);
      const originalDeadline = h.store.metadata.deadlineAtMs;
      h.advance();
      const resumed = replayModel();
      const reply = await h
        .service(resumed.model)
        .prepare(message, AbortSignal.timeout(5000), trusted);
      assert.equal(reply.trace.outcome, 'completed');
      assert.match(reply.text, /9 recorded warehouses/);
      assert.ok(reply.businessEvidence);
      assert.equal(reply.trace.replayedSteps, count + 2);
      assert.equal(resumed.generated.includes('converser'), false);
      assert.equal(resumed.generated.includes('planner'), false);
      assert.equal(
        h.fixture.state.calls.length,
        count + 2,
        'each recovered source query executes again',
      );
      assert.equal(
        h.store.consumed.tool,
        count + 2,
        'recovery cannot reset the durable tool budget',
      );
      assert.equal(h.store.metadata.deadlineAtMs, originalDeadline);
      assert.equal(
        h.store.metadata.requestTimeMs,
        fixedTime,
        'relative dates remain tied to the original request',
      );
      assert.equal(h.store.begins[1]!.requestTimeMs, fixedTime + 60000);
      const oldSource = h.fixture.state.evidence[0]!.result;
      const currentSource = h.fixture.state.evidence[count]!.result;
      assert.notEqual(oldSource.meta.requestId, currentSource.meta.requestId);
      assert.notEqual(oldSource.meta.generatedAt, currentSource.meta.generatedAt);
    });
});

test('fresh changed source data invalidates the dependent model suffix, while earlier planning remains reusable', async () => {
  const h = setup();
  const first = replayModel();
  const before = await h.service(first.model).prepare(message, AbortSignal.timeout(5000), trusted);
  assert.match(before.text, /9 recorded warehouses/);
  h.advance();
  h.fixture.state.warehouseCount = 12;
  const second = replayModel();
  const after = await h.service(second.model).prepare(message, AbortSignal.timeout(5000), trusted);
  assert.match(after.text, /12 recorded warehouses/);
  assert.equal(after.trace.replayedSteps, 4);
  assert.deepEqual(second.generated, ['worker:2', 'formatter', 'verifier']);
  assert.equal(h.fixture.state.calls.length, 4);
  assert.equal(h.store.consumed.tool, 4);
});

test('changed tool schema or employee authorization invalidates prior model authority', async (t) => {
  for (const change of ['schema', 'identity'] as const)
    await t.test(change, async () => {
      const h = setup();
      const initial = replayModel();
      await h.service(initial.model).prepare(message, AbortSignal.timeout(5000), trusted);
      if (change === 'schema') {
        const tool = h.fixture.state.tools.find((item) => item.name === 'warehouse_summary')!;
        tool.inputSchema = {
          ...tool.inputSchema,
          description: 'Updated synthetic schema contract.',
        };
      } else h.fixture.state.employeeId = 24;
      const resumed = replayModel();
      const reply = await h
        .service(resumed.model)
        .prepare(message, AbortSignal.timeout(5000), trusted);
      assert.equal(reply.trace.replayedSteps, undefined);
      assert.ok(resumed.generated.includes('converser'));
      assert.ok(resumed.generated.includes('planner'));
      if (change === 'identity') {
        assert.equal(
          h.fixture.state.calls.length,
          2,
          'new unauthorized employee never inherits prior reads',
        );
        assert.equal(reply.businessEvidence, undefined);
        assert.doesNotMatch(reply.text, /9 recorded/);
      } else assert.match(reply.text, /9 recorded warehouses/);
    });
});

test('original deadline expiry skips provider and source work; checkpoint failures propagate instead of producing a fallback', async () => {
  const h = setup();
  const initial = replayModel();
  await h.service(initial.model).prepare(message, AbortSignal.timeout(5000), trusted);
  h.store.metadata.deadlineAtMs = Date.now() - 1;
  const expired = replayModel();
  const reply = await h.service(expired.model).prepare(message, AbortSignal.timeout(5000), trusted);
  assert.equal(reply.text, UNAVAILABLE_REPLY);
  assert.equal(reply.trace.failureCode, 'DEADLINE_EXCEEDED');
  assert.deepEqual(expired.generated, []);
  assert.equal(h.fixture.state.calls.length, 2);
  h.store.metadata.deadlineAtMs = Date.now() + 120000;
  h.store.failure = new CheckpointError();
  const broken = replayModel();
  await assert.rejects(
    h.service(broken.model).prepare(message, AbortSignal.timeout(5000), trusted),
    CheckpointError,
  );
  assert.deepEqual(broken.generated, []);
});
