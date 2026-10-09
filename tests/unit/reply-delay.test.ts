/** Pacing is deterministic under injection, and real timers stop immediately on cancellation. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplyDelay } from '../../src/lib/reply-delay.js';
import { loadConfig } from '../../src/config/env.js';

test('each wait draws a new delay within the inclusive configured range', async () => {
  const samples = [0, 0.5, 1 - Number.EPSILON];
  const durations: number[] = [];
  const pause = createReplyDelay(
    { minMs: 1500, maxMs: 4000 },
    () => samples.shift()!,
    async (ms) => {
      durations.push(ms);
    },
  );
  assert.equal(await pause(), true);
  assert.equal(await pause(), true);
  assert.equal(await pause(), true);
  assert.deepEqual(durations, [1500, 2750, 4000]);
});

test('an abort cancels an active timer and already-aborted work never starts a timer', async () => {
  const controller = new AbortController();
  const pause = createReplyDelay({ minMs: 60_000, maxMs: 60_000 });
  const pending = pause(controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  const neverWait = createReplyDelay({ minMs: 1500, maxMs: 4000 }, () =>
    assert.fail('an aborted reply must not draw a delay'),
  );
  assert.equal(await neverWait(controller.signal), false);
});

test('configuration defaults to zero delay and validates explicit pacing overrides', () => {
  const env = {
    DATABASE_URL: 'file:./unused-test.db',
    AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
    WORKER_API_TOKEN: 'isolated-test-worker-token-not-a-secret',
  };
  assert.deepEqual(loadConfig(env).whatsapp.replyDelay, { minMs: 0, maxMs: 0 });
  assert.deepEqual(
    loadConfig({ ...env, REPLY_DELAY_MIN_MS: '1500', REPLY_DELAY_MAX_MS: '4000' }).whatsapp
      .replyDelay,
    { minMs: 1500, maxMs: 4000 },
  );
  for (const [min, max] of [
    ['-1', '4000'],
    ['1.5', '4000'],
    ['4001', '4000'],
    ['0', '60001'],
    ['', '4000'],
  ]) {
    assert.throws(
      () => loadConfig({ ...env, REPLY_DELAY_MIN_MS: min, REPLY_DELAY_MAX_MS: max }),
      /REPLY_DELAY/,
    );
  }
});
