/** Real local HTTP boundary tests; the bot behind it is a stub and cannot send messages. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotStatus } from '../../src/contracts/admin-api.js';
import { createAdminServer } from '../../src/infrastructure/http/admin-server.js';

test('worker API protects QR data and serializes named controls', async () => {
  const actions: string[] = [];
  const status: BotStatus = {
    state: 'pairing',
    qr: 'private-test-qr',
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    metrics: { received: 0, replied: 0, duplicates: 0, errors: 0, dropped: 0 },
    events: [],
  };
  const api = createAdminServer(
    {
      getStatus: () => status,
      start: async () => {
        actions.push('start');
      },
      stop: async () => {
        actions.push('stop');
      },
    },
    'test-token',
  );
  await api.start('127.0.0.1', 0);
  try {
    const address = api.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const anonymous = await fetch(`${base}/v1/status`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.text()).includes('private-test-qr'), false);
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    const authorized = await fetch(`${base}/v1/status`, { headers });
    assert.match(authorized.headers.get('cache-control')!, /no-store/);
    assert.equal((await authorized.json()).qr, 'private-test-qr');
    const rejected = await fetch(`${base}/v1/control`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'send-to-everyone' }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(actions.length, 0);
    const response = await fetch(`${base}/v1/control`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'reconnect' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(actions, ['stop', 'start']);
  } finally {
    await api.stop();
  }
});
