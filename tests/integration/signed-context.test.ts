/** Actual MCP client, fresh Ed25519 keys and synthetic employees. No WhatsApp socket or production HTTP. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createSignedEmployeeContextAccess } from '../../src/app/context-engine.js';
import { loadContextEngineConfig } from '../../src/config/context-engine.js';
import { loadContextSigningConfig } from '../../src/infrastructure/context-engine/request-credentials.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { employeeContextFixture, sender } from '../fixtures/employee-context.js';

async function fixture() {
  const local = await employeeContextFixture();
  const keys = await generateKeyPair('EdDSA', { extractable: true });
  const signing = loadContextSigningConfig({
    CONTEXT_RAMESH_SIGNING_KEY_JSON: JSON.stringify({
      kid: 'synthetic-test',
      privateKey: await exportJWK(keys.privateKey),
      scopes: ['crm:read'],
    }),
  })!;
  const config = {
    endpoint: 'https://context.example/mcp/ramesh',
    timeoutMs: 5000,
    maxResponseBytes: 16384,
  };
  const nonces = new Set<string>();
  const calls: string[] = [];
  let afterInitialize: (() => void) | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, config.endpoint);
    assert.equal(request.redirect, 'error');
    if (request.method === 'GET') {
      assert.equal(request.headers.has('authorization'), false);
      return new Response(null, { status: 405 });
    }
    const body = await request.text();
    const authorization = request.headers.get('authorization')!;
    assert.match(authorization, /^Ramesh /);
    const { payload, protectedHeader } = await jwtVerify(authorization.slice(7), keys.publicKey, {
      algorithms: ['EdDSA'],
      typ: 'ramesh-request+jwt',
      issuer: 'wareongo:ramesh',
      audience: config.endpoint,
    });
    assert.equal(protectedHeader.kid, signing.kid);
    assert.equal(payload.sub, '23');
    assert.equal(payload.phone, sender.phoneE164);
    assert.equal(payload.chat_type, 'dm');
    assert.equal(payload.htm, 'POST');
    assert.equal(payload.htu, config.endpoint);
    assert.equal(payload.exp! - payload.iat!, 60);
    assert.deepEqual(payload.scopes, ['crm:read']);
    assert.equal(payload.body_sha256, createHash('sha256').update(body).digest('base64url'));
    assert.equal(nonces.has(payload.jti!), false);
    nonces.add(payload.jti!);
    const rpc = JSON.parse(body) as {
      id?: string;
      method: string;
      params?: Record<string, unknown>;
    };
    calls.push(rpc.method);
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === 'initialize') {
      result = {
        protocolVersion: rpc.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'signed-fixture', version: '1' },
      };
      afterInitialize?.();
    } else if (rpc.method === 'tools/list') {
      result = {
        tools: ['get_context', 'search_crm_leads'].map((name) => ({
          name,
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        })),
      };
    } else {
      result = {
        content: [],
        structuredContent: {
          source_path: '/api/v1/context',
          status: 200,
          data: { employee_id: 23, scopes: ['crm:read'], read_only: true },
          meta: { requestId: 'synthetic', generatedAt: new Date().toISOString() },
        },
      };
    }
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  };
  const app = createSignedEmployeeContextAccess(config, {
    db: local.db,
    encryptionKey: local.key,
    roster: local.roster,
    signing,
    fetcher,
  });
  return {
    ...local,
    app,
    calls,
    nonces,
    config,
    signing,
    setAfterInitialize(fn: () => void) {
      afterInitialize = fn;
    },
  };
}
const message = (remoteJid = '919876543210@s.whatsapp.net') => ({
  key: { remoteJid, fromMe: false },
});

test('signs every MCP request with the live employee without creating any OAuth enrollment or credential', async () => {
  const f = await fixture();
  try {
    const service = await f.app.forMessage(message());
    assert.ok(service);
    const result = await service.context();
    assert.equal(result.data.employee_id, 23);
    assert.ok(f.nonces.size >= 4);
    assert.ok(f.calls.includes('initialize'));
    assert.ok(f.calls.includes('tools/call'));
    assert.equal(await f.db.contextOAuthEnrollment.count(), 0);
    assert.equal(await f.db.contextOAuthGrant.count(), 0);
    assert.equal(await f.db.contextOAuthRevocation.count(), 0);
    const cipher = authCipher(f.key);
    for (const [keyId, value] of [
      ['919876543210', '999'],
      ['999_reverse', '919876543210'],
    ]) {
      await f.db.whatsAppAuthEntry.create({
        data: {
          category: 'lid-mapping',
          keyId: keyId!,
          encrypted: cipher.seal('lid-mapping', keyId!, value!),
        },
      });
    }
    assert.equal(
      (await (await f.app.forMessage(message('999@lid')))!.context()).data.employee_id,
      23,
    );
  } finally {
    await f.close();
  }
});

test('unknown, inactive, ambiguous and group senders cannot obtain a signed business service', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.app.forMessage(message('919999999999@s.whatsapp.net')), null);
    assert.equal(
      await f.app.forMessage({
        key: { remoteJid: '100@g.us', participant: '919876543210@s.whatsapp.net' },
      }),
      null,
    );
    f.rows[0]!.is_active = false;
    assert.equal(await f.app.forMessage(message()), null);
    f.rows[0]!.is_active = true;
    f.rows.push({ ...f.rows[0]!, id: 24 });
    assert.equal(await f.app.forMessage(message()), null);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('parallel delivery rechecks resolve reciprocal LIDs without SQLite transaction timeouts', async () => {
  const f = await fixture();
  try {
    const cipher = authCipher(f.key);
    await f.db.whatsAppAuthEntry.createMany({
      data: [
        {
          category: 'lid-mapping',
          keyId: '999_reverse',
          encrypted: cipher.seal('lid-mapping', '999_reverse', '919876543210'),
        },
        {
          category: 'lid-mapping',
          keyId: '919876543210',
          encrypted: cipher.seal('lid-mapping', '919876543210', '999'),
        },
      ],
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        f.app.whatsapp.resolve(message('999@lid'), AbortSignal.timeout(3000)),
      ),
    );
    assert.ok(results.every((result) => result?.employee.employeeId === 23));
    assert.equal(f.calls.length, 0);
    f.rows[0]!.is_active = false;
    assert.equal(await f.app.forMessage(message('999@lid')), null);
  } finally {
    await f.close();
  }
});

test('a LID changed between discovery and the pair snapshot cannot use its previous phone', async () => {
  const f = await fixture();
  try {
    const cipher = authCipher(f.key);
    await f.db.whatsAppAuthEntry.createMany({
      data: [
        {
          category: 'lid-mapping',
          keyId: '999_reverse',
          encrypted: cipher.seal('lid-mapping', '999_reverse', '919876543210'),
        },
        {
          category: 'lid-mapping',
          keyId: '919876543210',
          encrypted: cipher.seal('lid-mapping', '919876543210', '999'),
        },
      ],
    });
    const original = f.db.whatsAppAuthEntry.findMany.bind(f.db.whatsAppAuthEntry);
    f.db.whatsAppAuthEntry.findMany = (async (...args: Parameters<typeof original>) => {
      await f.db.whatsAppAuthEntry.update({
        where: { category_keyId: { category: 'lid-mapping', keyId: '999_reverse' } },
        data: { encrypted: cipher.seal('lid-mapping', '999_reverse', '919999999999') },
      });
      return original(...args);
    }) as typeof original;
    assert.equal(await f.app.forMessage(message('999@lid')), null);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('rechecks employee status and binding after credential resolution and before each signed HTTP request', async () => {
  const f = await fixture();
  try {
    const grant = (await f.app.credentials.resolve(sender, AbortSignal.timeout(5000)))!;
    assert.ok(grant);
    const req = () => new Request(f.config.endpoint, { method: 'POST', body: '{}' });
    f.rows[0]!.email = 'replacement@wareongo.com';
    await assert.rejects(grant.authorize(req(), AbortSignal.timeout(5000)), {
      code: 'AUTH_REQUIRED',
    });
    f.rows[0]!.email = 'employee@wareongo.com';
    const service = await f.app.forMessage(message());
    f.setAfterInitialize(() => {
      f.rows[0]!.is_active = false;
    });
    await assert.rejects(service!.context());
    assert.deepEqual(f.calls, ['initialize']);
  } finally {
    await f.close();
  }
});

test('refuses signature forwarding, browser requests, oversized bodies and cancelled calls', async () => {
  const f = await fixture();
  try {
    const grant = (await f.app.credentials.resolve(sender, AbortSignal.timeout(5000)))!;
    for (const request of [
      new Request('https://attacker.example/mcp/ramesh', { method: 'POST', body: '{}' }),
      new Request('https://context.example/mcp', { method: 'POST', body: '{}' }),
      new Request(f.config.endpoint),
      new Request(f.config.endpoint, {
        method: 'POST',
        body: '{}',
        headers: { origin: 'https://context.example' },
      }),
    ]) {
      await assert.rejects(grant.authorize(request, AbortSignal.timeout(5000)), {
        code: 'ACCESS_DENIED',
      });
    }
    await assert.rejects(
      grant.authorize(
        new Request(f.config.endpoint, { method: 'POST', body: 'a'.repeat(32769) }),
        AbortSignal.timeout(5000),
      ),
      { code: 'INVALID_ARGUMENTS' },
    );
    await assert.rejects(f.app.credentials.resolve(sender, AbortSignal.abort()), {
      code: 'CANCELLED',
    });
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('configuration accepts the dedicated endpoint and rejects malformed or overly broad signing keys without revealing them', () => {
  assert.ok(loadContextEngineConfig({ CONTEXT_MCP_URL: 'https://context.example/mcp/ramesh' }));
  assert.equal(loadContextSigningConfig({}), undefined);
  for (const raw of [
    'private-secret',
    '{}',
    JSON.stringify({ kid: 'x', privateKey: { d: 'private-secret' }, scopes: ['analytics:read'] }),
  ]) {
    assert.throws(
      () => loadContextSigningConfig({ CONTEXT_RAMESH_SIGNING_KEY_JSON: raw }),
      (error) => {
        assert.equal((error as { code: string }).code, 'NOT_CONFIGURED');
        assert.doesNotMatch(String(error), /private-secret/);
        return true;
      },
    );
  }
});
