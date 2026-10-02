import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadLivePlaygroundConfig } from '../../src/config/playground.js';

test('live playground requires its own login, namespace, key and pinned identity, without production fallbacks', () => {
  const env = {
    OPENAI_API_KEY: 'fixture',
    CONTEXT_MCP_URL: 'https://context.example/mcp/ramesh',
    CONTEXT_RAMESH_SIGNING_KEY_JSON: JSON.stringify({
      kid: 'test',
      privateKey: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'A'.repeat(43) },
      scopes: ['crm:read', 'warehouses:read'],
    }),
    PLAYGROUND_DATABASE_URL: 'postgres://ramesh_playground:test@localhost/capture',
    PLAYGROUND_NAMESPACE: randomUUID(),
    PLAYGROUND_EMPLOYEE_ID: '23',
    PLAYGROUND_EMPLOYEE_LABEL: 'Fixture',
    PLAYGROUND_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  };
  const parsed = loadLivePlaygroundConfig(env);
  assert.equal(parsed.employeeId, 23);
  assert.deepEqual(parsed.signing.scopes, ['crm:read', 'warehouses:read']);
  for (const role of ['postgres', 'ramesh_worker'])
    assert.throws(
      () =>
        loadLivePlaygroundConfig({
          ...env,
          PLAYGROUND_DATABASE_URL: `postgres://${role}:test@localhost/capture`,
        }),
      /DEDICATED_LOGIN/,
    );
  assert.throws(
    () =>
      loadLivePlaygroundConfig({
        ...env,
        PLAYGROUND_DATABASE_URL: undefined,
        MESSAGE_DATABASE_URL: env.PLAYGROUND_DATABASE_URL,
      }),
    /DATABASE_REQUIRED/,
  );
  assert.throws(() => loadLivePlaygroundConfig({ ...env, PLAYGROUND_EMPLOYEE_ID: undefined }));
  assert.throws(() => loadLivePlaygroundConfig({ ...env, PLAYGROUND_NAMESPACE: undefined }));
  assert.throws(
    () => loadLivePlaygroundConfig({ ...env, CONTEXT_MCP_URL: 'https://context.example/mcp' }),
    /SIGNED_CONTEXT/,
  );
});
