/** Synthetic MCP traffic exercises the existing dynamic reader; no location-specific bot wiring. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextEngineMcpClient } from '../../src/infrastructure/context-engine/mcp-client.js';
import { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import {
  isContextReadTool,
  type ContextToolDefinition,
} from '../../src/modules/context-engine/context.types.js';
import {
  argumentsSha256,
  READ_CONTRACT_KEY,
} from '../../src/modules/context-engine/read-contract.js';

test('a discovered location read with no business scope replays stable evidence and retains employee authorization', async () => {
  const name = 'resolve_location';
  const args = { latitude: 0, longitude: 78.125 };
  const descriptor: ContextToolDefinition = {
    name,
    description:
      'Resolve supplied coordinates as location source data; this does not save a point.',
    inputSchema: {
      type: 'object',
      properties: { latitude: { type: 'number' }, longitude: { type: 'number' } },
      required: ['latitude', 'longitude'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            status: { const: 'resolved' },
            candidates: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  latitude: { type: 'number' },
                  longitude: { type: 'number' },
                  method: { const: 'supplied_coordinates' },
                  requiresConfirmation: { type: 'boolean' },
                },
                required: ['latitude', 'longitude', 'method', 'requiresConfirmation'],
                additionalProperties: false,
              },
            },
            source: {
              type: 'object',
              properties: {
                kind: { const: 'coordinates' },
                latitude: { type: 'number' },
                longitude: { type: 'number' },
              },
              required: ['kind', 'latitude', 'longitude'],
              additionalProperties: false,
            },
            reason: { type: 'string' },
          },
          required: ['status', 'candidates', 'source', 'reason'],
          additionalProperties: false,
        },
      },
      required: ['data'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: { [READ_CONTRACT_KEY]: { requiredScopes: [], sourceFamily: 'context' } },
  };
  const endpoint = 'https://context.example/mcp';
  const sender = { phoneE164: '+919000000023', audience: 'dm' as const };
  const trusted = { key: { remoteJid: '919000000023@s.whatsapp.net' }, runId: 'location-fixture' };
  let now = Date.now(),
    active = true,
    longitude = args.longitude,
    requests = 0;
  const sourceCalls: Array<Record<string, unknown>> = [];
  const client = new ContextEngineMcpClient(
    { endpoint, timeoutMs: 5000, maxResponseBytes: 1048576 },
    {
      async resolve(who) {
        return active
          ? {
              employeeId: 23,
              phoneE164: who.phoneE164,
              active: true,
              accessToken: `wog_mcp_at_${'a'.repeat(43)}`,
              expiresAtMs: Date.now() + 60000,
            }
          : null;
      },
    },
    async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, endpoint);
      if (request.method === 'GET') return new Response(null, { status: 405 });
      const rpc = (await request.json()) as {
        id?: string | number;
        method: string;
        params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
      };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: rpc.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'synthetic-location-context', version: '1' },
        };
      else if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'get_context',
              inputSchema: { type: 'object' },
              annotations: { readOnlyHint: true },
            },
            descriptor,
          ],
        };
      else {
        assert.equal(rpc.method, 'tools/call');
        const called = rpc.params?.name;
        assert.ok(
          called === 'get_context' || called === name,
          'no write or other source can be called',
        );
        const inputArgs = rpc.params?.arguments ?? {};
        if (called === name) sourceCalls.push(inputArgs);
        result = {
          content: [],
          structuredContent: {
            source_path: called === name ? '/api/v1/locations/resolve' : '/api/v1/context',
            status: 200,
            data:
              called === name
                ? {
                    status: 'resolved',
                    candidates: [
                      {
                        latitude: args.latitude,
                        longitude,
                        method: 'supplied_coordinates',
                        requiresConfirmation: false,
                      },
                    ],
                    source: {
                      kind: 'coordinates',
                      latitude: args.latitude,
                      longitude: args.longitude,
                    },
                    reason:
                      'An explicit coordinate pair was supplied. This does not verify the address, site or permission to save it.',
                  }
                : { employee_id: 23, scopes: [], read_only: true },
            meta: {
              requestId: `synthetic-${++requests}`,
              generatedAt: new Date(now).toISOString(),
              toolName: called,
              argumentsSha256: argumentsSha256(inputArgs),
            },
          },
        };
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  );
  const service = new BusinessReadService(
    async () =>
      active
        ? {
            employeeId: 23,
            search: async () => {
              throw new Error('Legacy CRM port must not run');
            },
            tools: {
              employeeId: 23,
              discover: (signal) => client.discover(sender, signal),
              describe: (signal) => client.describe(sender, signal),
              call: (tool, input, signal) => client.call(sender, tool, input, signal),
            },
          }
        : null,
    'all',
    () => now,
    true,
  );
  const signal = new AbortController().signal;
  assert.equal(isContextReadTool(name), false, 'compatibility must use the generic read contract');
  const { status, run } = await service.openTools(trusted, signal);
  assert.equal(status, 'available');
  assert.ok(run);
  assert.deepEqual(
    run.tools.find((tool) => tool.name === name),
    descriptor,
  );
  assert.equal((await run.execute(name, JSON.stringify(args), signal)).ok, true);
  const receipt = run.delivery();
  assert.ok(receipt);
  assert.deepEqual(sourceCalls, [args]);
  assert.deepEqual(run.evidence[0]!.result.data.candidates, [
    {
      latitude: 0,
      longitude: args.longitude,
      method: 'supplied_coordinates',
      requiresConfirmation: false,
    },
  ]);
  assert.deepEqual(run.evidence[0]!.result.data.source, { kind: 'coordinates', ...args });
  assert.equal(run.evidence[0]!.result.source_path, '/api/v1/locations/resolve');
  assert.equal('resolved_at' in run.evidence[0]!.result.data, false);
  now += 1000;
  assert.equal(
    await service.canDeliver(trusted.key, receipt, signal),
    true,
    'fresh metadata with identical normalized location facts must preserve delivery',
  );
  assert.deepEqual(sourceCalls, [args, args]);
  longitude += 0.001;
  assert.equal(
    await service.canDeliver(trusted.key, receipt, signal),
    false,
    'a changed resolved coordinate must invalidate the prior answer',
  );
  longitude = args.longitude;
  active = false;
  const beforeRevocation = sourceCalls.length;
  assert.equal(
    await service.canDeliver(trusted.key, receipt, signal),
    false,
    'empty requiredScopes does not remove employee authorization',
  );
  assert.equal(sourceCalls.length, beforeRevocation);
});
