/** OAuth wire limits and protocol validation use synthetic tokens and injected HTTP only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextOAuthClient } from '../../src/infrastructure/context-engine/oauth-client.js';
import { rosterPhone } from '../../src/modules/identity/employee-identity.js';
import type { StoredEmployeeGrant } from '../../src/modules/context-engine/oauth.types.js';

const config = {
  endpoint: 'https://context.example/mcp',
  timeoutMs: 1000,
  maxResponseBytes: 16384,
};
const token = (prefix: string, char = 'a') => prefix + char.repeat(43);
const grant: StoredEmployeeGrant = {
  employeeId: 23,
  phoneE164: '+919876543210',
  email: 'employee@wareongo.com',
  clientId: token('wog_client_'),
  resource: config.endpoint,
  scopes: ['crm:read'],
  accessToken: token('wog_mcp_at_'),
  refreshToken: token('wog_mcp_rt_'),
  accessExpiresAtMs: 1,
  grantExpiresAtMs: Date.now() + 900000,
};
const valid = {
  access_token: token('wog_mcp_at_', 'b'),
  refresh_token: token('wog_mcp_rt_', 'b'),
  expires_in: 900,
  token_type: 'Bearer',
  resource: config.endpoint,
  scope: 'crm:read',
};
const signal = () => new AbortController().signal;

test('roster normalization permits explicit formats without guessing from arbitrary text', () => {
  assert.equal(rosterPhone(' 98765-43210 '), '+919876543210');
  assert.equal(rosterPhone('+1 (415) 555-0123'), '+14155550123');
  for (const value of [
    'call me 9876543210',
    '+919876543210 ext 2',
    'unknown@lid',
    '++919876543210',
    '123',
  ])
    assert.equal(rosterPhone(value), null);
});

test('refresh is one form POST to the fixed origin, with no bearer header, cookie, redirect or retry', async () => {
  const calls: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(new Request(input, init));
    return Response.json(valid);
  };
  const client = new ContextOAuthClient(config, fetcher, () => 1000);
  const result = await client.refresh(grant, signal());
  assert.equal(calls.length, 1);
  const request = calls[0]!;
  assert.equal(request.url, 'https://context.example/oauth/token');
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.headers.has('authorization'), false);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(await request.text())), {
    grant_type: 'refresh_token',
    client_id: grant.clientId,
    resource: config.endpoint,
    refresh_token: grant.refreshToken,
    scope: 'crm:read',
  });
  assert.equal(result.accessExpiresAtMs, 901000);
});

test('resource substitution, widened scopes, missing rotation, invalid tokens and excessive expiry are rejected', async () => {
  for (const response of [
    { ...valid, resource: 'https://other.example/mcp' },
    { ...valid, scope: 'crm:read warehouses:read' },
    { ...valid, scope: 'crm:read crm:read' },
    { ...valid, refresh_token: grant.refreshToken },
    { ...valid, access_token: token('wog_ctx_') },
    { ...valid, expires_in: 901 },
    { ...valid, expires_in: 0 },
  ]) {
    const client = new ContextOAuthClient(config, async () => Response.json(response));
    await assert.rejects(client.refresh(grant, signal()), /INVALID_RESPONSE/);
  }
});

test('transport responses, errors and cancellation are bounded and redact raw provider data', async () => {
  const oversized = new ContextOAuthClient(config, async () =>
    Response.json({ body: 'x'.repeat(20000) }),
  );
  await assert.rejects(oversized.refresh(grant, signal()), /RESPONSE_TOO_LARGE/);
  let attempts = 0;
  const failure = new ContextOAuthClient(config, async () => {
    attempts++;
    throw new Error(`raw-error-${grant.refreshToken}`);
  });
  await assert.rejects(
    failure.refresh(grant, signal()),
    (error: Error) => error.message === 'Context Engine: UNAVAILABLE',
  );
  assert.equal(attempts, 1);
  const blocked = new ContextOAuthClient(config, async () => new Promise<Response>(() => {}));
  await assert.rejects(blocked.refresh(grant, signal()), /TIMEOUT/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(blocked.refresh(grant, controller.signal), /CANCELLED/);
});
