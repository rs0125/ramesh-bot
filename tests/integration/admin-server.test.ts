/** Real local HTTP boundary tests; the bot behind it is a stub and cannot send messages. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotStatus } from '../../src/contracts/admin-api.js';
import { createAdminServer } from '../../src/infrastructure/http/admin-server.js';
import { randomUUID } from 'node:crypto';

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

test('inbox requires worker authentication and validates destinations, cursors, size and connection before enqueueing', async () => {
  const status: BotStatus = {
    state: 'connected',
    qr: null,
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    metrics: { received: 0, replied: 0, duplicates: 0, errors: 0, dropped: 0 },
    events: [],
  };
  const sends: unknown[] = [];
  const api = createAdminServer(
    { getStatus: () => status, async start() {}, async stop() {} },
    'inbox-token',
    {
      inbox: {
        async conversations() {
          return { conversations: [], nextCursor: null, groupRepliesRequireMention: true };
        },
        async messages() {
          return { messages: [], nextCursor: null };
        },
      },
      async sendMessage(id, chatId, text) {
        sends.push({ id, chatId, text });
        return chatId === '123@g.us' ? 'queued' : 'unknown_chat';
      },
    },
  );
  await api.start('127.0.0.1', 0);
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: 'Bearer inbox-token', 'Content-Type': 'application/json' };
  const body = { requestId: randomUUID(), chatId: '123@g.us', text: 'Hello team' };
  const send = (patch: Record<string, unknown> = {}) =>
    fetch(`${base}/v1/inbox/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, ...patch }),
    });
  try {
    assert.equal((await fetch(`${base}/v1/inbox/conversations`)).status, 401);
    assert.equal(
      (await fetch(`${base}/v1/inbox/send`, { method: 'POST', body: JSON.stringify(body) })).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/v1/inbox/messages?chatId=status@broadcast`, { headers })).status,
      400,
    );
    assert.equal(
      (await fetch(`${base}/v1/inbox/conversations?cursor=invalid`, { headers })).status,
      400,
    );
    for (const patch of [
      { text: ' ' },
      { text: 'x'.repeat(4001) },
      { requestId: 'invalid' },
      { chatId: 'status@broadcast' },
    ])
      assert.equal((await send(patch)).status, 400);
    assert.equal(sends.length, 0);
    status.state = 'stopped';
    assert.equal((await send()).status, 409);
    assert.equal(sends.length, 0);
    status.state = 'connected';
    assert.equal((await send({ chatId: 'unknown@lid' })).status, 404);
    const accepted = await send();
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).requestId, body.requestId);
    assert.match(accepted.headers.get('cache-control')!, /no-store/);
    const received = await fetch(`${base}/v1/inbox/messages?chatId=123@g.us`, { headers });
    assert.equal(received.status, 200);
    assert.match(received.headers.get('cache-control')!, /no-store/);
  } finally {
    await api.stop();
  }
});
