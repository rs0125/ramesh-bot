/** Synthetic protocol receipts only. No model, business data, database or mutation endpoint. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextEngineMcpClient } from '../../src/infrastructure/context-engine/mcp-client.js';
import {
  argumentsSha256,
  READ_CONTRACT_KEY,
} from '../../src/modules/context-engine/read-contract.js';
import {
  admittedWriteTool,
  contextWriteDescriptor,
  writeContract,
  WRITE_CONTRACT_KEY,
} from '../../src/modules/context-engine/write-contract.js';
import type {
  ContextToolDefinition,
  ContextWriteResult,
} from '../../src/modules/context-engine/context.types.js';
const operation = '11111111-1111-4111-8111-111111111111';
const sender = { phoneE164: '+919000000023', audience: 'dm' as const };
const endpoint = 'https://context.example/mcp';
const args = { operation_id: operation, title: 'Synthetic note' };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
function descriptor(): ContextToolDefinition {
  return {
    name: 'create_note',
    description: 'Create a private note with explicit authorization.',
    inputSchema: object({
      operation_id: { type: 'string', format: 'uuid' },
      title: { type: 'string', minLength: 1, maxLength: 200 },
    }),
    outputSchema: object(
      {
        operation_id: { type: 'string', format: 'uuid' },
        outcome: {
          type: 'string',
          enum: [
            'created',
            'replayed',
            'rolled_back',
            'not_dispatched',
            'rejected',
            'outcome_unknown',
          ],
        },
        code: { type: 'string' },
        message: { type: 'string' },
        data: object({ id: { type: 'string' } }),
        meta: object({
          toolName: { type: 'string' },
          argumentsSha256: { type: 'string' },
          employeeId: { type: 'integer' },
        }),
      },
      ['operation_id', 'outcome', 'code', 'message', 'meta'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    _meta: {
      [WRITE_CONTRACT_KEY]: {
        requiredScopes: ['notes:write'],
        sourceFamily: 'notes',
        effect: 'create',
        idempotencyArgument: 'operation_id',
      },
    },
  };
}

test('source-text metadata must point to a required string distinct from operation identity', () => {
  const tool = descriptor();
  const contract = tool._meta![WRITE_CONTRACT_KEY] as Record<string, unknown>;
  contract.sourceTextArgument = 'title';
  contract.requiredScopes = ['crm.rfq:write'];
  assert.equal(contextWriteDescriptor(tool), true);
  assert.equal(admittedWriteTool(tool, ['crm:read']), false);
  assert.equal(admittedWriteTool(tool, ['crm.rfq:write']), true);
  for (const field of ['missing', 'operation_id', '_source_message_ids']) {
    contract.sourceTextArgument = field;
    assert.equal(contextWriteDescriptor(tool), false);
  }
});
function fixture() {
  const state = {
    tool: descriptor(),
    scopes: ['notes:write'],
    capabilities: ['create_note'],
    readOnly: false,
    dispatched: 0,
    failure: undefined as undefined | 'network' | 'http' | 'rpc',
    mutate: undefined as undefined | ((receipt: ContextWriteResult) => void),
    resolved: true,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.headers.get('x-user-id'), null);
    if (request.method === 'GET') return new Response(null, { status: 405 });
    const rpc = (await request.json()) as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
    };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: rpc.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'synthetic', version: '1' },
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'get_context',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
          state.tool,
        ],
      };
    else if (rpc.params?.name === 'get_context')
      result = {
        content: [],
        structuredContent: {
          source_path: '/api/v1/context',
          status: 200,
          data: {
            employee_id: 23,
            scopes: state.scopes,
            read_only: state.readOnly,
            write_capabilities: state.capabilities,
          },
          meta: {
            requestId: 'synthetic',
            generatedAt: new Date().toISOString(),
            toolName: 'get_context',
            argumentsSha256: argumentsSha256({}),
          },
        },
      };
    else {
      state.dispatched++;
      if (state.failure === 'network') throw new Error('private transport detail');
      if (state.failure === 'http') return new Response(null, { status: 401 });
      if (state.failure === 'rpc')
        return Response.json({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32602, message: 'unknown argument' },
        });
      const receipt: ContextWriteResult = {
        operation_id: operation,
        outcome: 'created',
        code: 'NOTE_CREATED',
        message: 'Note created.',
        data: { id: 'synthetic' },
        meta: {
          toolName: state.tool.name,
          argumentsSha256: argumentsSha256(rpc.params?.arguments ?? {}),
          employeeId: 23,
        },
      };
      state.mutate?.(receipt);
      result = {
        content: [],
        structuredContent: receipt,
        ...(!['created', 'replayed', 'rolled_back'].includes(receipt.outcome)
          ? { isError: true }
          : {}),
      };
    }
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  };
  const client = new ContextEngineMcpClient(
    { endpoint, timeoutMs: 1000, maxResponseBytes: 1048576 },
    {
      async resolve() {
        if (!state.resolved) return null;
        return {
          employeeId: 23,
          phoneE164: sender.phoneE164,
          active: true,
          accessToken: `wog_mcp_at_${'a'.repeat(43)}`,
          expiresAtMs: Date.now() + 60000,
        };
      },
    },
    fetcher,
  );
  const call = () => client.callWrite(sender, state.tool.name, args, operation);
  return { state, client, call };
}
test('generic write discovery stays separate from read executor and fresh permissions', async () => {
  const { state, client } = fixture();
  assert.deepEqual(
    (await client.discoverWrites(sender)).map((t) => t.name),
    ['create_note'],
  );
  assert.deepEqual(
    (await client.discover(sender)).map((t) => t.name),
    ['get_context'],
  );
  await assert.rejects(client.call(sender, 'create_note', args), /TOOL_UNAVAILABLE/);
  assert.equal(state.dispatched, 0);
  state.scopes = [];
  state.capabilities = [];
  state.readOnly = true;
  assert.deepEqual(await client.discoverWrites(sender), []);
  assert.equal(
    (await client.callWrite(sender, 'create_note', args, operation)).outcome,
    'not_dispatched',
  );
  assert.equal(state.dispatched, 0);
});
test('model-free delivery rediscovery never sends a write', async () => {
  const { client, state } = fixture();
  await client.describeWrites(sender);
  await client.describeWrites(sender);
  assert.equal(state.dispatched, 0);
});
for (const outcome of ['created', 'replayed', 'rolled_back'] as const)
  test(`accepts actor/request-bound ${outcome} exactly once`, async () => {
    const { state, call } = fixture();
    state.mutate = (r) => {
      r.outcome = outcome;
    };
    assert.equal((await call()).outcome, outcome);
    assert.equal(state.dispatched, 1);
  });
for (const failure of ['network', 'http', 'rpc'] as const)
  test(`single-attempt ${failure} ambiguity never retries or invents rollback`, async () => {
    const { state, call } = fixture();
    state.failure = failure;
    const receipt = await call();
    assert.equal(receipt.outcome, 'outcome_unknown');
    assert.equal(state.dispatched, 1);
    assert.equal(receipt.data, undefined);
    assert.doesNotMatch(JSON.stringify(receipt), /private transport/);
  });
for (const field of ['employee', 'hash', 'operation', 'tool', 'schema'] as const)
  test(`mismatched ${field} receipt is redacted uncertainty`, async () => {
    const { state, call } = fixture();
    state.mutate = (r) => {
      if (field === 'employee') r.meta!.employeeId = 24;
      if (field === 'hash') r.meta!.argumentsSha256 = 'f'.repeat(64);
      if (field === 'tool') r.meta!.toolName = 'other_tool';
      if (field === 'operation') r.operation_id = '22222222-2222-4222-8222-222222222222';
      if (field === 'schema') r.data = { secret: 'unapproved' };
    };
    const receipt = await call();
    assert.equal(receipt.outcome, 'outcome_unknown');
    assert.equal(receipt.data, undefined);
    assert.equal(state.dispatched, 1);
  });
test('bound arguments and schemas reject before mutation', async () => {
  const { state, client } = fixture();
  for (const invalid of [
    { ...args, operation_id: '22222222-2222-4222-8222-222222222222' },
    { ...args, employeeId: 44 },
    { ...args, _source_message_ids: ['source'] },
  ])
    assert.equal(
      (await client.callWrite(sender, 'create_note', invalid, operation)).outcome,
      'not_dispatched',
    );
  assert.equal(state.dispatched, 0);
  state.resolved = false;
  assert.equal(
    (await client.callWrite(sender, 'create_note', args, operation)).outcome,
    'not_dispatched',
  );
  assert.equal(state.dispatched, 0);
});
test('malformed capability claims fail closed without weakening reads', async () => {
  const { state, client } = fixture();
  state.readOnly = true;
  await assert.rejects(client.describeWrites(sender), /INVALID_RESPONSE/);
  state.readOnly = false;
  state.capabilities = ['invented'];
  await assert.rejects(client.describe(sender), /INVALID_RESPONSE/);
  assert.equal(state.dispatched, 0);
});
test('descriptor rejects open schemas, conflicts, model identity headers, reserved names and incomplete compensation', () => {
  assert.equal(admittedWriteTool(descriptor(), ['notes:write']), true);
  assert.equal(admittedWriteTool(descriptor(), ['notes:read']), false);
  const edits: ((t: ContextToolDefinition) => void)[] = [
    (t) => {
      t.annotations!.readOnlyHint = true;
    },
    (t) => {
      t.annotations!.idempotentHint = false;
    },
    (t) => {
      t.inputSchema.additionalProperties = true;
    },
    (t) => {
      t._meta![READ_CONTRACT_KEY] = { requiredScopes: ['notes:read'], sourceFamily: 'notes' };
    },
    (t) => {
      t.name = 'write_history';
    },
    (t) => {
      t.name = 'write_sources';
    },
    (t) => {
      t.inputSchema['x-header-map'] = {};
    },
    (t) => {
      (t.inputSchema.properties as Record<string, unknown>)._source_message_ids = { type: 'array' };
    },
    (t) => {
      (t.inputSchema.properties as Record<string, unknown>).nested = { type: ['object', 'null'] };
    },
    (t) => {
      (t._meta![WRITE_CONTRACT_KEY] as Record<string, unknown>).effect = 'compensate';
    },
  ];
  for (const edit of edits) {
    const tool = descriptor();
    edit(tool);
    assert.equal(contextWriteDescriptor(tool), false);
  }
});
test('generic compensation and native coordinate metadata are validated without GIS names', () => {
  const tool = descriptor();
  tool.name = 'undo_note';
  tool.annotations!.destructiveHint = true;
  (tool._meta![WRITE_CONTRACT_KEY] as Record<string, unknown>) = {
    requiredScopes: ['notes:write'],
    sourceFamily: 'notes',
    effect: 'compensate',
    idempotencyArgument: 'operation_id',
    compensates: 'create_note',
    originalOperationArgument: 'original_id',
  };
  (tool.inputSchema.properties as Record<string, unknown>).original_id = {
    type: 'string',
    format: 'uuid',
  };
  (tool.inputSchema.required as string[]).push('original_id');
  assert.equal(contextWriteDescriptor(tool), true);
  const pin = descriptor();
  (pin._meta![WRITE_CONTRACT_KEY] as Record<string, unknown>).coordinateArguments = {
    latitude: 'lat',
    longitude: 'lng',
  };
  Object.assign(pin.inputSchema.properties as object, {
    lat: { type: 'number' },
    lng: { type: 'number' },
  });
  (pin.inputSchema.required as string[]).push('lat', 'lng');
  assert.equal(contextWriteDescriptor(pin), true);
});

test('history authority is an explicit optional domain policy, never inferred from write scope', () => {
  const tool = descriptor();
  assert.equal(contextWriteDescriptor(tool), true);
  assert.equal(writeContract(tool)?.auditHistory, undefined);
  (tool._meta![WRITE_CONTRACT_KEY] as Record<string, unknown>).auditHistory = 'actor_scoped';
  assert.equal(contextWriteDescriptor(tool), true);
  assert.equal(writeContract(tool)?.auditHistory, 'actor_scoped');
  for (const policy of ['all_records', 'scope_suffices', true, {}]) {
    (tool._meta![WRITE_CONTRACT_KEY] as Record<string, unknown>).auditHistory = policy;
    assert.equal(contextWriteDescriptor(tool), false);
  }
});
