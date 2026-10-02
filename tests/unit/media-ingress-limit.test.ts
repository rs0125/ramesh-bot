import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { WAMessage } from '@whiskeysockets/baileys';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { toInboxCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import type { MediaService } from '../../src/modules/media/media.service.js';
import type { WhatsAppSession } from '../../src/infrastructure/whatsapp/baileys-session.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function message(index: number): WAMessage {
  return {
    key: { id: `fixture-${index}`, remoteJid: '100@s.whatsapp.net' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { audioMessage: { mimetype: 'audio/ogg' } },
  };
}
function queue(media: Partial<MediaService>) {
  return new DurableMessages(
    {
      enqueue: async () => 'queued',
      claimInbound: async () => null,
      claimOutbound: async () => null,
    } as never,
    {
      encryptionKey: randomBytes(32).toString('base64url'),
      maxAgeMs: 300000,
      capacity: 100,
      leaseMs: 1000,
      pollMs: 10,
      waitBeforeReply: async () => true,
      media: media as MediaService,
    },
  );
}

test('ingress holds at most three decoded buffers through persistence and skips stored sources', async () => {
  const persisted = new Map<string, string>([['fixture-100', randomUUID()]]);
  const persistence = gate(),
    firstThree = gate();
  let downloads = 0,
    held = 0,
    peakHeld = 0;
  const durable = queue({
    store: {
      get: async () => [],
      findSource: async (_owner: string, source: string) => persisted.get(source),
    } as never,
    async ingest(_owner, source) {
      await persistence.promise;
      held--;
      const id = randomUUID();
      persisted.set(source, id);
      return id;
    },
  });
  const transport = {
    async downloadMedia() {
      downloads++;
      held++;
      peakHeld = Math.max(peakHeld, held);
      if (downloads === 3) firstThree.resolve();
      return { bytes: Buffer.from('OggS synthetic'), mime: 'audio/ogg', name: 'fixture.ogg' };
    },
  } as unknown as WhatsAppSession;
  for (let index = 0; index < 20; index++) {
    const value = message(index);
    await durable.enqueue(value, toInboxCandidate(value, [])!, transport);
  }
  await firstThree.promise;
  await delay(5);
  assert.equal(downloads, 3, 'waiting SQL persistence still owns each buffer slot');
  const old = message(100);
  await durable.enqueue(old, toInboxCandidate(old, [])!, transport);
  persistence.resolve();
  await durable.drainMediaIngress();
  assert.equal(downloads, 20, 'exact source lookup skips old media outside the recent window');
  assert.equal(peakHeld, 3);
  assert.equal(held, 0);
  durable.stopMediaIngress();
});

test('stopping ingress cancels active downloads and queued downloads never start', async () => {
  const firstThree = gate();
  let downloads = 0,
    stored = 0;
  const durable = queue({
    store: { get: async () => [], findSource: async () => undefined } as never,
    async ingest() {
      stored++;
      return randomUUID();
    },
  });
  const transport = {
    async downloadMedia(_message: WAMessage, signal: AbortSignal) {
      downloads++;
      if (downloads === 3) firstThree.resolve();
      await delay(60000, undefined, { signal });
      return { bytes: Buffer.from('OggS'), mime: 'audio/ogg', name: 'fixture.ogg' };
    },
  } as unknown as WhatsAppSession;
  for (let index = 0; index < 20; index++) {
    const value = message(index);
    await durable.enqueue(value, toInboxCandidate(value, [])!, transport);
  }
  await firstThree.promise;
  durable.stopMediaIngress();
  await durable.drainMediaIngress();
  const afterStop = message(100);
  await durable.enqueue(afterStop, toInboxCandidate(afterStop, [])!, transport);
  await durable.drainMediaIngress();
  assert.equal(downloads, 3);
  assert.equal(stored, 0);
});

test('a transient consumer disconnect leaves media ingress available for the next connection', async () => {
  let downloads = 0;
  const durable = queue({
    store: { get: async () => [], findSource: async () => undefined } as never,
    async ingest() {
      return randomUUID();
    },
  });
  const transport = {
    async downloadMedia() {
      downloads++;
      return { bytes: Buffer.from('OggS'), mime: 'audio/ogg', name: 'fixture.ogg' };
    },
  } as unknown as WhatsAppSession;
  const connection = new AbortController();
  const consuming = durable.consume(transport, connection.signal, () => {});
  connection.abort();
  await consuming;
  const next = message(1);
  await durable.enqueue(next, toInboxCandidate(next, [])!, transport);
  await durable.drainMediaIngress();
  assert.equal(downloads, 1);
  durable.stopMediaIngress();
});
