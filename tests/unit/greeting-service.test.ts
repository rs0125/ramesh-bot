/** Pacing must not delay ignored/duplicate events or send messages that expire while waiting. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GreetingService } from '../../src/modules/greetings/greeting.service.js';
import { createReplyDelay } from '../../src/lib/reply-delay.js';
import { MemoryGreetingRepository } from '../fixtures/greeting-repository.js';

const candidate = {
  chatId: '20000000000@s.whatsapp.net',
  messageId: 'fresh',
  sentAtMs: 10_000,
  fromMe: false,
  isGroup: false,
  mentionsBot: false,
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('eligibility and deduplication precede the delay, and sending waits for it', async () => {
  const repository = new MemoryGreetingRepository();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waits = 0;
  const service = new GreetingService(
    repository,
    1000,
    () => 10_000,
    async () => {
      waits++;
      await held;
      return true;
    },
  );
  const sent: string[] = [];
  const reply = async (text: string) => {
    sent.push(text);
  };
  assert.equal(await service.handle({ ...candidate, fromMe: true }, reply), 'ignored');
  assert.equal(await service.handle({ ...candidate, isGroup: true }, reply), 'ignored');
  assert.equal(await service.handle({ ...candidate, sentAtMs: 0 }, reply), 'ignored');
  assert.equal(waits, 0);
  const pending = service.handle(candidate, reply);
  await tick();
  assert.equal(await service.handle(candidate, reply), 'duplicate');
  assert.equal(waits, 1);
  assert.deepEqual(sent, []);
  release();
  assert.equal(await pending, 'sent');
  assert.deepEqual(sent, ['hello']);
  assert.deepEqual([...repository.claims.values()], ['SENT']);
});

test('a message that expires during the delay is skipped and cannot be replayed', async () => {
  const repository = new MemoryGreetingRepository();
  let now = 10_000;
  const service = new GreetingService(
    repository,
    1000,
    () => now,
    async () => {
      now += 1500;
      return true;
    },
  );
  const reply = async () => {
    assert.fail('expired message must not be sent');
  };
  assert.equal(await service.handle(candidate, reply), 'ignored');
  assert.deepEqual([...repository.claims.values()], ['CLAIMED']);
  now = 10_000;
  assert.equal(await service.handle(candidate, reply), 'duplicate');
});

test('cancelling a delayed greeting neither sends nor reports a delivery failure', async () => {
  const repository = new MemoryGreetingRepository();
  const controller = new AbortController();
  const service = new GreetingService(
    repository,
    1000,
    () => 10_000,
    createReplyDelay({ minMs: 60_000, maxMs: 60_000 }),
  );
  const reply = async () => {
    assert.fail('cancelled message must not be sent');
  };
  const pending = service.handle(candidate, reply, controller.signal);
  await tick();
  controller.abort();
  assert.equal(await pending, 'ignored');
  assert.equal(
    await service.handle({ ...candidate, messageId: 'queued' }, reply, controller.signal),
    'ignored',
  );
  assert.deepEqual([...repository.claims.values()], ['CLAIMED']);
  assert.equal(await service.handle(candidate, reply), 'duplicate');
});
