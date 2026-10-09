/** The real OpenAI SDK runs against a fake fetch; no paid requests occur in CI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAITextModel } from '../../src/infrastructure/openai/text-model.js';
import { loadAssistantConfig } from '../../src/config/assistant.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { ModelFailureError } from '../../src/modules/assistant/model-failure.js';
import { modelJsonSchema } from '../../src/modules/assistant/model-schema.js';
import { supplementSchema } from '../../src/modules/assistant/sales.graph.js';
import { assertStrictResponseSchema } from '../fixtures/strict-response-schema.js';
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

test('the actual SDK serializes a supported action schema without changing the validation policy', async () => {
  const model = new OpenAITextModel(config, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.text.format.strict, true);
    assertStrictResponseSchema(body.text.format.schema);
    return Response.json({
      id: 'schema-test',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '{"additional_reply":""}' }],
        },
      ],
    });
  });
  await model.complete({
    ...request,
    stage: 'formatter',
    jsonSchema: modelJsonSchema('action', supplementSchema),
  });
});

test('structured parsing selects a final message without concatenating commentary', async () => {
  const model = new OpenAITextModel(config, async () =>
    Response.json({
      id: 'phased',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          status: 'completed',
          content: [{ type: 'output_text', text: 'PRIVATE commentary, not JSON.' }],
        },
        {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          status: 'completed',
          content: [{ type: 'output_text', text: '{"additional_reply":""}' }],
        },
      ],
    }),
  );
  const result = await model.complete({
    ...request,
    stage: 'formatter',
    jsonSchema: modelJsonSchema('action', supplementSchema),
  });
  assert.equal(result.text, '{"additional_reply":""}');
});

test('malformed, ambiguous, refused and incomplete structured answers fail once with safe diagnostics', async () => {
  const message = (text: string) => ({
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  });
  const valid = '{"additional_reply":""}';
  const cases = [
    { output: [message(`${valid} PRIVATE extra text ${valid}`)], code: 'INVALID_JSON' },
    { output: [message('{"additional_reply":123}')], code: 'SCHEMA_MISMATCH' },
    { output: [message(valid), message(valid)], code: 'AMBIGUOUS_OUTPUT' },
    { output: [{ ...message(valid), phase: 'commentary' }], code: 'AMBIGUOUS_OUTPUT' },
    {
      output: [{ ...message(valid), phase: 'final_answer' }, message(valid)],
      code: 'AMBIGUOUS_OUTPUT',
    },
    {
      output: [
        {
          ...message(valid),
          content: [
            { type: 'output_text', text: valid },
            { type: 'output_text', text: valid },
          ],
        },
      ],
      code: 'AMBIGUOUS_OUTPUT',
    },
    {
      output: [{ ...message(valid), content: [{ type: 'refusal', refusal: 'PRIVATE refusal' }] }],
      code: 'REFUSAL',
    },
    { output: [message(valid)], status: 'incomplete', code: 'INCOMPLETE_RESPONSE' },
    { output: [{ ...message(valid), status: 'incomplete' }], code: 'INCOMPLETE_RESPONSE' },
    {
      output: [
        message(valid),
        { type: 'function_call', call_id: 'unexpected', name: 'save', arguments: '{}' },
      ],
      code: 'INVALID_RESPONSE',
    },
  ];
  for (const fixture of cases) {
    let calls = 0;
    const model = new OpenAITextModel(config, async () => {
      calls++;
      return Response.json({
        id: 'private-response',
        object: 'response',
        status: fixture.status ?? 'completed',
        output: fixture.output,
      });
    });
    await assert.rejects(
      model.complete({
        ...request,
        stage: 'formatter',
        jsonSchema: modelJsonSchema('action', supplementSchema),
      }),
      (error) => {
        assert.ok(error instanceof ModelFailureError);
        assert.equal(error.details.stage, 'formatter');
        assert.equal(error.details.code, fixture.code);
        assert.equal(
          error.details.outputShape?.messages,
          fixture.output.filter((item) => item.type === 'message').length,
        );
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE|private-response|additional_reply/);
        return true;
      },
    );
    assert.equal(calls, 1, 'a malformed response must not start an automatic formatter retry');
  }
});

test('strict tool transport decodes omission and clears while preserving native continuation arguments', async () => {
  const bodies: any[] = [];
  const wire = { id: 'record', changes: { budget: { value: null }, location: null } };
  const model = new OpenAITextModel(config, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      id: 'strict-edit',
      object: 'response',
      status: 'completed',
      output:
        bodies.length === 1
          ? [
              {
                type: 'function_call',
                call_id: 'edit',
                name: 'update',
                arguments: JSON.stringify(wire),
              },
            ]
          : [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Prepared.' }],
              },
            ],
    });
  });
  const session = model.startToolSession({
    ...request,
    tools: [
      {
        name: 'update',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            changes: {
              type: 'object',
              properties: {
                budget: { type: ['string', 'null'] },
                location: { type: ['string', 'null'] },
              },
              additionalProperties: false,
            },
          },
          required: ['id', 'changes'],
          additionalProperties: false,
        },
      },
    ],
  });
  const result = await session.next(2, AbortSignal.timeout(1000));
  assert.deepEqual(JSON.parse(result.calls[0]!.arguments), {
    id: 'record',
    changes: { budget: null },
  });
  assertStrictResponseSchema(bodies[0].tools[0].parameters);
  assert.equal(bodies[0].tools[0].strict, true);
  session.accept('edit', { status: 'draft_not_executed' });
  await session.next(0, AbortSignal.timeout(1000));
  assert.deepEqual(
    JSON.parse(bodies[1].input.find((item: any) => item.type === 'function_call').arguments),
    wire,
  );
});

test('schema rejection retains a safe failing stage and HTTP category in the assistant trace', async () => {
  const model = new OpenAITextModel(config, async () =>
    Response.json(
      {
        error: {
          code: 'invalid_json_schema',
          message: 'PRIVATE_PROMPT synthetic-secret',
          param: 'PRIVATE_FIELD',
        },
      },
      { status: 400 },
    ),
  );
  await assert.rejects(model.complete({ ...request, stage: 'formatter' }), (error) => {
    assert.ok(error instanceof ModelFailureError);
    assert.deepEqual(error.details, {
      stage: 'formatter',
      code: 'INVALID_SCHEMA',
      httpStatus: 400,
    });
    assert.ok(!JSON.stringify(error).includes('PRIVATE'));
    return true;
  });
  const assistant = new AssistantService(config, {
    complete: async () => {
      throw new ModelFailureError(
        { stage: 'formatter', code: 'INVALID_SCHEMA', httpStatus: 400 },
        'OpenAI request failed (HTTP 400)',
      );
    },
  });
  const result = await assistant.prepare({
    chatId: 'synthetic@s.whatsapp.net',
    text: 'hello',
    isGroup: false,
    fromMe: false,
    sentAtMs: Date.now(),
    mentionsBot: false,
    messageId: 'synthetic-model-failure',
  });
  assert.equal(result.trace.failureCode, 'RUN_FAILED');
  assert.deepEqual(result.trace.modelFailure, {
    stage: 'formatter',
    code: 'INVALID_SCHEMA',
    httpStatus: 400,
  });
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
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
    arguments: '{"view":null}',
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
    assert.equal(body.tools[0].strict, true);
    assert.deepEqual(body.tools[0].parameters.required, ['view']);
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
    (error: unknown) => {
      assert.ok(error instanceof ModelFailureError);
      assert.equal(error.message, 'OpenAI request failed (HTTP 403)');
      assert.deepEqual(error.details, { stage: 'worker', code: 'ACCESS_DENIED', httpStatus: 403 });
      assert.ok(!JSON.stringify(error).includes('synthetic-secret'));
      return true;
    },
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
