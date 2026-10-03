/** Synthetic presence events only, no socket or model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TypingPresence } from '../../src/infrastructure/whatsapp/typing-presence.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('typing refreshes during work and clears on cancellation without affecting another chat', async () => {
  const calls: string[] = [];
  const presence = new TypingPresence(
    async (chat, state) => void calls.push(`${chat}:${state}`),
    () => assert.fail(),
    10,
    1000,
  );
  const a = new AbortController(),
    b = new AbortController();
  presence.start('a@lid', a.signal);
  const stopB = presence.start('b@lid', b.signal);
  await delay(35);
  assert.ok(calls.filter((item) => item === 'a@lid:composing').length >= 2);
  a.abort();
  await tick();
  const afterStop = calls.length;
  await delay(25);
  assert.equal(calls.filter((item) => item === 'a@lid:paused').length, 1);
  assert.ok(calls.slice(afterStop).every((item) => item === 'b@lid:composing'));
  stopB();
  await presence.close();
  assert.equal(calls.at(-1), 'b@lid:paused');
});

test('overlapping same-chat work keeps typing until its last owner stops', async () => {
  const calls: string[] = [];
  const presence = new TypingPresence(
    async (_chat, state) => void calls.push(state),
    () => {},
    10000,
  );
  const a = presence.start('a@lid', new AbortController().signal);
  const b = presence.start('a@lid', new AbortController().signal);
  await tick();
  a();
  a();
  await tick();
  assert.deepEqual(calls, ['composing']);
  b();
  await presence.close();
  assert.deepEqual(calls, ['composing', 'paused']);
});

test('hung presence writes are coalesced and the last update clears typing', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const presence = new TypingPresence(
    async (_chat, state) => {
      calls.push(state);
      if (state === 'composing') await blocked;
    },
    () => {},
    5,
  );
  const stop = presence.start('a@lid', new AbortController().signal);
  await delay(25);
  stop();
  assert.deepEqual(calls, ['composing']);
  release();
  await tick();
  await presence.close();
  assert.deepEqual(calls, ['composing', 'paused']);
});

test('presence expires locally, contains transport failures and cannot restart after shutdown', async () => {
  const calls: string[] = [];
  const presence = new TypingPresence(
    async (_chat, state) => {
      calls.push(state);
      throw new Error('socket unavailable');
    },
    () => {
      throw new Error('logging unavailable');
    },
    10000,
    15,
  );
  const alreadyStopped = new AbortController();
  alreadyStopped.abort();
  presence.start('ignored@lid', alreadyStopped.signal);
  presence.start('a@lid', new AbortController().signal);
  await delay(30);
  await presence.close();
  presence.start('ignored@lid', new AbortController().signal);
  assert.deepEqual(calls, ['composing', 'paused']);
});
