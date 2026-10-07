/** Real MCP protocol with synthetic fetch/model ports. No provider calls, database or transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextEngineMcpClient } from '../../src/infrastructure/context-engine/mcp-client.js';
import { loadContextSigningConfig } from '../../src/infrastructure/context-engine/request-credentials.js';
import { ContextToolRun } from '../../src/modules/assistant/tool-executor.js';
import { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import { buildSalesGraph } from '../../src/modules/assistant/sales.graph.js';
import type { TextModel } from '../../src/modules/assistant/assistant.types.js';
import type { ContextToolDefinition } from '../../src/modules/context-engine/context.types.js';
import {
  argumentsSha256,
  READ_CONTRACT_KEY,
} from '../../src/modules/context-engine/read-contract.js';

const name = 'list_documents';
const sender = { phoneE164: '+919000000023', audience: 'dm' as const };
const trusted = { key: { remoteJid: '919000000023@s.whatsapp.net' }, runId: 'dynamic-fixture' };
const config = {
  endpoint: 'https://context.example/mcp',
  timeoutMs: 5000,
  maxResponseBytes: 1048576,
};
const signal = () => new AbortController().signal;
const descriptor = (): ContextToolDefinition => ({
  name,
  description: 'List documents visible to the messaging employee.',
  inputSchema: {
    type: 'object',
    properties: { q: { type: 'string' } },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    required: ['data'],
    properties: {
      data: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
  _meta: { [READ_CONTRACT_KEY]: { requiredScopes: ['documents:read'], sourceFamily: 'documents' } },
});
const contextTool = {
  name: 'get_context',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
};
type Rpc = { id?: string | number; method: string; params?: Record<string, any> };
function fixture() {
  const state = {
    scopes: ['documents:read'],
    tool: descriptor(),
    count: 2,
    calls: [] as Rpc[],
    pages: undefined as
      | undefined
      | ((cursor?: string) => { tools: ContextToolDefinition[]; nextCursor?: string }),
    mutate: undefined as undefined | (() => void),
  };
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, config.endpoint);
    if (request.method === 'GET') return new Response(null, { status: 405 });
    const rpc = (await request.json()) as Rpc;
    state.calls.push(rpc);
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const employee = request.headers.get('authorization')?.endsWith('b'.repeat(43)) ? 44 : 23;
    let result: unknown;
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: rpc.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture-context', version: '2' },
        instructions: `LIVE_SOURCE_GUIDANCE_${employee}`,
      };
    else if (rpc.method === 'tools/list')
      result = state.pages?.(rpc.params?.cursor) ?? { tools: [contextTool, state.tool] };
    else if (rpc.method === 'tools/call') {
      const called = String(rpc.params?.name);
      const args = rpc.params?.arguments ?? {};
      const data =
        called === 'get_context'
          ? {
              employee_id: employee,
              scopes: employee === 23 ? state.scopes : [],
              read_only: true,
              query_guidance: `LIVE_CONTEXT_${employee}`,
              secret: 'PRIVATE_SECRET',
              phone: 'PRIVATE_PHONE',
            }
          : { count: state.count };
      if (called !== 'get_context') state.mutate?.();
      result = {
        content: [],
        structuredContent: {
          source_path: called === 'get_context' ? '/api/v1/context' : '/api/v1/documents',
          status: 200,
          data,
          meta: {
            requestId: 'synthetic-request',
            generatedAt: new Date().toISOString(),
            toolName: called,
            argumentsSha256: argumentsSha256(args),
          },
        },
      };
    } else throw new Error('Unexpected fixture method');
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  };
  const client = new ContextEngineMcpClient(
    config,
    {
      async resolve(who) {
        const employeeId = who.phoneE164 === sender.phoneE164 ? 23 : 44;
        return {
          employeeId,
          phoneE164: who.phoneE164,
          active: true,
          accessToken: `wog_mcp_at_${(employeeId === 23 ? 'a' : 'b').repeat(43)}`,
          expiresAtMs: Date.now() + 60000,
        };
      },
    },
    fetcher,
  );
  const bound = () => ({
    employeeId: 23,
    discover: (s: AbortSignal) => client.discover(sender, s),
    describe: (s: AbortSignal) => client.describe(sender, s),
    call: (tool: string, args: Record<string, unknown>, s: AbortSignal) =>
      client.call(sender, tool, args, s),
  });
  const service = new BusinessReadService(
    async () => ({
      employeeId: 23,
      search: async () => {
        throw new Error('Legacy port unused');
      },
      tools: bound(),
    }),
    'all',
    Date.now,
    true,
  );
  return { state, client, bound, service };
}
const sourceCalls = (calls: Rpc[]) =>
  calls.filter((rpc) => rpc.method === 'tools/call' && rpc.params?.name === name);

test('operator scope ceilings accept explicit read/write namespaces without wildcards', () => {
  const signing = {
    kid: 'fixture',
    privateKey: { kty: 'OKP', crv: 'Ed25519', x: 'a'.repeat(43), d: 'b'.repeat(43) },
    scopes: ['documents:read'],
  };
  assert.deepEqual(
    loadContextSigningConfig({ CONTEXT_RAMESH_SIGNING_KEY_JSON: JSON.stringify(signing) })?.scopes,
    ['documents:read'],
  );
  assert.deepEqual(
    loadContextSigningConfig({
      CONTEXT_RAMESH_SIGNING_KEY_JSON: JSON.stringify({ ...signing, scopes: ['documents:write'] }),
    })?.scopes,
    ['documents:write'],
  );
  for (const scopes of [['documents:admin'], ['*'], ['documents:read', 'documents:read']])
    assert.throws(() =>
      loadContextSigningConfig({
        CONTEXT_RAMESH_SIGNING_KEY_JSON: JSON.stringify({ ...signing, scopes }),
      }),
    );
});

test('live catalogue carries new schemas, metadata, guidance and bounded private-free orientation', async () => {
  const { client } = fixture();
  const catalog = await client.describe(sender);
  const tool = catalog.tools.find((item) => item.name === name)!;
  assert.deepEqual(tool, descriptor());
  assert.equal(catalog.guidance, 'LIVE_SOURCE_GUIDANCE_23');
  assert.equal(catalog.context.query_guidance, 'LIVE_CONTEXT_23');
  assert.doesNotMatch(JSON.stringify(catalog.context), /PRIVATE_|employee_id/);
  assert.equal((await client.call(sender, name, {})).data.count, 2);
});

test('same employee is freshly checked for scope removal, tool removal and read-only changes', async () => {
  for (const change of [
    (s: ReturnType<typeof fixture>['state']) => {
      s.scopes = [];
    },
    (s: ReturnType<typeof fixture>['state']) => {
      s.tool.annotations = { readOnlyHint: false };
    },
    (s: ReturnType<typeof fixture>['state']) => {
      s.tool.name = 'other_documents';
    },
  ]) {
    const { state, client } = fixture();
    await client.describe(sender);
    change(state);
    await assert.rejects(client.call(sender, name, {}), /TOOL_UNAVAILABLE/);
    assert.equal(sourceCalls(state.calls).length, 0);
  }
});

test('discovery follows bounded pages, including empty pages, and rejects cycles and duplicate tool names', async () => {
  const { state, client } = fixture();
  state.pages = (cursor) =>
    cursor === 'next' ? { tools: [contextTool, descriptor()] } : { tools: [], nextCursor: 'next' };
  assert.equal((await client.discover(sender)).length, 2);
  state.pages = () => ({ tools: [], nextCursor: 'cycle' });
  await assert.rejects(client.discover(sender), /INVALID_RESPONSE/);
  state.pages = (cursor) =>
    cursor ? { tools: [contextTool] } : { tools: [contextTool], nextCursor: 'next' };
  await assert.rejects(client.discover(sender), /INVALID_RESPONSE/);
  state.pages = (cursor) => ({ tools: [], nextCursor: `${cursor ?? ''}x` });
  await assert.rejects(client.discover(sender), /RESPONSE_TOO_LARGE/);
});

test('call-time schema is current and malformed output never reaches accepted evidence', async () => {
  const { state, client } = fixture();
  await client.describe(sender);
  state.tool.outputSchema = { type: 'object', required: ['missing_required_field'] };
  await assert.rejects(client.call(sender, name, {}), /INVALID_RESPONSE/);
  state.tool = descriptor();
  await assert.rejects(client.call(sender, name, { unsupported: true }), /INVALID_ARGUMENTS/);
});

test('concurrent employees have isolated catalogues, context, guidance and credentials', async () => {
  const { client } = fixture();
  const [a, b] = await Promise.all([
    client.describe(sender),
    client.describe({ ...sender, phoneE164: '+919000000044' }),
  ]);
  assert.equal(
    a.tools.some((tool) => tool.name === name),
    true,
  );
  assert.equal(
    b.tools.some((tool) => tool.name === name),
    false,
  );
  assert.equal(a.context.query_guidance, 'LIVE_CONTEXT_23');
  assert.equal(b.context.query_guidance, 'LIVE_CONTEXT_44');
  assert.equal(b.guidance, 'LIVE_SOURCE_GUIDANCE_44');
});

test('production cache requests replay row authorization and replace accepted evidence instead of reusing it', async () => {
  const { state, bound } = fixture();
  const run = (await ContextToolRun.open(async () => bound(), undefined, signal()))!;
  const first = await run.execute(name, '{}', signal());
  state.count = 3;
  const second = await run.executeCached(name, {}, signal());
  assert.equal(second?.result.data.count, 3);
  assert.notEqual(second?.id, first.evidence_id);
  assert.equal(sourceCalls(state.calls).length, 2);
  assert.equal(run.evidence.length, 1);
  state.scopes = [];
  assert.equal(await run.executeCached(name, {}, signal()), undefined);
  assert.equal(run.evidence.length, 0);
  assert.equal(run.delivery()?.historicalOnly, true);
  assert.deepEqual(run.delivery()?.checks, []);
  assert.equal(sourceCalls(state.calls).length, 2);
});

test('dynamic receipts replay through current employee scopes and detect source changes', async () => {
  const { state, service } = fixture();
  const run = (await service.openTools(trusted, signal())).run!;
  await run.execute(name, '{}', signal());
  const receipt = run.delivery();
  assert.equal(await service.canDeliver(trusted.key, receipt, signal()), true);
  state.count = 7;
  assert.equal(await service.canDeliver(trusted.key, receipt, signal()), false);
  state.count = 2;
  state.scopes = [];
  assert.equal(await service.canDeliver(trusted.key, receipt, signal()), false);
});

test('new read tools accept schema-declared recipient and destination filters without changing actor identity', async () => {
  const { state, bound } = fixture();
  state.tool.inputSchema = {
    type: 'object',
    properties: {
      recipient: { type: 'string' },
      destination: { type: 'string' },
    },
    additionalProperties: false,
  };
  const run = (await ContextToolRun.open(async () => bound(), undefined, signal()))!;
  assert.equal(
    (
      await run.execute(
        name,
        JSON.stringify({ recipient: 'Fixture Team', destination: 'Fixture City' }),
        signal(),
      )
    ).ok,
    true,
  );
  assert.equal(
    (await run.execute(name, JSON.stringify({ employee_id: 44 }), signal())).code,
    'INVALID_ARGUMENTS',
  );
  assert.equal(run.employeeId, 23);
  assert.equal(sourceCalls(state.calls).length, 1);
});

for (const needsFormatter of [false, true]) {
  test(`applicable graph roles receive live guidance and safe context with ${needsFormatter ? 'model synthesis' : 'deterministic formatting'}`, async () => {
    const { service } = fixture();
    const stages = new Set<string>();
    const check = (instructions: string) => {
      assert.match(instructions, /LIVE_SOURCE_GUIDANCE_23/);
      assert.match(instructions, /LIVE_CONTEXT_23/);
      assert.doesNotMatch(instructions, /PRIVATE_SECRET|PRIVATE_PHONE/);
    };
    const model: TextModel = {
      async complete(request) {
        stages.add(request.stage);
        check(request.instructions);
        if (request.stage === 'formatter') {
          assert.equal(needsFormatter, true, 'a completed bounded answer needs no model rewrite');
          const input = JSON.parse(request.messages[0]!.content);
          assert.deepEqual(input.source_tool_definitions, [
            { name, description: descriptor().description },
          ]);
        }
        const text =
          request.stage === 'converser'
            ? JSON.stringify({ route: 'work', objective: 'Count my documents', reply: '' })
            : request.stage === 'planner'
              ? JSON.stringify({
                  objective: 'Count my documents',
                  successCriteria: ['Return permitted document count'],
                  steps: [
                    {
                      id: 'read',
                      goal: 'Read permitted documents',
                      dependsOn: [],
                      toolNames: [name],
                    },
                  ],
                })
              : request.stage === 'verifier'
                ? JSON.stringify({ supported: true, repair: 'none', feedback: '' })
                : 'You have 2 documents.';
        return { text, inputTokens: 1, outputTokens: 1 };
      },
      startToolSession(request) {
        check(request.instructions);
        stages.add('worker');
        assert.ok(request.tools.some((tool) => tool.name === name));
        let count = 0;
        return {
          async next() {
            return {
              // Oversized completed drafts still need synthesis; ordinary answers retain the worker text.
              text: count++
                ? 'You have 2 documents.\n'.repeat(needsFormatter ? 650 : 1).trim()
                : '',
              calls: count === 1 ? [{ id: 'one', name, arguments: '{}' }] : [],
              inputTokens: 1,
              outputTokens: 1,
            };
          },
          accept() {},
        };
      },
    };
    const graph = buildSalesGraph(model, (s) => service.openTools(trusted, s));
    const result = await graph.invoke(
      { input: 'How many documents can I see?', history: [], audience: 'dm' },
      { recursionLimit: 30 },
    );
    assert.equal(result.reply, 'You have 2 documents.');
    assert.deepEqual([...stages].sort(), [
      'converser',
      ...(needsFormatter ? ['formatter'] : []),
      'planner',
      'verifier',
      'worker',
    ]);
    assert.equal(await service.canDeliver(trusted.key, result.business?.delivery, signal()), true);
  });
}
