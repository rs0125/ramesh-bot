/** Scheduling tests use encrypted synthetic input and a fake transport, never model/WhatsApp calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import type { MessageJob } from '../../src/infrastructure/database/message-queue.repository.js';
import type { PrepareReply } from '../../src/modules/greetings/greeting.types.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'condition did not complete');
    await delay(5);
  }
}
function fixture(prepareReply: PrepareReply, count = 4, leaseLost = false) {
  const encryptionKey = randomBytes(32).toString('base64url');
  const cipher = authCipher(encryptionKey);
  const rows = Array.from({ length: count }, (_, i) => {
    const id = randomUUID();
    const message: WAMessage = {
      key: { id, remoteJid: `synthetic-${i}@s.whatsapp.net` },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: `turn ${i}` },
    };
    return {
      state: 'ready',
      job: {
        id,
        chatId: message.key.remoteJid!,
        direction: 'inbound' as const,
        token: randomUUID(),
        attempts: 1,
        payload: cipher.seal(
          'message',
          id,
          Buffer.from(proto.WebMessageInfo.encode(message).finish()),
        ),
      } as MessageJob,
    };
  });
  const sent: string[] = [];
  let released = 0;
  let renewals = 0;
  const stop = new AbortController();
  const queue = new DurableMessages(
    {
      enqueue: async () => 'queued',
      claimInbound: async () => null,
      claimOutbound: async () => null,
      async claimNext() {
        const row = rows.find((r) => r.state === 'ready');
        if (!row) return null;
        row.state = 'leased';
        return row.job;
      },
      async renewLease() {
        renewals++;
        return !leaseLost;
      },
      async handoff(job, replyPayload) {
        const row = rows.find((r) => r.job.id === job.id)!;
        row.job = { ...job, direction: 'outbound', replyPayload };
        row.state = 'ready';
        return true;
      },
      async releaseUnsent(job) {
        rows.find((r) => r.job.id === job.id)!.state = 'released';
        released++;
        if (leaseLost) stop.abort();
      },
      async complete(job) {
        rows.find((r) => r.job.id === job.id)!.state = 'done';
        if (rows.every((r) => r.state === 'done')) stop.abort();
        return true;
      },
      beginSend: async () => true,
    },
    {
      encryptionKey,
      maxAgeMs: 300000,
      capacity: 100,
      concurrency: 3,
      leaseMs: leaseLost ? 30 : 1000,
      pollMs: 10,
      waitBeforeReply: async () => true,
      prepareReply,
    },
  );
  const run = () =>
    queue.consume(
      {
        botJids: [],
        on: () => () => {},
        saveCredentials: async () => {},
        close: async () => {},
        reply: async (_message, text) => {
          sent.push(text);
        },
      },
      stop.signal,
      () => {},
    );
  return { run, stop, sent, rows, released: () => released, renewals: () => renewals };
}

test('a blocked chat does not block others, with at most three active preparations', async () => {
  const held = gate();
  const started: string[] = [];
  let current = 0,
    peak = 0;
  const f = fixture(async (candidate) => {
    started.push(candidate.text!);
    current++;
    peak = Math.max(peak, current);
    try {
      if (candidate.text === 'turn 0') await held.promise;
      else await delay(10);
      return { text: `answer ${candidate.text}` };
    } finally {
      current--;
    }
  });
  const work = f.run();
  try {
    await until(() => f.sent.length === 3);
    assert.equal(f.sent.includes('answer turn 0'), false);
    assert.equal(started.length, 4);
    assert.equal(peak, 3);
    held.resolve();
    await work;
    assert.equal(f.sent.length, 4);
  } finally {
    f.stop.abort();
    held.resolve();
    await work;
  }
});

test('disconnect cancels active preparations and waits for all releases before returning', async () => {
  let active = 0;
  const f = fixture(async (_candidate, signal) => {
    active++;
    try {
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
      return { text: 'unreachable' };
    } finally {
      active--;
    }
  });
  const work = f.run();
  await until(() => active === 3);
  f.stop.abort();
  await work;
  assert.equal(active, 0);
  assert.equal(f.released(), 3);
  assert.equal(f.rows.filter((r) => r.state === 'ready').length, 1);
  assert.deepEqual(f.sent, []);
});

test('lease loss aborts unfinished preparation before handoff or delivery', async () => {
  let cancelled = false;
  const f = fixture(
    async (_candidate, signal) => {
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(new Error('lost lease'));
          },
          { once: true },
        ),
      );
      return { text: 'unreachable' };
    },
    1,
    true,
  );
  await f.run();
  assert.equal(cancelled, true);
  assert.ok(f.renewals() >= 1);
  assert.equal(f.released(), 1);
  assert.deepEqual(f.sent, []);
});
