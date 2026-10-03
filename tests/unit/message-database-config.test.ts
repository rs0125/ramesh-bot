/** Remote TLS, dedicated credentials, and polling bounds are part of the queue boundary. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'dotenv';
import { messageRuntimeEnv } from '../../scripts/message-schema.js';
import { loadConfig } from '../../src/config/env.js';
import { messagePoolOptions } from '../../src/infrastructure/database/message-pool.js';

const base = {
  DATABASE_URL: 'file:./test.db',
  AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
  WORKER_API_TOKEN: 'x'.repeat(32),
};

test('scheduling requires durable storage, permits delivery pause, and needs no CRM grant', () => {
  const configured = {
    ...base,
    MESSAGE_DATABASE_URL: 'postgresql://ramesh_worker:fake@127.0.0.1/test',
    OPENAI_API_KEY: 'fake-unused',
    PERSONAL_SCHEDULING_ENABLED: 'true',
  };
  assert.equal(loadConfig(base).scheduling, undefined);
  assert.throws(() => loadConfig({ ...base, PERSONAL_SCHEDULING_ENABLED: 'true' }), /Supabase/);
  assert.throws(() => loadConfig({ ...configured, OPENAI_API_KEY: '' }), /assistant/);
  assert.deepEqual(loadConfig(configured).scheduling, {
    toolsEnabled: true,
    schedulerEnabled: true,
    pollMs: 30000,
  });
  assert.equal(loadConfig(configured).businessReads, undefined);
  assert.deepEqual(loadConfig({ ...configured, REMINDER_SCHEDULER_ENABLED: 'false' }).scheduling, {
    toolsEnabled: true,
    schedulerEnabled: false,
    pollMs: 30000,
  });
  assert.deepEqual(
    loadConfig({
      ...configured,
      PERSONAL_SCHEDULING_ENABLED: 'false',
      REMINDER_SCHEDULER_ENABLED: 'true',
      OPENAI_API_KEY: '',
    }).scheduling,
    {
      toolsEnabled: false,
      schedulerEnabled: true,
      pollMs: 30000,
    },
  );
  for (const value of ['999', '60001', '0', '2.5']) {
    assert.throws(() => loadConfig({ ...configured, REMINDER_SCHEDULER_POLL_MS: value }));
  }
});

test('message database config requires a scoped login and bounded polling', () => {
  assert.equal(loadConfig(base).messageDatabase, undefined);
  assert.throws(
    () =>
      loadConfig({
        ...base,
        MESSAGE_DATABASE_URL: 'postgresql://postgres:secret@example.com/postgres',
      }),
    /dedicated/,
  );
  const MESSAGE_DATABASE_URL = 'postgresql://ramesh_worker.project:secret@example.com/postgres';
  const config = loadConfig({ ...base, MESSAGE_DATABASE_URL });
  assert.equal(config.messageDatabase?.accountId, 'primary');
  assert.equal(config.messageDatabase?.pollMs, 5000);
  assert.equal(config.messageDatabase?.concurrency, 3);
  for (const value of ['1', '8'])
    assert.equal(
      loadConfig({ ...base, MESSAGE_DATABASE_URL, MESSAGE_QUEUE_CONCURRENCY: value })
        .messageDatabase?.concurrency,
      Number(value),
    );
  for (const value of ['0', '9', '-1', '2.5', 'NaN'])
    assert.throws(() =>
      loadConfig({ ...base, MESSAGE_DATABASE_URL, MESSAGE_QUEUE_CONCURRENCY: value }),
    );
  assert.throws(() => loadConfig({ ...base, MESSAGE_DATABASE_URL, MESSAGE_QUEUE_POLL_MS: '0' }));
  assert.throws(() =>
    loadConfig({ ...base, MESSAGE_DATABASE_URL, MESSAGE_QUEUE_POLL_MS: '30001' }),
  );
  assert.throws(() =>
    loadConfig({ ...base, MESSAGE_DATABASE_URL, MESSAGE_ACCOUNT_ID: 'unsafe account' }),
  );
});

test('remote database URL options cannot disable verified TLS', () => {
  const options = messagePoolOptions(
    'postgresql://ramesh_worker:p@example.com/db?sslmode=no-verify&connection_limit=99',
    'CA\\nCHAIN',
  );
  assert.equal(new URL(options.connectionString!).search, '');
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, ca: 'CA\nCHAIN' });
  assert.equal(options.max, 2);
  assert.equal(messagePoolOptions('postgresql://ramesh_worker:p@127.0.0.1:55438/test').ssl, false);
});

test('generated runtime files preserve both escaped and multiline CA certificates', () => {
  const url = 'postgresql://ramesh_worker.project:secret@example.com/postgres';
  const pem = '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----';
  for (const input of [pem, pem.replaceAll('\n', '\\n')]) {
    const env = parse(messageRuntimeEnv(url, input));
    assert.equal(env.MESSAGE_DB_SSL_CA, pem);
    assert.equal(env.MESSAGE_DATABASE_URL, url);
    assert.deepEqual(messagePoolOptions(env.MESSAGE_DATABASE_URL!, env.MESSAGE_DB_SSL_CA).ssl, {
      rejectUnauthorized: true,
      ca: pem,
    });
  }
});
