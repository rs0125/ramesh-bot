/** Loopback HTTP only; stub storage cannot send to WhatsApp or invoke models. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminServer } from '../../src/infrastructure/http/admin-server.js';
import type { BotStatus } from '../../src/contracts/admin-api.js';
import type {
  AutomationEnqueueResult,
  OutboundAutomationRequest,
} from '../../src/contracts/outbound-automation.js';

const id = '10000000-0000-4000-8000-000000000001';
const apiKey = 'test-automation-key';
const headers = {
  'X-Ramesh-Api-Key': apiKey,
  'Idempotency-Key': 'crm:123',
  'Content-Type': 'application/json',
};
const body = { to: '+919876543210', text: 'Synthetic test reminder' };
const status: BotStatus = {
  state: 'stopped',
  qr: null,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  events: [],
  metrics: { received: 0, replied: 0, duplicates: 0, errors: 0, dropped: 0 },
};
const bot = { getStatus: () => status, async start() {}, async stop() {} };

test('automation auth is distinct; POST validation/status never exposes other APIs or contents', async () => {
  const admissions: { key: string; request: OutboundAutomationRequest }[] = [];
  let result: AutomationEnqueueResult = 'queued';
  const api = createAdminServer(bot, 'admin-token', {
    automation: {
      key: apiKey,
      service: {
        async enqueue(key, request) {
          admissions.push({ key, request });
          return { messageId: id, status: result };
        },
        async status(messageId) {
          return messageId === id
            ? {
                messageId,
                state: 'SENT',
                createdAt: '2026-10-03T00:00:00Z',
                expiresAt: '2026-10-03T00:15:00Z',
                finishedAt: '2026-10-03T00:00:05Z',
                reason: null,
              }
            : null;
        },
      },
    },
  });
  await api.start('127.0.0.1', 0);
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (payload: unknown = body, h: Record<string, string> = headers) =>
    fetch(`${base}/v1/outbound-messages`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify(payload),
    });
  try {
    assert.equal((await post(body, { Authorization: 'Bearer admin-token' })).status, 401);
    assert.equal((await post(body, { ...headers, 'X-Ramesh-Api-Key': 'wrong' })).status, 401);
    assert.equal((await fetch(`${base}/v1/status`, { headers })).status, 401);
    assert.equal((await fetch(`${base}/v1/inbox/conversations`, { headers })).status, 401);
    assert.equal((await post(body, { ...headers, 'Idempotency-Key': '' })).status, 400);
    assert.equal((await post(body, { ...headers, 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post({ ...body, to: '123@g.us' })).status, 400);
    assert.equal(admissions.length, 0);
    const accepted = await post();
    assert.equal(accepted.status, 202); // disconnected admission is deliberately allowed
    assert.match(accepted.headers.get('cache-control')!, /no-store/);
    assert.deepEqual(await accepted.json(), { messageId: id, status: 'queued' });
    assert.equal(admissions[0]?.request.expiresInSeconds, 900);
    result = 'duplicate';
    assert.equal((await (await post()).json()).messageId, id);
    result = 'conflict';
    assert.equal((await post()).status, 409);
    result = 'full';
    assert.equal((await post()).status, 429);
    const receipt = await fetch(`${base}/v1/outbound-messages/${id}`, { headers });
    assert.equal(receipt.status, 200);
    assert.equal((await receipt.json()).state, 'SENT');
    assert.equal(
      (await fetch(`${base}/v1/outbound-messages/${id.replace(/1$/, '2')}`, { headers })).status,
      404,
    );
    assert.equal((await fetch(`${base}/v1/outbound-messages/invalid`, { headers })).status, 400);
    assert.equal(
      (await fetch(`${base}/v1/outbound-messages/${id}?include=content`, { headers })).status,
      400,
    );
    assert.equal((await post({ ...body, text: 'x'.repeat(12 * 1024 * 1024) })).status, 413);
  } finally {
    await api.stop();
  }
});

test('disabled automation stays closed even for an authenticated admin', async () => {
  const api = createAdminServer(bot, 'admin-token');
  await api.start('127.0.0.1', 0);
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  try {
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${address.port}/v1/outbound-messages`, {
          method: 'POST',
          headers: { ...headers, Authorization: 'Bearer admin-token' },
          body: JSON.stringify(body),
        })
      ).status,
      401,
    );
  } finally {
    await api.stop();
  }
});

test('two admissions bound buffering through database completion, and release capacity on failure', async () => {
  let entered = 0;
  let unblock!: () => void;
  let both!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    both = resolve;
  });
  const api = createAdminServer(bot, 'admin-token', {
    automation: {
      key: apiKey,
      service: {
        async enqueue() {
          if (++entered === 2) both();
          await gate;
          throw new Error('private database information');
        },
        async status() {
          return null;
        },
      },
    },
  });
  await api.start('127.0.0.1', 0);
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  const post = () =>
    fetch(`http://127.0.0.1:${address.port}/v1/outbound-messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  const requests = [post(), post()];
  try {
    await reached;
    assert.equal((await post()).status, 429);
    unblock();
    for (const response of await Promise.all(requests)) {
      assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /private database/);
    }
    assert.equal((await post()).status, 503);
    assert.equal(entered, 3);
  } finally {
    unblock();
    await Promise.allSettled(requests);
    await api.stop();
  }
});
