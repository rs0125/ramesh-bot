/** Exercises the composition root and persistent operator intent through the real HTTP API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { createApplication } from '../../src/app/application.js';
import { loadConfig } from '../../src/config/env.js';
import type { SessionFactory } from '../../src/infrastructure/whatsapp/baileys-session.js';
import { temporaryDatabase } from '../fixtures/database.js';

test('readiness, durable disconnect, and admin sessions survive new application instances', async () => {
  const temporary = await temporaryDatabase();
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const token = randomBytes(32).toString('base64url');
  const config = loadConfig({
    DATABASE_URL: `file:${temporary.path}`,
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    WORKER_API_TOKEN: token,
    WORKER_PORT: String(address.port),
    WHATSAPP_AUTO_CONNECT: 'true',
    LOG_LEVEL: 'silent',
    RELEASE_SHA: 'a'.repeat(40),
  });
  let sessions = 0;
  const createSession: SessionFactory = async () => {
    sessions++;
    const events = new EventEmitter();
    return {
      botJids: [],
      on(event, handler) {
        events.on(event, handler);
        return () => {
          events.off(event, handler);
        };
      },
      async saveCredentials() {},
      async reply() {},
      async close() {},
    };
  };
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  let app = createApplication(config, pino({ level: 'silent' }), { createSession });
  try {
    await app.start();
    assert.equal(sessions, 1);
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), {
      status: 'ok',
      release: 'a'.repeat(40),
    });
    assert.equal((await post('/v1/control', { action: 'disconnect' })).status, 200);
    assert.equal(
      (
        await post('/v1/admin/session', {
          action: 'create',
          tokenHash: 'b'.repeat(64),
          expiresAt: Date.now() + 60_000,
        })
      ).status,
      200,
    );
    await app.stop();
    app = createApplication(config, pino({ level: 'silent' }), { createSession });
    await app.start();
    assert.equal(sessions, 1, 'persistent disconnect overrides auto-connect');
    assert.deepEqual(
      await (
        await post('/v1/admin/session', { action: 'verify', tokenHash: 'b'.repeat(64) })
      ).json(),
      { active: true },
    );
    assert.equal((await post('/v1/control', { action: 'connect' })).status, 200);
    assert.equal(sessions, 2);
    assert.equal((await post('/v1/control', { action: 'x'.repeat(2048) })).status, 413);
    assert.equal((await post('/v1/control', [])).status, 400);
    assert.equal(
      (
        await post('/v1/admin/session', {
          action: 'create',
          tokenHash: 'b'.repeat(64),
          expiresAt: Date.now() + 86_400_000,
        })
      ).status,
      400,
    );
    assert.equal((await post('/v1/admin/attempt', { key: 'not-a-hash' })).status, 400);
  } finally {
    await app.stop();
    await temporary.close();
  }
});
