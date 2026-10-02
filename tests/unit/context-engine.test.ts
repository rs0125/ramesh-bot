/** Uses the real MCP SDK with synthetic HTTP responses. No business backend or WhatsApp connection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadContextEngineConfig } from '../../src/config/context-engine.js';
import { createContextEngineServices } from '../../src/app/context-engine.js';
import { ContextEngineMcpClient } from '../../src/infrastructure/context-engine/mcp-client.js';
import { ContextEngineServices } from '../../src/modules/context-engine/context.service.js';
import {
  ContextEngineError,
  type ContextCredentialResolver,
  type ContextErrorCode,
  type ContextReadTool,
  type ContextSender,
} from '../../src/modules/context-engine/context.types.js';

const config = {
  endpoint: 'https://context.example/mcp',
  timeoutMs: 1000,
  maxResponseBytes: 16384,
};
const sender: ContextSender = { phoneE164: '+919876543210', audience: 'dm' };
const token = (letter = 'a') => `wog_mcp_at_${letter.repeat(43)}`;
const credential = (employeeId = 23, letter = 'a') => ({
  employeeId,
  phoneE164: sender.phoneE164,
  active: true,
  accessToken: token(letter),
  expiresAtMs: Date.now() + 900000,
});
const resolver: ContextCredentialResolver = {
  async resolve() {
    return credential();
  },
};
const result = (data: Record<string, unknown>, path = '/api/v1/crm/opportunities') => ({
  source_path: path,
  status: 200 as const,
  data,
  meta: {
    requestId: 'source-request-id',
    generatedAt: '2026-10-01T01:00:00Z',
    source_status: 'degraded',
  },
});
type Rpc = { id?: string | number; method: string; params?: Record<string, unknown> };
function fakeServer(
  options: {
    employeeId?: (auth: string) => number;
    call?: (rpc: Rpc) => Record<string, unknown>;
    http?: (rpc: Rpc, request: Request) => Response | undefined;
    tools?: string[];
    scopes?: string[];
    readOnly?: boolean;
    guidance?: string;
  } = {},
) {
  const calls: { rpc: Rpc; auth: string }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, config.endpoint);
    assert.equal(request.redirect, 'error');
    const auth = request.headers.get('authorization') ?? '';
    if (request.method === 'GET') return new Response(null, { status: 405 });
    const rpc = (await request.json()) as Rpc;
    calls.push({ rpc, auth });
    const intercepted = options.http?.(rpc, request);
    if (intercepted) return intercepted;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let reply: unknown;
    if (rpc.method === 'initialize')
      reply = {
        protocolVersion: rpc.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'context-fixture', version: '1' },
        instructions: options.guidance,
      };
    else if (rpc.method === 'tools/list')
      reply = {
        tools: (
          options.tools ?? ['get_context', 'search_crm_leads', 'read_warehouse', 'delete_crm_lead']
        ).map((name) => ({
          name,
          description: 'Synthetic tool',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: name === 'get_context' || options.readOnly !== false },
        })),
      };
    else if (rpc.method === 'tools/call') {
      if (rpc.params?.name === 'get_context')
        reply = {
          content: [],
          structuredContent: result(
            {
              employee_id: options.employeeId?.(auth) ?? 23,
              scopes: options.scopes ?? ['crm:read', 'warehouses:read'],
              read_only: true,
            },
            '/api/v1/context',
          ),
        };
      else
        reply = options.call?.(rpc) ?? {
          content: [],
          structuredContent: result({ items: [], nextCursor: null }),
        };
    } else throw new Error('Unexpected fixture request');
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: reply });
  };
  return { calls, fetch: fakeFetch };
}
const failsWith = (code: ContextErrorCode) => (error: unknown) =>
  error instanceof ContextEngineError && error.code === code;

test('MCP performs discovery, verifies employee identity, and preserves evidence and cursors', async () => {
  const data = {
    items: [
      { id: 'lead', field_evidence: { budget: { state: 'missing' } }, verification_required: true },
    ],
    nextCursor: 'opaque cursor',
    source_status: { notes: { status: 'error' } },
    access_scope: 'created_or_assigned',
  };
  const fixture = fakeServer({ call: () => ({ content: [], structuredContent: result(data) }) });
  const client = new ContextEngineMcpClient(config, resolver, fixture.fetch);
  const response = await client.call(sender, 'search_crm_leads', { view: 'assigned', limit: 1 });
  assert.deepEqual(response, result(data));
  const toolCalls = fixture.calls.filter(({ rpc }) => rpc.method === 'tools/call');
  assert.deepEqual(
    toolCalls.map(({ rpc }) => rpc.params?.name),
    ['get_context', 'search_crm_leads'],
  );
  assert.deepEqual(toolCalls[1]!.rpc.params?.arguments, { view: 'assigned', limit: 1 });
  assert.ok(fixture.calls.every(({ auth }) => auth === `Bearer ${token()}`));
  assert.ok(!JSON.stringify(toolCalls.map(({ rpc }) => rpc)).includes(sender.phoneE164));
  assert.ok(!JSON.stringify(toolCalls.map(({ rpc }) => rpc)).includes(token()));
});

test('discovery exposes only approved, granted read tools; future writes are refused before auth', async () => {
  const fixture = fakeServer({ scopes: ['crm:read'] });
  const client = new ContextEngineMcpClient(config, resolver, fixture.fetch);
  assert.deepEqual(
    (await client.discover(sender)).map((tool) => tool.name),
    ['get_context', 'search_crm_leads'],
  );
  const before = fixture.calls.length;
  await assert.rejects(
    client.call(sender, 'delete_crm_lead' as ContextReadTool, {}),
    failsWith('TOOL_UNAVAILABLE'),
  );
  assert.equal(fixture.calls.length, before);
  await assert.rejects(
    client.call(sender, 'read_warehouse', { id: 1 }),
    failsWith('TOOL_UNAVAILABLE'),
  );
  assert.ok(!fixture.calls.some(({ rpc }) => rpc.params?.name === 'read_warehouse'));
});

test('unknown, expired, inactive, REST-key, mismatched-phone and group identities cannot connect', async () => {
  const fixture = fakeServer();
  for (const grant of [
    null,
    { ...credential(), expiresAtMs: Date.now() - 1 },
    { ...credential(), active: false },
    { ...credential(), accessToken: 'employee-rest-key' },
    { ...credential(), phoneE164: '+919876543211' },
  ]) {
    const client = new ContextEngineMcpClient(
      config,
      {
        async resolve() {
          return grant;
        },
      },
      fixture.fetch,
    );
    await assert.rejects(client.call(sender, 'search_crm_leads', {}), failsWith('AUTH_REQUIRED'));
  }
  const client = new ContextEngineMcpClient(config, resolver, fixture.fetch);
  await assert.rejects(
    client.discover({ ...sender, audience: 'group' }),
    failsWith('ACCESS_DENIED'),
  );
  assert.equal(fixture.calls.length, 0);
});

test('a token belonging to another employee never reaches a business tool', async () => {
  const fixture = fakeServer({ employeeId: () => 99 });
  const client = new ContextEngineMcpClient(config, resolver, fixture.fetch);
  await assert.rejects(client.call(sender, 'search_crm_leads', {}), failsWith('ACCESS_DENIED'));
  assert.deepEqual(
    fixture.calls
      .filter(({ rpc }) => rpc.method === 'tools/call')
      .map(({ rpc }) => rpc.params?.name),
    ['get_context'],
  );
});

test('concurrent employees get separate MCP connections and authorization headers', async () => {
  const other = { ...sender, phoneE164: '+919876543211' };
  const fixture = fakeServer({ employeeId: (auth) => (auth === `Bearer ${token('b')}` ? 44 : 23) });
  const client = new ContextEngineMcpClient(
    config,
    {
      async resolve(who) {
        return {
          ...credential(
            who.phoneE164 === other.phoneE164 ? 44 : 23,
            who.phoneE164 === other.phoneE164 ? 'b' : 'a',
          ),
          phoneE164: who.phoneE164,
        };
      },
    },
    fixture.fetch,
  );
  await Promise.all([
    client.call(sender, 'search_crm_leads', {}),
    client.call(other, 'search_crm_leads', {}),
  ]);
  assert.equal(fixture.calls.filter(({ rpc }) => rpc.method === 'initialize').length, 2);
  assert.deepEqual(
    fixture.calls
      .filter(({ rpc }) => rpc.params?.name === 'search_crm_leads')
      .map(({ auth }) => auth)
      .sort(),
    [`Bearer ${token()}`, `Bearer ${token('b')}`],
  );
});

test('HTTP and tool failures return safe typed errors without leaking source text', async () => {
  for (const [status, code] of [
    [401, 'AUTH_REQUIRED'],
    [403, 'ACCESS_DENIED'],
    [429, 'RATE_LIMITED'],
    [503, 'UNAVAILABLE'],
  ] as const) {
    const fixture = fakeServer({
      http: () => new Response(`secret=${token()}`, { status, headers: { 'retry-after': '12' } }),
    });
    await assert.rejects(
      new ContextEngineMcpClient(config, resolver, fixture.fetch).discover(sender),
      failsWith(code),
    );
  }
  const fixture = fakeServer({
    call: () => ({
      isError: true,
      content: [],
      structuredContent: { status: 503, error: { message: token() }, retry_after_seconds: 10 },
    }),
  });
  await assert.rejects(
    new ContextEngineMcpClient(config, resolver, fixture.fetch).call(
      sender,
      'search_crm_leads',
      {},
    ),
    (error: unknown) => {
      assert.ok(error instanceof ContextEngineError);
      assert.equal(error.code, 'UNAVAILABLE');
      assert.equal(error.retryAfterSeconds, 10);
      assert.ok(!String(error.stack).includes(token()));
      return true;
    },
  );
});

test('text results parse safely; malformed and oversized responses fail closed', async () => {
  const text = fakeServer({
    call: () => ({ content: [{ type: 'text', text: JSON.stringify(result({ items: [] })) }] }),
  });
  assert.deepEqual(
    (
      await new ContextEngineMcpClient(config, resolver, text.fetch).call(
        sender,
        'search_crm_leads',
        {},
      )
    ).data,
    { items: [] },
  );
  const broken = fakeServer({ call: () => ({ content: [{ type: 'text', text: 'not JSON' }] }) });
  await assert.rejects(
    new ContextEngineMcpClient(config, resolver, broken.fetch).call(sender, 'search_crm_leads', {}),
    failsWith('INVALID_RESPONSE'),
  );
  const large = fakeServer({
    call: () => ({ content: [], structuredContent: result({ text: 'x'.repeat(20000) }) }),
  });
  await assert.rejects(
    new ContextEngineMcpClient(config, resolver, large.fetch).call(sender, 'search_crm_leads', {}),
    failsWith('RESPONSE_TOO_LARGE'),
  );
});

test('cancellation and deadlines stop requests without retrying', async () => {
  let attempts = 0;
  const hanging: typeof fetch = async (_input, init) => {
    attempts++;
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('private failure')), {
        once: true,
      }),
    );
  };
  const client = new ContextEngineMcpClient(config, resolver, hanging);
  const abort = new AbortController();
  const pending = client.call(sender, 'search_crm_leads', {}, abort.signal);
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(pending, failsWith('CANCELLED'));
  const before = attempts;
  await assert.rejects(
    client.call(sender, 'search_crm_leads', {}, AbortSignal.abort()),
    failsWith('CANCELLED'),
  );
  assert.equal(attempts, before);
  await assert.rejects(client.call(sender, 'search_crm_leads', {}), failsWith('TIMEOUT'));
  assert.equal(attempts, before + 1);
});

test('configuration restricts destinations and leaves the current app disconnected', async () => {
  assert.equal(loadContextEngineConfig({}), undefined);
  assert.equal(createContextEngineServices(undefined), undefined);
  for (const endpoint of [
    'http://remote.example/mcp',
    'https://user:password@context.example/mcp',
    'https://context.example/mcp?token=private',
    'https://context.example/other',
  ])
    assert.throws(() => loadContextEngineConfig({ CONTEXT_MCP_URL: endpoint }));
  assert.ok(loadContextEngineConfig({ CONTEXT_MCP_URL: 'http://127.0.0.1:3000/mcp' }));
  await assert.rejects(
    createContextEngineServices(config)!.forSender(sender).crm.briefing(),
    failsWith('AUTH_REQUIRED'),
  );
});

test('a stalled credential resolver respects cancellation before connecting', async () => {
  const fixture = fakeServer();
  const client = new ContextEngineMcpClient(
    config,
    { resolve: () => new Promise(() => {}) },
    fixture.fetch,
  );
  const abort = new AbortController();
  const pending = client.discover(sender, abort.signal);
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(pending, failsWith('CANCELLED'));
  assert.equal(fixture.calls.length, 0);
});

test('domain services map to existing MCP tools while keeping identity out of arguments', async () => {
  const recorded: { name: ContextReadTool; args: Record<string, unknown> }[] = [];
  const services = new ContextEngineServices({
    async discover() {
      return [];
    },
    async call(who, name, args) {
      assert.deepEqual(who, sender);
      recorded.push({ name, args });
      return result({});
    },
  }).forSender(sender);
  await services.crm.leadContext('lead-id', 'notes', { limit: 2, cursor: 'opaque' });
  await services.crm.assessShortlist('lead-id', [4, 5], { city: 'Bengaluru' });
  await services.supply.readWarehouse(4);
  await services.knowledge.readPage('leasing-guide');
  assert.deepEqual(recorded, [
    {
      name: 'read_crm_lead_context',
      args: { id: 'lead-id', section: 'notes', limit: 2, cursor: 'opaque' },
    },
    {
      name: 'assess_shortlist',
      args: { lead_id: 'lead-id', warehouse_ids: [4, 5], city: 'Bengaluru' },
    },
    { name: 'read_warehouse', args: { id: 4 } },
    { name: 'read_knowledge', args: { id: 'leasing-guide' } },
  ]);
});

test('server guidance and analytics error recovery survive the MCP adapter without raw messages', async () => {
  const guidance = 'Search Console uses its source timezone.';
  const fixture = fakeServer({
    guidance,
    tools: ['get_context', 'ga4_report'],
    scopes: ['analytics:read'],
    call: () => ({
      isError: true,
      content: [],
      structuredContent: {
        status: 503,
        error: {
          code: 'ANALYTICS_SOURCE_DENIED',
          message: token(),
          recovery: { retryable: false, action: 'check_google_access', guidance: token() },
        },
        retry_after_seconds: 10,
      },
    }),
  });
  const client = new ContextEngineMcpClient(config, resolver, fixture.fetch);
  assert.equal((await client.describe(sender)).guidance, guidance);
  await assert.rejects(client.call(sender, 'ga4_report', {}), (e: unknown) => {
    assert.ok(e instanceof ContextEngineError);
    assert.equal(e.retryable, false);
    assert.equal(e.retryAfterSeconds, undefined);
    assert.equal(e.recovery?.action, 'check_google_access');
    assert.ok(!JSON.stringify(e).includes(token()));
    return true;
  });
});
