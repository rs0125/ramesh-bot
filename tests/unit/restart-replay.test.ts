/** Restart replay uses the real SDK with injected fetch only; no provider requests occur. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { OpenAITextModel } from '../../src/infrastructure/openai/text-model.js';
import {
  CheckpointError,
  type AgentCheckpointSession,
} from '../../src/modules/assistant/checkpoint.types.js';
import { bindReplayAuthority, withModelReplay } from '../../src/modules/assistant/model-replay.js';
import { MemoryUsageLedger } from '../../src/modules/usage/memory-ledger.js';
import { UsageMeter, type UsageEvent } from '../../src/modules/usage/usage-meter.js';
import { withUsageScope } from '../../src/modules/usage/usage-scope.js';
import { UtilityToolRun } from '../../src/modules/assistant/utility-tools.js';
import { ContextEngineError } from '../../src/modules/context-engine/context.types.js';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';

const config = {
  apiKey: 'synthetic-replay-key',
  model: 'fixture-replay-model',
  timeoutMs: 2000,
  maxOutputTokens: 20,
};
const request = {
  stage: 'converser' as const,
  instructions: 'Reply using the supplied fixture.',
  messages: [{ role: 'user' as const, content: 'Fixture question.' }],
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Simulate durable serialization and the store's ordered suffix invalidation contract. */
class FixtureCheckpoint implements AgentCheckpointSession {
  readonly metadata = {
    requestTimeMs: Date.UTC(2026, 9, 3, 8),
    startedAtMs: Date.UTC(2026, 9, 3, 8),
    deadlineAtMs: Date.UTC(2026, 9, 3, 8, 5),
  };
  readonly rows = new Map<number, { request: unknown; response: unknown }>();
  readonly reads: number[] = [];
  readonly saves: number[] = [];
  readonly policies = new Map<string, unknown>();
  readonly consumed = { tool: 0, web: 0, bytes: 0 };
  readonly limits = { tool: 72, web: 4, bytes: 600000 };
  consumeFailure?: Error;
  readFailure?: Error;
  saveFailure?: Error;
  onRead?: () => void;

  async read<T>(sequence: number, body: unknown): Promise<T | undefined> {
    this.reads.push(sequence);
    if (this.readFailure) throw this.readFailure;
    this.onRead?.();
    const row = this.rows.get(sequence);
    if (row && isDeepStrictEqual(row.request, copy(body))) return copy(row.response) as T;
    for (const key of this.rows.keys()) if (key >= sequence) this.rows.delete(key);
    return undefined;
  }

  async save(sequence: number, body: unknown, response: unknown): Promise<void> {
    if (this.saveFailure) throw this.saveFailure;
    this.saves.push(sequence);
    this.rows.set(sequence, { request: copy(body), response: copy(response) });
  }

  async consume(resource: 'tool' | 'web' | 'bytes', amount: number): Promise<boolean> {
    if (this.consumeFailure) throw this.consumeFailure;
    if (this.consumed[resource] + amount > this.limits[resource]) return false;
    this.consumed[resource] += amount;
    return true;
  }

  async policy<T>(key: string, update?: (current: T | undefined) => T): Promise<T | undefined> {
    if (update) this.policies.set(key, update(this.policies.get(key) as T | undefined));
    return this.policies.get(key) as T | undefined;
  }
}

function textResponse(text = 'Fixture answer.', id = 'fixture_response') {
  return Response.json({
    id,
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: `message_${id}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 3,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
  });
}

test('encrypted automatic compaction replays without repeating token counts or paid generation', async () => {
  const checkpoint = new FixtureCheckpoint();
  let counts = 0,
    responses = 0;
  const compact = {
    type: 'compaction',
    id: 'compact-fixture',
    encrypted_content: 'opaque-summary',
  };
  const model = new OpenAITextModel(
    { ...config, context: { maxInputTokens: 96000, compactThreshold: 64000 } },
    async (url) => {
      if (String(url).endsWith('/input_tokens')) {
        counts++;
        return Response.json({ input_tokens: 100, object: 'response.input_tokens' });
      }
      responses++;
      return responses === 1
        ? Response.json({
            id: 'first',
            object: 'response',
            status: 'completed',
            output: [
              compact,
              { type: 'function_call', call_id: 'c', name: 'read', arguments: '{}' },
            ],
          })
        : textResponse();
    },
  );
  const execute = () =>
    withModelReplay(checkpoint, async () => {
      const session = model.startToolSession({
        ...request,
        tools: [{ name: 'read', inputSchema: { type: 'object' } }],
      });
      const first = await session.next(1, AbortSignal.timeout(2000));
      session.accept(first.calls[0]!.id, { freshly_authorized: true });
      return session.next(0, AbortSignal.timeout(2000));
    });
  await execute();
  const replay = await execute();
  assert.equal(replay.inputTokens, 0);
  assert.equal(counts, 2);
  assert.equal(responses, 2);
  assert.match(JSON.stringify(checkpoint.rows.get(1)?.request), /opaque-summary/);
  assert.ok(!JSON.stringify(checkpoint.rows.get(1)?.request).includes('Fixture question.'));
});

test('restart restores native reasoning and function calls before continuing the same tool session', async () => {
  const checkpoint = new FixtureCheckpoint();
  const reasoning = {
    type: 'reasoning',
    id: 'reasoning_fixture',
    summary: [],
    encrypted_content: 'opaque_fixture_reasoning',
  };
  const functionCall = {
    type: 'function_call',
    id: 'function_fixture',
    call_id: 'call_fixture',
    name: 'fixture_summary',
    arguments: '{}',
  };
  const bodies: Array<{ input: unknown[] }> = [];
  const model = new OpenAITextModel(config, async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as { input: unknown[] });
    return bodies.length === 1
      ? Response.json({
          id: 'first_response',
          status: 'completed',
          output: [reasoning, functionCall],
        })
      : textResponse('17 fixture records.', 'second_response');
  });
  const toolRequest = {
    ...request,
    tools: [{ name: 'fixture_summary', inputSchema: { type: 'object', properties: {} } }],
  };
  const first = await withModelReplay(checkpoint, async () =>
    model.startToolSession(toolRequest).next(8, AbortSignal.timeout(2000)),
  );
  assert.deepEqual(first.calls, [{ id: 'call_fixture', name: 'fixture_summary', arguments: '{}' }]);
  assert.equal(bodies.length, 1);

  const resume = () =>
    withModelReplay(checkpoint, async () => {
      const session = model.startToolSession(toolRequest);
      const restored = await session.next(8, AbortSignal.timeout(2000));
      assert.deepEqual(restored.calls, first.calls);
      await assert.rejects(session.next(7, AbortSignal.timeout(2000)), /TOOL_OUTPUTS_PENDING/);
      assert.throws(() => session.accept('wrong_call', {}), /UNEXPECTED_TOOL_RESULT/);
      session.accept(restored.calls[0]!.id, { total: 17 });
      return session.next(7, AbortSignal.timeout(2000));
    });
  assert.equal((await resume()).text, '17 fixture records.');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1]!.input.slice(-4, -1), [
    reasoning,
    functionCall,
    { type: 'function_call_output', call_id: 'call_fixture', output: '{"total":17}' },
  ]);
  assert.equal((await resume()).text, '17 fixture records.');
  assert.equal(bodies.length, 2, 'both native responses survive a second serialized restart');
  assert.equal(checkpoint.rows.size, 2);
  assert.ok(!JSON.stringify([...checkpoint.rows.values()]).includes(config.apiKey));
});

test('changed input invalidates all later responses even when a later request still matches', async () => {
  const checkpoint = new FixtureCheckpoint();
  let calls = 0;
  const model = new OpenAITextModel(config, async () => textResponse(`answer-${++calls}`));
  const later = { ...request, stage: 'formatter' as const, instructions: 'Format the fixture.' };
  await withModelReplay(checkpoint, async () => {
    await model.complete(request);
    await model.complete(later);
  });
  const changed = {
    ...request,
    messages: [{ role: 'user' as const, content: 'Changed question.' }],
  };
  const answers = await withModelReplay(checkpoint, async () => [
    await model.complete(changed),
    await model.complete(later),
  ]);
  assert.deepEqual(
    answers.map((answer) => answer.text),
    ['answer-3', 'answer-4'],
  );
  assert.equal(calls, 4);
  await withModelReplay(checkpoint, async () => {
    assert.equal((await model.complete(changed)).text, 'answer-3');
    assert.equal((await model.complete(later)).text, 'answer-4');
  });
  assert.equal(calls, 4);
});

test('changing the configured model cannot replay a response from the earlier model', async () => {
  const checkpoint = new FixtureCheckpoint();
  let calls = 0;
  const fakeFetch: typeof fetch = async () => textResponse(`answer-${++calls}`);
  const firstModel = new OpenAITextModel(config, fakeFetch);
  const secondModel = new OpenAITextModel({ ...config, model: 'fixture-other-model' }, fakeFetch);
  await withModelReplay(checkpoint, () => firstModel.complete(request));
  assert.equal(
    (await withModelReplay(checkpoint, () => secondModel.complete(request))).text,
    'answer-2',
  );
  assert.equal(calls, 2);
});

test('fresh employee authority changes invalidate otherwise identical model requests', async () => {
  const checkpoint = new FixtureCheckpoint();
  let calls = 0;
  const model = new OpenAITextModel(config, async () => textResponse(`answer-${++calls}`));
  const run = (employeeId: number) =>
    withModelReplay(checkpoint, () => {
      bindReplayAuthority({ employeeId, access: 'available', scopes: ['fixture:read'] });
      return model.complete(request);
    });
  assert.equal((await run(7)).text, 'answer-1');
  assert.equal((await run(7)).text, 'answer-1');
  assert.equal((await run(8)).text, 'answer-2');
  assert.equal(calls, 2);
});

test('concurrent replay scopes keep response sequences and private inputs isolated', async () => {
  const firstCheckpoint = new FixtureCheckpoint();
  const secondCheckpoint = new FixtureCheckpoint();
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let calls = 0;
  const model = new OpenAITextModel(config, async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: Array<{ content: string }> };
    const text = body.input[0]!.content;
    calls++;
    if (text === 'FIRST_PRIVATE') {
      firstStarted();
      await firstBlocked;
    }
    return textResponse(text);
  });
  const ownRequest = (content: string) => ({
    ...request,
    messages: [{ role: 'user' as const, content }],
  });
  const first = withModelReplay(firstCheckpoint, async () => {
    await model.complete(ownRequest('FIRST_PRIVATE'));
    return model.complete(ownRequest('FIRST_NEXT'));
  });
  await started;
  const second = await withModelReplay(secondCheckpoint, async () => {
    await model.complete(ownRequest('SECOND_PRIVATE'));
    return model.complete(ownRequest('SECOND_NEXT'));
  });
  releaseFirst();
  assert.equal((await first).text, 'FIRST_NEXT');
  assert.equal(second.text, 'SECOND_NEXT');
  assert.equal(calls, 4);
  assert.deepEqual(firstCheckpoint.saves, secondCheckpoint.saves);
  assert.equal(firstCheckpoint.saves.length, 2);
  assert.ok(!JSON.stringify([...firstCheckpoint.rows.values()]).includes('SECOND_PRIVATE'));
  assert.ok(!JSON.stringify([...secondCheckpoint.rows.values()]).includes('FIRST_PRIVATE'));
  for (const [checkpoint, prefix] of [
    [firstCheckpoint, 'FIRST'],
    [secondCheckpoint, 'SECOND'],
  ] as const)
    await withModelReplay(checkpoint, async () => {
      assert.equal(
        (await model.complete(ownRequest(`${prefix}_PRIVATE`))).text,
        `${prefix}_PRIVATE`,
      );
      assert.equal((await model.complete(ownRequest(`${prefix}_NEXT`))).text, `${prefix}_NEXT`);
    });
  assert.equal(calls, 4);
});

test('checkpoint read failure prevents provider work and save failure prevents consuming a response', async () => {
  const checkpoint = new FixtureCheckpoint();
  let calls = 0;
  const model = new OpenAITextModel(config, async () => {
    calls++;
    return textResponse();
  });
  checkpoint.readFailure = new CheckpointError();
  await assert.rejects(
    withModelReplay(checkpoint, () => model.complete(request)),
    CheckpointError,
  );
  assert.equal(calls, 0);
  checkpoint.readFailure = undefined;
  checkpoint.saveFailure = new CheckpointError();
  await assert.rejects(
    withModelReplay(checkpoint, () => model.complete(request)),
    CheckpointError,
  );
  assert.equal(calls, 1);
  assert.equal(checkpoint.rows.size, 0);
});

test('abort before or during a checkpoint read cannot return cached model output', async () => {
  const checkpoint = new FixtureCheckpoint();
  let calls = 0;
  const model = new OpenAITextModel(config, async () => {
    calls++;
    return textResponse();
  });
  await withModelReplay(checkpoint, () => model.complete(request));
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    withModelReplay(checkpoint, () => model.complete(request, alreadyAborted.signal)),
    { name: 'AbortError' },
  );
  const duringRead = new AbortController();
  checkpoint.onRead = () => duringRead.abort();
  await assert.rejects(
    withModelReplay(checkpoint, () => model.complete(request, duringRead.signal)),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});

test('a replay hit bypasses HTTP usage reservation and keeps the original charge', async () => {
  const checkpoint = new FixtureCheckpoint();
  const events: UsageEvent[] = [];
  const meter = new UsageMeter(new MemoryUsageLedger('fixture-account', 'evaluation'), {
    accountId: 'fixture-account',
    purpose: 'evaluation',
    policy: {
      mode: 'enforce',
      limits: { runMicros: 1000 },
      prices: {
        version: 'fictional-replay-price',
        models: {
          [config.model]: {
            inputMicrosPerMillion: 1_000_000,
            outputMicrosPerMillion: 2_000_000,
            cachedInputMicrosPerMillion: 500_000,
            maxInputTokens: 100,
            maxOutputTokens: 20,
          },
        },
      },
    },
    observe: (event) => {
      events.push(event);
    },
  });
  let calls = 0;
  const model = new OpenAITextModel({ ...config, usageMeter: meter }, async () => {
    calls++;
    return textResponse();
  });
  const run = () =>
    meter.run({ runId: 'fixture-replay-run', subjectId: 'employee:7' }, () =>
      withModelReplay(checkpoint, () => model.complete(request)),
    );
  const original = await run();
  const summary = await meter.summarize('fixture-replay-run');
  const replayed = await run();
  assert.equal(replayed.text, original.text);
  assert.equal(replayed.responseId, original.responseId);
  assert.equal(replayed.inputTokens, 0);
  assert.equal(replayed.outputTokens, 0);
  assert.equal(calls, 1);
  assert.equal(events.filter((event) => event.type === 'reserved').length, 1);
  assert.deepEqual(await meter.summarize('fixture-replay-run'), summary);
  assert.equal(summary.knownActualMicros, 17);
});

test('requests outside a replay scope keep independent provider calls', async () => {
  let calls = 0;
  const model = new OpenAITextModel(config, async () => textResponse(`answer-${++calls}`));
  assert.equal((await model.complete(request)).text, 'answer-1');
  assert.equal((await model.complete(request)).text, 'answer-2');
  assert.equal(calls, 2);
});

const sourceQuery = { view: 'accessible', limit: 1 };
const sourceTrusted = { key: { remoteJid: FIXTURE_JID }, runId: 'durable-retry-fixture' };
const freshSignal = () => new AbortController().signal;

test('source cooldown and exhausted retry allowance survive new graph executions', async () => {
  const checkpoint = new FixtureCheckpoint();
  let now = Date.parse('2026-10-03T08:00:00Z');
  const fixture = createSalesFixture(() => now);
  fixture.state.failures.set('search_crm_leads', new ContextEngineError('UNAVAILABLE', true, 30));
  const run = (args = sourceQuery) =>
    withModelReplay(checkpoint, async () => {
      const opened = (await fixture.service.openTools(sourceTrusted, freshSignal())).run!;
      return opened.execute('search_crm_leads', JSON.stringify(args), freshSignal());
    });
  assert.equal((await run()).code, 'UNAVAILABLE');
  assert.equal((await run({ ...sourceQuery, limit: 2 })).suppressed_repeat, true);
  assert.equal(
    fixture.state.calls.length,
    1,
    'changing query cannot bypass restored source cooldown',
  );
  now += 30001;
  assert.equal((await run()).code, 'UNAVAILABLE');
  assert.equal(fixture.state.calls.length, 2);
  now += 30001;
  assert.equal((await run()).suppressed_repeat, true);
  assert.equal(fixture.state.calls.length, 2, 'restart cannot reset the one-retry allowance');
});

test('successful source rereads do not consume the next failure episode retry allowance', async () => {
  const checkpoint = new FixtureCheckpoint();
  const fixture = createSalesFixture(() => Date.parse('2026-10-03T08:00:00Z'));
  const run = () =>
    withModelReplay(checkpoint, async () => {
      const opened = (await fixture.service.openTools(sourceTrusted, freshSignal())).run!;
      return opened.execute('search_crm_leads', JSON.stringify(sourceQuery), freshSignal());
    });
  const first = await run();
  for (let i = 0; i < 2; i++) {
    const fresh = await run();
    assert.equal(fresh.ok, true);
    assert.equal(fresh.evidence_id, first.evidence_id, 'logical evidence IDs survive restart');
  }
  fixture.state.failures.set('search_crm_leads', new ContextEngineError('UNAVAILABLE', true));
  assert.equal((await run()).code, 'UNAVAILABLE');
  fixture.state.failures.clear();
  assert.equal((await run()).ok, true);
  assert.equal(fixture.state.calls.length, 5);
  assert.equal(checkpoint.consumed.tool, 5);
});

test('interrupted source attempts remain pending and allow only one fresh retry', async () => {
  const checkpoint = new FixtureCheckpoint();
  const fixture = createSalesFixture(() => Date.parse('2026-10-03T08:00:00Z'));
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController();
    fixture.state.mutate = () => controller.abort();
    await assert.rejects(
      withModelReplay(checkpoint, async () => {
        const opened = (await fixture.service.openTools(sourceTrusted, controller.signal)).run!;
        return opened.execute('search_crm_leads', JSON.stringify(sourceQuery), controller.signal);
      }),
      { name: 'AbortError' },
    );
  }
  fixture.state.mutate = undefined;
  const resumed = await withModelReplay(checkpoint, async () => {
    const opened = (await fixture.service.openTools(sourceTrusted, freshSignal())).run!;
    return opened.execute('search_crm_leads', JSON.stringify(sourceQuery), freshSignal());
  });
  assert.equal(resumed.suppressed_repeat, true);
  assert.equal(resumed.retryable, false);
  assert.equal(fixture.state.calls.length, 2);
});

test('durable source call and received-byte limits survive restart and reject evidence', async () => {
  const checkpoint = new FixtureCheckpoint();
  checkpoint.limits.tool = 1;
  checkpoint.limits.bytes = 1;
  const fixture = createSalesFixture(() => Date.parse('2026-10-03T08:00:00Z'));
  const run = (limit: number) =>
    withModelReplay(checkpoint, async () => {
      const opened = (await fixture.service.openTools(sourceTrusted, freshSignal())).run!;
      const result = await opened.execute(
        'search_crm_leads',
        JSON.stringify({ ...sourceQuery, limit }),
        freshSignal(),
      );
      assert.equal(opened.evidence.length, 0);
      return result;
    });
  assert.equal((await run(1)).code, 'RESPONSE_TOO_LARGE');
  assert.equal((await run(2)).code, 'TOOL_BUDGET_EXHAUSTED');
  assert.equal(fixture.state.calls.length, 1);
});

test('restart recovery journals read selectors and refreshes facts instead of caching old private results', async () => {
  const checkpoint = new FixtureCheckpoint();
  const fixture = createSalesFixture(() => Date.parse('2026-10-03T08:00:00Z'));
  await withModelReplay(checkpoint, async () => {
    const run = (await fixture.service.openTools(sourceTrusted, freshSignal())).run!;
    assert.equal(
      (await run.execute('search_crm_leads', JSON.stringify(sourceQuery), freshSignal())).ok,
      true,
    );
  });
  const policy = [...checkpoint.policies.values()].find((value: any) => value.reads) as any;
  assert.deepEqual(policy.reads, [{ name: 'search_crm_leads', arguments: sourceQuery }]);
  assert.equal(policy.reads[0].result, undefined);
  await withModelReplay(checkpoint, async () => {
    const run = (await fixture.service.openTools(sourceTrusted, freshSignal())).run!;
    assert.equal(run.evidence.length, 0);
    assert.deepEqual(await run.recoverReads(freshSignal()), [
      { name: 'search_crm_leads', ok: true },
    ]);
    assert.equal(run.evidence.length, 1);
  });
  assert.equal(fixture.state.calls.length, 2);
  assert.equal(checkpoint.consumed.tool, 2);
});

test('recovery cannot bypass an exhausted read budget or restore stale evidence after denial', async () => {
  const checkpoint = new FixtureCheckpoint();
  const fixture = createSalesFixture(() => Date.parse('2026-10-03T08:00:00Z'));
  await withModelReplay(checkpoint, async () => {
    const run = (await fixture.service.openTools(sourceTrusted, freshSignal())).run!;
    await run.execute('search_crm_leads', JSON.stringify(sourceQuery), freshSignal());
  });
  checkpoint.limits.tool = checkpoint.consumed.tool;
  await withModelReplay(checkpoint, async () => {
    const run = (await fixture.service.openTools(sourceTrusted, freshSignal())).run!;
    assert.deepEqual(await run.recoverReads(freshSignal()), [
      { name: 'search_crm_leads', ok: false },
    ]);
    assert.equal(run.evidence.length, 0);
  });
  assert.equal(fixture.state.calls.length, 1);
  checkpoint.limits.tool = 72;
  await withModelReplay(checkpoint, async () => {
    const run = (await fixture.service.openTools(sourceTrusted, freshSignal())).run!;
    fixture.state.active = false;
    await run.recoverReads(freshSignal());
    assert.equal(run.blocked, true);
    assert.equal(run.evidence.length, 0);
  });
  assert.equal(fixture.state.calls.length, 1);
});

test('web calls keep a durable four-call ceiling and deterministic evidence IDs across restart', async () => {
  const checkpoint = new FixtureCheckpoint();
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({
      results: [
        { title: 'Fixture', url: 'https://example.com/company', content: 'Public fixture.' },
      ],
    });
  };
  const run = () =>
    withUsageScope({ runId: 'utility-fixture', subjectId: 'employee:7' }, () =>
      withModelReplay(checkpoint, () =>
        new UtilityToolRun('fixture-web-key', fetcher).execute(
          'web_search',
          JSON.stringify({ query: 'Fixture company' }),
          freshSignal(),
        ),
      ),
    );
  const first = await run();
  assert.equal(first.ok, true);
  for (let i = 0; i < 3; i++) {
    const result = await run();
    assert.equal(result.ok, true);
    assert.equal(result.evidence_id, first.evidence_id);
  }
  assert.equal((await run()).code, 'WEB_CALL_LIMIT');
  assert.equal(calls, 4);
  assert.equal(checkpoint.consumed.web, 4);
  checkpoint.consumeFailure = new CheckpointError();
  await assert.rejects(
    withModelReplay(checkpoint, () =>
      new UtilityToolRun().execute('calculate', '{"expression":"1+1"}', freshSignal()),
    ),
    CheckpointError,
  );
});
