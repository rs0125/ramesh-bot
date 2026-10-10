import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAITextModel } from '../../src/infrastructure/openai/text-model.js';
import { OpenAIToolCatalog } from '../../src/infrastructure/openai/tool-catalog.js';
import { loadAssistantConfig } from '../../src/config/assistant.js';
import {
  planningToolDefinitions,
  toolDiscovery,
} from '../../src/modules/context-engine/tool-discovery.js';
import { withModelReplay } from '../../src/modules/assistant/model-replay.js';
import type { AgentCheckpointSession } from '../../src/modules/assistant/checkpoint.types.js';
import type { ToolSessionRequest } from '../../src/modules/assistant/assistant.types.js';

const tool = {
  name: 'read_future_inventory',
  description: 'Read available purple widget inventory.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  discovery: {
    capability: 'future_inventory',
    description: 'Purple widget inventory and availability.',
    loading: 'deferred' as const,
  },
};
const request: ToolSessionRequest = {
  instructions: 'Read inventory.',
  messages: [{ role: 'user', content: 'Check Pune inventory.' }],
  tools: [tool],
};
const config = {
  apiKey: 'synthetic',
  model: 'gpt-6-luna',
  timeoutMs: 5000,
  maxOutputTokens: 1000,
  toolLoadingMode: 'deferred' as const,
};
const namespace = 'ce_future_inventory_1';
const search = (tools: unknown[]) => [
  {
    type: 'tool_search_call',
    id: 'search',
    call_id: null,
    execution: 'server',
    status: 'completed',
    arguments: { query: 'purple inventory' },
  },
  {
    type: 'tool_search_output',
    id: 'search_result',
    call_id: null,
    execution: 'server',
    status: 'completed',
    tools,
  },
];
const called = {
  type: 'function_call',
  id: 'fc',
  call_id: 'read',
  namespace,
  name: tool.name,
  arguments: '{"city":"Pune"}',
};
const text = {
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'Seven widgets.' }],
};
function response(output: unknown[]) {
  return Response.json({
    id: 'r',
    object: 'response',
    status: 'completed',
    output,
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
  });
}

test('unfamiliar capabilities use server metadata; eager mode retains full schemas', () => {
  const discovery = toolDiscovery({
    ...tool,
    _meta: { 'wareongo/tool-discovery-v1': tool.discovery },
  });
  assert.deepEqual(discovery, tool.discovery);
  const deferred = new OpenAIToolCatalog([tool], 'deferred').render();
  assert.equal(deferred[0]?.type, 'namespace');
  assert.equal(deferred[1]?.type, 'tool_search');
  assert.equal(new OpenAIToolCatalog([tool], 'eager').render()[0]?.type, 'function');
  assert.ok(!('inputSchema' in planningToolDefinitions([tool], 'deferred')[0]!));
  assert.deepEqual(planningToolDefinitions([tool], 'eager'), [tool]);
  assert.throws(() =>
    toolDiscovery({
      ...tool,
      _meta: { 'wareongo/tool-discovery-v1': { ...tool.discovery, capability: '../invalid' } },
    }),
  );
  assert.equal(loadAssistantConfig({ OPENAI_API_KEY: 'synthetic' })?.toolLoadingMode, 'eager');
  assert.equal(
    loadAssistantConfig({ OPENAI_API_KEY: 'synthetic', AGENT_TOOL_LOADING: 'deferred' })
      ?.toolLoadingMode,
    'deferred',
  );
  assert.throws(() =>
    loadAssistantConfig({ OPENAI_API_KEY: 'synthetic', AGENT_TOOL_LOADING: 'magic' }),
  );
});

test('search-only responses continue, preserve search items and aggregate usage', async () => {
  const bodies: any[] = [];
  const model = new OpenAITextModel(config, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (bodies.length === 1)
      return response(search(body.tools.filter((t: any) => t.type === 'namespace')));
    if (bodies.length === 2) return response([called]);
    return response([text]);
  });
  const session = model.startToolSession(request);
  const first = await session.next(4, AbortSignal.timeout(5000));
  assert.deepEqual(first.calls, [{ id: 'read', name: tool.name, arguments: '{"city":"Pune"}' }]);
  assert.equal(first.inputTokens, 200);
  assert.equal(first.outputTokens, 20);
  assert.equal(first.cachedInputTokens, 40);
  assert.equal(first.reasoningTokens, 4);
  assert.ok(bodies[1].input.some((x: any) => x.type === 'tool_search_output'));
  session.accept('read', { count: 7 });
  await session.next(0, AbortSignal.timeout(5000));
  assert.equal(bodies[2].tool_choice, 'none');
  assert.equal(bodies[2].tools.length, 0);
  assert.equal(bodies[0].instructions, bodies[2].instructions);
  assert.match(bodies[2].input.at(-1).content, /Remaining tool-call budget: 0/);
  assert.deepEqual(bodies[2].input.at(-2), {
    type: 'function_call_output',
    call_id: 'read',
    namespace,
    output: '{"count":7}',
  });
});

test('deferred discovery keeps context checks and encrypted compaction across search-only rounds', async () => {
  const bodies: any[] = [];
  const counts: any[] = [];
  const compact = { type: 'compaction', id: 'compact-search', encrypted_content: 'opaque' };
  const model = new OpenAITextModel(
    { ...config, context: { maxInputTokens: 96000, compactThreshold: 64000 } },
    async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/input_tokens')) {
        counts.push(body);
        return Response.json({ object: 'response.input_tokens', input_tokens: 900 });
      }
      bodies.push(body);
      if (bodies.length === 1)
        return response([
          compact,
          ...search(body.tools.filter((t: any) => t.type === 'namespace')),
        ]);
      return response(bodies.length === 2 ? [called] : [text]);
    },
  );
  const session = model.startToolSession(request);
  const first = await session.next(4, AbortSignal.timeout(5000));
  assert.equal(first.calls[0]?.name, tool.name);
  session.accept('read', { count: 7 });
  await session.next(0, AbortSignal.timeout(5000));
  assert.equal(counts.length, 3);
  for (const [index, body] of bodies.entries()) {
    assert.deepEqual(counts[index].tools, body.tools);
    assert.deepEqual(counts[index].input, body.input);
    assert.match(body.instructions, /Conversation memory/);
    assert.match(body.instructions, /Search for the relevant capability/);
    assert.equal(body.instructions, bodies[0].instructions);
    assert.deepEqual(body.context_management, [{ type: 'compaction', compact_threshold: 64000 }]);
  }
  assert.deepEqual(bodies[1].input[0], compact);
  assert.ok(bodies[1].input.some((item: any) => item.type === 'tool_search_output'));
  assert.ok(!JSON.stringify(bodies[1].input).includes('Check Pune inventory.'));
  assert.equal(bodies[2].input.at(-2).namespace, namespace);
});

test('an over-budget deferred continuation stops before another generation', async () => {
  let counts = 0;
  let generations = 0;
  const model = new OpenAITextModel(
    { ...config, context: { maxInputTokens: 96000, compactThreshold: 64000 } },
    async (url, init) => {
      if (String(url).endsWith('/input_tokens')) {
        counts++;
        return Response.json({
          object: 'response.input_tokens',
          input_tokens: counts === 1 ? 900 : 96001,
        });
      }
      generations++;
      const body = JSON.parse(String(init?.body));
      return response(search(body.tools.filter((t: any) => t.type === 'namespace')));
    },
  );
  await assert.rejects(
    model.startToolSession(request).next(4, AbortSignal.timeout(5000)),
    /OPENAI_CONTEXT_BUDGET_EXCEEDED/,
  );
  assert.equal(counts, 2);
  assert.equal(generations, 1);
});

test('search cannot introduce a tool, alter its schema or dispatch under another namespace', async () => {
  for (const output of [
    search([{ type: 'function', name: 'publish_everything', parameters: {} }]),
    search([
      {
        type: 'namespace',
        name: namespace,
        description: 'inventory',
        tools: [{ type: 'function', name: tool.name, parameters: {} }],
      },
    ]),
    [{ ...called, namespace: 'another_capability' }],
    [{ ...called, namespace: undefined }],
    [{ ...search([])[0], execution: 'client' }, search([])[1]],
  ]) {
    const model = new OpenAITextModel(config, async () => response(output));
    await assert.rejects(
      model.startToolSession(request).next(4, AbortSignal.timeout(5000)),
      /UNAVAILABLE_MODEL_TOOL|CHANGED_SEARCH_SCHEMA|UNEXPECTED_SEARCH_TOOL|TOOL_SEARCH_BUDGET_EXHAUSTED|INVALID_TOOL_RESPONSE/,
    );
  }
});

test('hosted search can omit optional strict metadata without weakening the supplied contract', () => {
  const catalog = new OpenAIToolCatalog([tool], 'deferred');
  const group = catalog.render().find((item) => item.type === 'namespace')!;
  const definition = group.tools[0]!;
  assert.ok(definition.type === 'function');
  assert.equal(definition.strict, true);
  const { strict: _, ...withoutEcho } = definition;
  catalog.validateSearchTools([{ ...group, tools: [withoutEcho] }], [tool.name]);
  assert.throws(
    () =>
      catalog.validateSearchTools(
        [{ ...group, tools: [{ ...definition, strict: false }] }],
        [tool.name],
      ),
    /CHANGED_SEARCH_SCHEMA/,
  );
  assert.ok(group.tools.every((item) => item.type === 'function' && item.strict === true));
});

test('withdrawn functions are removed from deferred search and rejected on dispatch', async () => {
  let body: any;
  const model = new OpenAITextModel(config, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return response([called]);
  });
  const session = model.startToolSession({
    ...request,
    tools: [tool, { name: 'local_calculate', inputSchema: { type: 'object', properties: {} } }],
  });
  await assert.rejects(
    session.next(4, AbortSignal.timeout(5000), ['local_calculate', 'invented']),
    /UNAVAILABLE_MODEL_TOOL|CHANGED_SEARCH_SCHEMA|UNEXPECTED_SEARCH_TOOL|TOOL_SEARCH_BUDGET_EXHAUSTED|INVALID_TOOL_RESPONSE/,
  );
  assert.deepEqual(
    body.tools.map((t: any) => t.name),
    ['local_calculate'],
  );
});

test('repeated search is bounded without running a business tool', async () => {
  let calls = 0;
  const model = new OpenAITextModel(config, async () => {
    calls++;
    return response(search([]));
  });
  await assert.rejects(
    model.startToolSession(request).next(4, AbortSignal.timeout(5000)),
    /UNAVAILABLE_MODEL_TOOL|CHANGED_SEARCH_SCHEMA|UNEXPECTED_SEARCH_TOOL|TOOL_SEARCH_BUDGET_EXHAUSTED|INVALID_TOOL_RESPONSE/,
  );
  assert.equal(calls, 8);
});

test('durable replay restores hosted discovery without repeating provider calls', async () => {
  const rows = new Map<number, { request: unknown; response: unknown }>();
  const checkpoint = {
    async read(index: number, value: unknown) {
      const row = rows.get(index);
      if (!row) return undefined;
      assert.deepEqual(value, row.request);
      return structuredClone(row.response);
    },
    async save(index: number, request: unknown, response: unknown) {
      rows.set(index, structuredClone({ request, response }));
    },
  } as unknown as AgentCheckpointSession;
  let paid = 0;
  const model = new OpenAITextModel(config, async (_url, init) => {
    paid++;
    const body = JSON.parse(String(init?.body));
    return response([...search(body.tools.filter((t: any) => t.type === 'namespace')), called]);
  });
  const run = () =>
    withModelReplay(checkpoint, () =>
      model.startToolSession(request).next(4, AbortSignal.timeout(5000)),
    );
  assert.equal((await run()).inputTokens, 100);
  assert.equal((await run()).inputTokens, 0);
  assert.equal(paid, 1);
});

test('new tools are chunked generically and never expand an empty permitted set', () => {
  const tools = Array.from({ length: 19 }, (_, i) => ({ ...tool, name: `future_tool_${i}` }));
  const catalog = new OpenAIToolCatalog(tools, 'deferred');
  const groups = catalog.render().filter((t) => t.type === 'namespace');
  assert.deepEqual(
    groups.map((g) => g.tools.length),
    [8, 8, 3],
  );
  assert.deepEqual(catalog.render([]), []);
});
