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
  assert.deepEqual(bodies[1].input.slice(-3), [
    reasoning,
    functionCall,
    { type: 'function_call_output', call_id: 'call-1', output: '{"total":17}' },
  ]);
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
