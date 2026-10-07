/** The real OpenAI SDK runs against a fake fetch; no paid requests occur in CI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAITextModel } from '../../src/infrastructure/openai/text-model.js';
import { loadAssistantConfig } from '../../src/config/assistant.js';
const config = {
  apiKey: 'synthetic-secret',
  model: 'gpt-5.6-terra',
  timeoutMs: 1000,
  maxOutputTokens: 800,
};
const request = {
  stage: 'converser' as const,
  instructions: 'reply briefly',
  messages: [{ role: 'user' as const, content: 'hello' }],
};

test('Sol uses supported stage effort, explicit tool effort and returned usage counts', async () => {
  const seen: any[] = [];
  const model = new OpenAITextModel(
    { ...config, model: 'gpt-6.1-sol', toolReasoningEffort: 'high' },
    async (_input, init) => {
      seen.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: 'sol',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello.' }],
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 64 },
          output_tokens_details: { reasoning_tokens: 15 },
        },
      });
    },
  );
  const result = await model.complete(request);
  assert.equal(result.reasoningTokens, 15);
  assert.equal(result.cachedInputTokens, 64);
  await model.complete({ ...request, stage: 'verifier', reasoningEffort: 'medium' });
  await model.startToolSession({ ...request, tools: [] }).next(0, AbortSignal.timeout(1000));
  assert.deepEqual(
    seen.map((r) => r.reasoning.effort),
    ['low', 'medium', 'high'],
  );
  assert.ok(seen.every((r) => r.model === 'gpt-6.1-sol' && r.store === false));
  assert.equal(
    loadAssistantConfig({ OPENAI_API_KEY: 'fake', AGENT_TOOL_REASONING_EFFORT: 'high' })
      ?.toolReasoningEffort,
    'high',
  );
  assert.throws(() =>
    loadAssistantConfig({ OPENAI_API_KEY: 'fake', AGENT_TOOL_REASONING_EFFORT: 'invented' }),
  );
});

test('Responses request uses Terra, no tools, no response storage, and bounded tokens', async () => {
  const model = new OpenAITextModel(config, async (input, init) => {
    assert.equal(String(input), 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-secret');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gpt-5.6-terra');
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 800);
    assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.equal(body.tools, undefined);
    assert.deepEqual(body.input, request.messages);
    return Response.json({
      id: 'test-response',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hey!', annotations: [] }],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  });
  assert.deepEqual(await model.complete(request), {
    text: 'Hey!',
    model: 'gpt-5.6-terra',
    responseCalls: 1,
    inputTokens: 12,
    outputTokens: 3,
    responseId: 'test-response',
  });
});

test('provider error bodies are redacted and incomplete answers are rejected', async () => {
  const failed = new OpenAITextModel(config, async () =>
    Response.json({ error: { message: 'sensitive body synthetic-secret' } }, { status: 401 }),
  );
  await assert.rejects(failed.complete(request), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'OpenAI request failed (HTTP 401)');
    return true;
  });
  const incomplete = new OpenAITextModel(config, async () =>
    Response.json({ id: 'r', status: 'incomplete', output: [] }),
  );
  await assert.rejects(incomplete.complete(request), /OpenAI request failed/);
});

test('an already cancelled model request performs no fetch', async () => {
  const model = new OpenAITextModel(config, async () => assert.fail('No HTTP request expected'));
  await assert.rejects(model.complete(request, AbortSignal.abort()));
});

test('server-only private history cannot cross either OpenAI serialization boundary', async () => {
  let calls = 0;
  const model = new OpenAITextModel(config, async (_input, init) => {
    calls++;
    const body = String(init?.body);
    assert.ok(!body.includes('PRIVATE_SENTINEL'));
    assert.ok(!body.includes('protectedReply'));
    return Response.json({
      id: `r${calls}`,
      object: 'response',
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello.' }] },
      ],
    });
  });
  const protectedRequest = {
    ...request,
    messages: [
      {
        role: 'assistant' as const,
        content: 'Private reply delivered.',
        protectedReply: { text: 'PRIVATE_SENTINEL', receipt: {} },
      },
    ],
  };
  await model.complete(protectedRequest);
  await model
    .startToolSession({ ...protectedRequest, tools: [] })
    .next(0, AbortSignal.timeout(1000));
  assert.equal(calls, 2);
});

test('native tool sessions preserve continuation, optional arguments and correlated results without server storage', async () => {
  let calls = 0;
  const bodies: any[] = [];
  const reasoning = {
    type: 'reasoning',
    id: 'reason-1',
    summary: [],
    encrypted_content: 'opaque-reasoning',
  };
  const functionCall = {
    type: 'function_call',
    id: 'fc-1',
    call_id: 'call-1',
    name: 'crm_summary',
    arguments: '{}',
  };
  const model = new OpenAITextModel(config, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (calls++ === 0) {
      return Response.json({ id: 'r1', status: 'completed', output: [reasoning, functionCall] });
    }
    return Response.json({
      id: 'r2',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '17 leads.', annotations: [] }],
        },
      ],
    });
  });
  const session = model.startToolSession({
    ...request,
    tools: [
      {
        name: 'crm_summary',
        inputSchema: { type: 'object', properties: { view: { type: 'string' } } },
      },
    ],
  });
  const first = await session.next(8, AbortSignal.timeout(1000));
  assert.deepEqual(first.calls, [{ id: 'call-1', name: 'crm_summary', arguments: '{}' }]);
  await assert.rejects(session.next(7, AbortSignal.timeout(1000)), /outputs required/);
  assert.throws(() => session.accept('forged-call', {}), /Unexpected tool result/);
  session.accept('call-1', { total: 17 });
  assert.throws(() => session.accept('call-1', {}), /Unexpected tool result/);
  assert.equal((await session.next(0, AbortSignal.timeout(1000))).text, '17 leads.');
  assert.equal(calls, 2);
  for (const body of bodies) {
    assert.equal(body.store, false);
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.tools[0].strict, false);
    assert.equal(body.tools[0].parameters.required, undefined);
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  }
  assert.equal(bodies[0].tool_choice, 'auto');
  assert.equal(bodies[1].tool_choice, 'none');
  assert.equal(bodies[0].instructions, bodies[1].instructions);
  assert.match(bodies[1].input.at(-1).content, /Remaining tool-call budget: 0/);
  assert.deepEqual(bodies[1].input.slice(-4, -1), [
    reasoning,
    functionCall,
    { type: 'function_call_output', call_id: 'call-1', output: '{"total":17}' },
  ]);
});

test('full rendered input is counted before generation and an oversized schema stops spending', async () => {
  let counts = 0,
    generations = 0;
  const model = new OpenAITextModel(
    { ...config, context: { maxInputTokens: 96000, compactThreshold: 64000 } },
    async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/input_tokens')) {
        counts++;
        assert.ok(body.instructions.includes('Conversation memory'));
        assert.equal(body.text.format.name, 'test_schema');
        assert.deepEqual(body.input, request.messages);
        return Response.json({ object: 'response.input_tokens', input_tokens: 24001 });
      }
      generations++;
      assert.fail('over-budget input must not reach a generating endpoint');
    },
  );
  await assert.rejects(
    model.complete({ ...request, jsonSchema: { name: 'test_schema', schema: { type: 'object' } } }),
    /OPENAI_CONTEXT_BUDGET_EXCEEDED/,
  );
  assert.equal(counts, 1);
  assert.equal(generations, 0);
});

test('automatic compaction preserves encrypted state, drops covered history and retains function pairs', async () => {
  const bodies: any[] = [],
    counts: any[] = [];
  const compact = { type: 'compaction', id: 'compact-1', encrypted_content: 'opaque-compaction' };
  const call = {
    type: 'function_call',
    id: 'fc-compact',
    call_id: 'call-compact',
    name: 'read',
    arguments: '{}',
  };
  const model = new OpenAITextModel(
    { ...config, context: { maxInputTokens: 96000, compactThreshold: 64000 } },
    async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/input_tokens')) {
        counts.push(body);
        return Response.json({ object: 'response.input_tokens', input_tokens: 900 });
      }
      bodies.push(body);
      return Response.json({
        id: `r${bodies.length}`,
        object: 'response',
        status: 'completed',
        output:
          bodies.length === 1
            ? [compact, call]
            : [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Done.' }],
                },
              ],
      });
    },
  );
  const session = model.startToolSession({
    ...request,
    tools: [{ name: 'read', inputSchema: { type: 'object' } }],
  });
  await session.next(2, AbortSignal.timeout(1000));
  session.accept('call-compact', { fresh: true });
  await session.next(0, AbortSignal.timeout(1000));
  assert.equal(counts.length, 2);
  assert.deepEqual(counts[0].tools, bodies[0].tools);
  assert.deepEqual(bodies[0].context_management, [
    { type: 'compaction', compact_threshold: 64000 },
  ]);
  assert.equal(bodies[1].store, false);
  assert.deepEqual(bodies[1].input.slice(0, 3), [
    compact,
    call,
    { type: 'function_call_output', call_id: 'call-compact', output: '{"fresh":true}' },
  ]);
  assert.ok(!JSON.stringify(bodies[1].input).includes('hello'));
});

test('compaction after a pending call cannot orphan its result', async () => {
  const bodies: any[] = [];
  const model = new OpenAITextModel(config, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      id: 'r',
      object: 'response',
      status: 'completed',
      output:
        bodies.length === 1
          ? [
              { type: 'function_call', call_id: 'c', name: 'read', arguments: '{}' },
              { type: 'compaction', id: 'compact', encrypted_content: 'opaque' },
            ]
          : [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Done.' }],
              },
            ],
    });
  });
  const session = model.startToolSession({
    ...request,
    tools: [{ name: 'read', inputSchema: { type: 'object' } }],
  });
  await session.next(1, AbortSignal.timeout(1000));
  session.accept('c', {});
  await session.next(0, AbortSignal.timeout(1000));
  assert.deepEqual(
    bodies[1].input.slice(0, 3).map((item: any) => item.type),
    ['function_call', 'compaction', 'function_call_output'],
  );
});

test('native tool sessions redact provider failures and reject parallel proposals', async () => {
  const failed = new OpenAITextModel(config, async () =>
    Response.json({ error: { message: 'synthetic-secret' } }, { status: 403 }),
  );
  await assert.rejects(
    failed.startToolSession({ ...request, tools: [] }).next(8, AbortSignal.timeout(1000)),
    /^Error: OpenAI request failed \(HTTP 403\)$/,
  );
  const parallel = new OpenAITextModel(config, async () =>
    Response.json({
      id: 'r',
      status: 'completed',
      output: [1, 2].map((n) => ({
        type: 'function_call',
        call_id: `call-${n}`,
        name: 'get_context',
        arguments: '{}',
      })),
    }),
  );
  await assert.rejects(
    parallel.startToolSession({ ...request, tools: [] }).next(8, AbortSignal.timeout(1000)),
    /OpenAI tool request failed/,
  );
});

test('continuations restrict callable tools without changing schemas or losing earlier tool outputs', async () => {
  const bodies: any[] = [];
  const model = new OpenAITextModel(config, async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      id: `response-${bodies.length}`,
      object: 'response',
      status: 'completed',
      output:
        bodies.length === 1
          ? [
              {
                type: 'function_call',
                call_id: 'read-call',
                name: 'read_inventory',
                arguments: '{}',
              },
            ]
          : [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Partial findings retained.' }],
              },
            ],
    });
  });
  const session = model.startToolSession({
    ...request,
    tools: ['read_inventory', 'personal_list'].map((name) => ({
      name,
      inputSchema: { type: 'object', properties: {} },
    })),
  });
  await session.next(28, AbortSignal.timeout(1000), ['read_inventory', 'personal_list']);
  session.accept('read-call', { ok: true, records: ['synthetic'] });
  await session.next(4, AbortSignal.timeout(1000), ['personal_list', 'unadvertised_tool']);
  await session.next(4, AbortSignal.timeout(1000), []);
  assert.equal(bodies[0].tool_choice, 'auto');
  assert.deepEqual(bodies[1].tool_choice, {
    type: 'allowed_tools',
    mode: 'auto',
    tools: [{ type: 'function', name: 'personal_list' }],
  });
  assert.deepEqual(bodies[1].tools, bodies[0].tools);
  assert.ok(
    bodies[1].input.some(
      (item: any) => item.type === 'function_call_output' && item.call_id === 'read-call',
    ),
  );
  assert.equal(bodies[2].tool_choice, 'none');
});
