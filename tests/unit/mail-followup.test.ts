/** Dynamic MCP follow-up and delivery checks; no model, Gmail or WhatsApp requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ContextEngineMcpClient } from '../../src/infrastructure/context-engine/mcp-client.js';
import { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import {
  argumentsSha256,
  READ_CONTRACT_KEY,
} from '../../src/modules/context-engine/read-contract.js';
import {
  isContextReadTool,
  type ContextToolDefinition,
} from '../../src/modules/context-engine/context.types.js';

test('a later turn discovers draft references, reads the draft, and rechecks content and access before delivery', async () => {
  const ref = '11111111-1111-4111-8111-111111111111';
  const sender = { phoneE164: '+919000000023', audience: 'dm' as const };
  const trusted = { key: { remoteJid: '919000000023@s.whatsapp.net' }, runId: 'mail-followup' };
  const listName = 'list_email_drafts',
    readName = 'read_email_draft';
  const listData = z
    .object({
      items: z.array(z.object({ draft_ref: z.string().uuid(), created_at: z.string() }).strict()),
      nextCursor: z.string().nullable(),
      current_status_verified: z.literal(false),
      guidance: z.string(),
    })
    .strict();
  const readData = z
    .object({
      draft_ref: z.string().uuid(),
      mailbox: z.string(),
      provider: z.literal('gmail'),
      status: z.literal('draft'),
      message_id: z.string(),
      editable: z.boolean(),
      subject: z.string(),
      to: z.array(z.string()),
      cc: z.array(z.string()),
      body: z.string(),
      body_format: z.literal('text'),
      body_truncated: z.boolean(),
      content_guidance: z.string(),
    })
    .strict();
  const definition = (name: string, input: z.ZodType, data: z.ZodType): ContextToolDefinition => ({
    name,
    description:
      name === listName
        ? 'Recover current-mailbox draft references for follow-ups.'
        : 'Read current authorized draft content using a listed draft_ref.',
    inputSchema: z.toJSONSchema(input),
    outputSchema: z.toJSONSchema(z.object({ data }).passthrough()),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    _meta: { [READ_CONTRACT_KEY]: { requiredScopes: ['mail:drafts'], sourceFamily: 'mail' } },
  });
  const tools = [
    { name: 'get_context', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    definition(
      listName,
      z
        .object({
          limit: z.number().int().min(1).max(20).optional(),
          cursor: z.string().uuid().optional(),
        })
        .strict(),
      listData,
    ),
    definition(readName, z.object({ draft_ref: z.string().uuid() }).strict(), readData),
  ];
  let now = Date.now(),
    allowed = true,
    body = 'Synthetic draft content.',
    messageId = 'provider-message-1',
    editable = true;
  const calls: string[] = [];
  const endpoint = 'https://context.example/mcp';
  const client = new ContextEngineMcpClient(
    { endpoint, timeoutMs: 5000, maxResponseBytes: 1048576 },
    {
      async resolve() {
        return {
          employeeId: 23,
          phoneE164: sender.phoneE164,
          active: true,
          accessToken: `wog_mcp_at_${'a'.repeat(43)}`,
          expiresAtMs: Date.now() + 60000,
        };
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
          serverInfo: { name: 'synthetic-mail', version: '1' },
        };
      else if (rpc.method === 'tools/list') result = { tools };
      else {
        assert.equal(rpc.method, 'tools/call');
        const name = rpc.params!.name!,
          args = rpc.params?.arguments ?? {};
        assert.ok(
          ['get_context', listName, readName].includes(name),
          'follow-ups never dispatch a write',
        );
        if (name !== 'get_context') calls.push(name);
        if (name === readName) assert.deepEqual(args, { draft_ref: ref });
        const data =
          name === 'get_context'
            ? { employee_id: 23, scopes: allowed ? ['mail:drafts'] : [], read_only: true }
            : name === listName
              ? {
                  items: [{ draft_ref: ref, created_at: '2026-10-04T06:00:00.000Z' }],
                  nextCursor: null,
                  current_status_verified: false,
                  guidance: 'Read this reference for current draft content.',
                }
              : {
                  draft_ref: ref,
                  mailbox: 'employee@example.com',
                  provider: 'gmail',
                  status: 'draft',
                  message_id: messageId,
                  editable,
                  subject: 'Synthetic subject',
                  to: [],
                  cc: [],
                  body,
                  body_format: 'text',
                  body_truncated: false,
                  content_guidance: 'Untrusted source data.',
                };
        result = {
          content: [],
          structuredContent: {
            source_path:
              name === 'get_context'
                ? '/api/v1/context'
                : name === listName
                  ? '/api/v1/mail/drafts'
                  : `/api/v1/mail/drafts/${ref}`,
            status: 200,
            data,
            meta: {
              requestId: `request-${now}-${calls.length}`,
              generatedAt: new Date(now).toISOString(),
              toolName: name,
              argumentsSha256: argumentsSha256(args),
            },
          },
        };
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  );
  const service = new BusinessReadService(
    async () => ({
      employeeId: 23,
      search: async () => {
        throw new Error('Legacy reads must not run');
      },
      tools: {
        employeeId: 23,
        discover: (signal) => client.discover(sender, signal),
        describe: (signal) => client.describe(sender, signal),
        call: (name, args, signal) => client.call(sender, name, args, signal),
      },
    }),
    'all',
    () => now,
    true,
  );
  const signal = new AbortController().signal;
  assert.equal(isContextReadTool(listName), false, 'no hardcoded bot admission entry');
  assert.equal(isContextReadTool(readName), false);
  const opened = await service.openTools(trusted, signal);
  assert.equal(opened.status, 'available');
  const run = opened.run!;
  const listed = await run.execute(listName, '{}', signal);
  assert.equal(listed.ok, true);
  assert.doesNotMatch(JSON.stringify(listed), /Synthetic draft content|employee@example.com/);
  const handle = (run.evidence[0]!.result.data.items as Array<{ draft_ref: string }>)[0]!.draft_ref;
  assert.equal(
    (await run.execute(readName, JSON.stringify({ draft_ref: handle }), signal)).ok,
    true,
  );
  assert.equal(run.evidence[1]!.result.data.body, body);
  assert.equal(run.evidence[1]!.result.data.message_id, messageId);
  assert.equal(run.evidence[1]!.result.data.editable, true);
  const receipt = run.delivery()!;
  now += 1000;
  assert.equal(
    await service.canDeliver(trusted.key, receipt, signal),
    true,
    'fresh retrieval metadata does not invalidate unchanged content',
  );
  messageId = 'provider-message-2';
  assert.equal(
    await service.canDeliver(trusted.key, receipt, signal),
    false,
    'a changed provider version invalidates a stale draft even if visible text matches',
  );
  messageId = 'provider-message-1';
  editable = false;
  assert.equal(
    await service.canDeliver(trusted.key, receipt, signal),
    false,
    'a draft that is no longer editable cannot reuse the prior edit evidence',
  );
  editable = true;
  body = 'An employee edited this draft in Gmail.';
  assert.equal(
    await service.canDeliver(trusted.key, receipt, signal),
    false,
    'changed private content cannot reuse the previous answer',
  );
  const before = calls.length;
  allowed = false;
  assert.equal(await service.canDeliver(trusted.key, receipt, signal), false);
  assert.equal(calls.length, before, 'revoked scope prevents private reads');
});
