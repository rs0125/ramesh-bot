/** Real MCP adapter/executor with synthetic responses; no Google or WhatsApp calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextEngineMcpClient } from '../../src/infrastructure/context-engine/mcp-client.js';
import { ContextToolRun } from '../../src/modules/assistant/tool-executor.js';
import { argumentsSha256 } from '../../src/modules/context-engine/read-contract.js';

const sender = { phoneE164: '+919000000023', audience: 'dm' as const };
const ref = '11111111-1111-4111-8111-111111111111';
const signal = () => new AbortController().signal;
type Failure = {
  status: number;
  code: string;
  action?: string;
  retryable?: boolean;
  delay?: number;
  domain?: string;
};

function fixture(failure: Failure, readName = 'read_email_draft') {
  let now = Date.now(),
    invalidations = 0;
  const calls: string[] = [];
  const tools = ['get_context', 'get_email_connection', readName].map((name) => ({
    name,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
    _meta: {
      'wareongo/context-read-v1': {
        requiredScopes: name === 'get_context' ? [] : ['mail:drafts'],
        sourceFamily: 'mail',
      },
    },
  }));
  const client = new ContextEngineMcpClient(
    { endpoint: 'https://context.example/mcp', timeoutMs: 5000, maxResponseBytes: 16384 },
    {
      resolve: async () => ({
        employeeId: 23,
        phoneE164: sender.phoneE164,
        active: true,
        accessToken: `wog_mcp_at_${'a'.repeat(43)}`,
        expiresAtMs: Date.now() + 900000,
      }),
      invalidate: async () => {
        invalidations++;
      },
    },
    async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'GET') return new Response(null, { status: 405 });
      const rpc = (await request.json()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
      };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: rpc.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'synthetic', version: '1' },
        };
      else if (rpc.method === 'tools/list') result = { tools };
      else {
        assert.equal(rpc.method, 'tools/call');
        const name = rpc.params!.name!;
        calls.push(name);
        result =
          name === readName
            ? {
                isError: true,
                content: [],
                structuredContent: {
                  status: failure.status,
                  error: {
                    code: failure.code,
                    message: 'PRIVATE_PROVIDER_TEXT',
                    ...(failure.domain ? { domain: failure.domain } : {}),
                    ...(failure.action
                      ? {
                          recovery: {
                            action: failure.action,
                            retryable: failure.retryable ?? false,
                            guidance: 'PRIVATE_PROVIDER_GUIDANCE https://untrusted.example',
                          },
                        }
                      : {}),
                  },
                  ...(failure.delay !== undefined ? { retry_after_seconds: failure.delay } : {}),
                },
              }
            : {
                content: [],
                structuredContent: {
                  source_path:
                    name === 'get_context' ? '/api/v1/context' : '/api/v1/mail/connection',
                  status: 200,
                  data:
                    name === 'get_context'
                      ? { employee_id: 23, scopes: ['mail:drafts'], read_only: true }
                      : { connected: false, connect_url: 'https://context.example/mail' },
                  meta: {
                    requestId: 'synthetic',
                    generatedAt: new Date(now).toISOString(),
                    toolName: name,
                    argumentsSha256: argumentsSha256(rpc.params?.arguments ?? {}),
                  },
                },
              };
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  );
  const reader = {
    employeeId: 23,
    describe: (current: AbortSignal) => client.describe(sender, current),
    discover: (current: AbortSignal) => client.discover(sender, current),
    call: (name: string, args: Record<string, unknown>, current: AbortSignal) =>
      client.call(sender, name, args, current),
  };
  return {
    calls,
    client,
    invalidations: () => invalidations,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
    open: () =>
      ContextToolRun.open(
        async () => reader,
        undefined,
        signal(),
        () => now,
      ),
  };
}

for (const failure of [
  { status: 409, code: 'GMAIL_RECONNECT_REQUIRED', action: 'reconnect_gmail' },
  { status: 401, code: 'GMAIL_AUTH_REQUIRED', action: 'reconnect_gmail' },
  { status: 409, code: 'GMAIL_CONNECT_REQUIRED', action: 'connect_gmail' },
  { status: 409, code: 'GMAIL_REVOCATION_PENDING', action: 'finish_gmail_disconnect' },
  { status: 409, code: 'GMAIL_CONNECTION_CHANGED', action: 'check_gmail_connection' },
  { status: 404, code: 'GMAIL_DRAFT_UNAVAILABLE', action: 'check_gmail_draft' },
  { status: 403, code: 'GMAIL_ACCESS_DENIED', action: 'check_google_access' },
]) {
  test(`${failure.code} preserves mailbox recovery without blocking the employee or invalidating Context credentials`, async () => {
    const h = fixture({ ...failure, domain: 'gmail' }),
      run = (await h.open())!;
    const result = await run.execute(
      'read_email_draft',
      JSON.stringify({ draft_ref: ref }),
      signal(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UNAVAILABLE');
    assert.deepEqual(result.recovery, { sourceCode: failure.code, action: failure.action });
    assert.equal(result.retryable, false);
    assert.equal(run.blocked, false);
    assert.equal(h.invalidations(), 0);
    assert.equal((await run.execute('get_email_connection', '{}', signal())).ok, true);
    assert.equal((await run.execute('get_context', '{}', signal())).ok, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER|untrusted\.example/);
  });
}

for (const failure of [
  { status: 401, code: 'UNAUTHORIZED' },
  { status: 401, code: 'GMAIL_EMPLOYEE_INACTIVE', domain: 'gmail', action: 'reconnect_gmail' },
  { status: 401, code: 'GMAIL_RECONNECT_REQUIRED', domain: 'gmail', action: 'connect_gmail' },
]) {
  test(`true or mismarked employee authentication failures still fail closed: ${failure.code}/${failure.action ?? 'none'}`, async () => {
    const h = fixture(failure),
      run = (await h.open())!;
    assert.equal(
      (await run.execute('read_email_draft', JSON.stringify({ draft_ref: ref }), signal())).code,
      'AUTH_REQUIRED',
    );
    assert.equal(run.blocked, true);
    assert.equal(h.invalidations(), 1);
    assert.equal((await run.execute('get_email_connection', '{}', signal())).code, 'ACCESS_DENIED');
  });
}

test('mailbox error markers on unrelated tools cannot suppress employee authentication failures', async () => {
  const h = fixture(
    { status: 401, code: 'GMAIL_RECONNECT_REQUIRED', domain: 'gmail', action: 'reconnect_gmail' },
    'read_other',
  );
  await assert.rejects(h.client.call(sender, 'read_other', {}), /AUTH_REQUIRED/);
  assert.equal(h.invalidations(), 1);
});

for (const delay of [7200, 86400]) {
  test(`Gmail read backoff retains the complete ${delay}-second deadline`, async () => {
    const h = fixture({
      status: 429,
      code: 'GMAIL_RATE_LIMITED',
      domain: 'gmail',
      action: 'retry_later',
      retryable: true,
      delay,
    });
    const run = (await h.open())!,
      args = JSON.stringify({ draft_ref: ref });
    const result = await run.execute('read_email_draft', args, signal());
    assert.equal(result.code, 'RATE_LIMITED');
    assert.equal(result.retry_after_seconds, delay);
    h.advance(3601);
    await run.execute('read_email_draft', args, signal());
    assert.equal(h.calls.filter((name) => name === 'read_email_draft').length, 1);
    h.advance(delay - 3601 + 1);
    await run.execute('read_email_draft', args, signal());
    assert.equal(h.calls.filter((name) => name === 'read_email_draft').length, 2);
  });
}
