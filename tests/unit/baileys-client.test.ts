/** Connection lifecycle regression tests use fake sessions; no WhatsApp account is accessed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { DisconnectReason, type BaileysEventMap, type WAMessage } from '@whiskeysockets/baileys';
import { BaileysClient } from '../../src/infrastructure/whatsapp/baileys-client.js';
import type { WhatsAppSession } from '../../src/infrastructure/whatsapp/baileys-session.js';
import { reconnectDelay } from '../../src/infrastructure/whatsapp/reconnect.policy.js';
import { createReplyDelay } from '../../src/lib/reply-delay.js';
import { GreetingService } from '../../src/modules/greetings/greeting.service.js';
import { MemoryGreetingRepository } from '../fixtures/greeting-repository.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';

class FakeSession implements WhatsAppSession {
  readonly events = new EventEmitter();
  readonly botJids = ['10000000000@s.whatsapp.net'];
  closed = false;
  saved = 0;
  acknowledgeDelivery?: (message: WAMessage) => void;
  on<K extends keyof BaileysEventMap>(event: K, handler: (value: BaileysEventMap[K]) => void) {
    this.events.on(event, handler);
    return () => {
      this.events.off(event, handler);
    };
  }
  async saveCredentials() {
    this.saved++;
  }
  async reply(_message: WAMessage, _text: string) {}
  async close() {
    this.closed = true;
    this.events.emit('creds.update', {});
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const message = (id: string): WAMessage => ({
  key: { id, remoteJid: '20000000000@s.whatsapp.net' },
  message: { conversation: 'hi' },
  messageTimestamp: Date.now() / 1000,
});

test('delivery is acknowledged only after durable archival, including duplicates and full inboxes', async () => {
  const session = new FakeSession();
  const saved: string[] = [];
  const acknowledged: string[] = [];
  session.acknowledgeDelivery = (value) => {
    assert.ok(saved.includes(value.key.id!));
    acknowledged.push(value.key.id!);
    if (value.key.id === 'observed') throw new Error('receipt failure');
  };
  const client = new BaileysClient({
    createSession: async () => session,
    logger: pino({ level: 'silent' }),
    onQr() {},
    handleMessage: async () => assert.fail('durable path expected'),
    durableMessages: {
      async enqueue(value: WAMessage) {
        const id = value.key.id!;
        if (id === 'failed') throw new Error('persistence failed');
        if (id !== 'ignored') saved.push(id);
        return id;
      },
    } as unknown as DurableMessages,
  });
  await client.start();
  session.events.emit('messages.upsert', { type: 'append', messages: [message('queued-offline')] });
  session.events.emit('messages.upsert', {
    type: 'notify',
    messages: [
      message('queued'),
      message('duplicate'),
      message('observed'),
      message('full'),
      message('failed'),
      message('ignored'),
      { ...message('self'), key: { ...message('self').key, fromMe: true } },
      {
        ...message('queued-audio'),
        message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } },
      },
    ],
  });
  await tick();
  await client.stop();
  assert.deepEqual(acknowledged, [
    'queued-offline',
    'queued',
    'duplicate',
    'observed',
    'full',
    'queued-audio',
  ]);
  assert.equal(client.getStatus().metrics.errors, 1, 'a receipt failure is not a storage failure');
});

test('offline append deliveries use durable age, mention and deduplication checks without importing history', async () => {
  const session = new FakeSession();
  const archived = new Map<string, boolean>();
  const acknowledged: string[] = [];
  session.acknowledgeDelivery = (value) => {
    assert.ok(archived.has(value.key.id!), 'archive precedes delivery receipt');
    acknowledged.push(value.key.id!);
  };
  const durableMessages = new DurableMessages(
    {
      async enqueue(_id, candidate, _payload, _maxAgeMs, _capacity, inbox) {
        if (archived.has(candidate.messageId)) return 'duplicate';
        archived.set(candidate.messageId, inbox!.replyEligible);
        return inbox!.replyEligible ? 'queued' : 'observed';
      },
      async claimInbound() {
        assert.fail('this test only admits messages');
      },
      async claimOutbound() {
        assert.fail('this test only admits messages');
      },
      async handoff() {
        assert.fail('this test only admits messages');
      },
      async beginSend() {
        assert.fail('this test cannot send messages');
      },
      async complete() {
        assert.fail('this test cannot send messages');
      },
      async releaseUnsent() {
        assert.fail('this test cannot send messages');
      },
    },
    {
      encryptionKey: randomBytes(32).toString('base64url'),
      maxAgeMs: 300_000,
      capacity: 100,
      leaseMs: 90_000,
      pollMs: 5,
      waitBeforeReply: async () => true,
    },
  );
  const client = new BaileysClient({
    createSession: async () => session,
    logger: pino({ level: 'silent' }),
    onQr() {},
    handleMessage: async () => assert.fail('durable path expected'),
    durableMessages,
  });
  const groupMessage = (id: string, mentionsBot: boolean): WAMessage => ({
    ...message(id),
    key: {
      id,
      remoteJid: 'synthetic-group@g.us',
      participant: '20000000000@s.whatsapp.net',
    },
    message: {
      extendedTextMessage: {
        text: 'hello',
        contextInfo: { mentionedJid: mentionsBot ? session.botJids : [] },
      },
    },
  });
  await client.start();
  session.events.emit('messaging-history.set', { messages: [message('history')] });
  session.events.emit('messages.upsert', {
    type: 'append',
    messages: [
      { ...message('offline'), messageTimestamp: Date.now() / 1000 - 120 },
      { ...message('old'), messageTimestamp: Date.now() / 1000 - 600 },
      { ...message('future'), messageTimestamp: Date.now() / 1000 + 120 },
      { ...message('self'), key: { ...message('self').key, fromMe: true } },
      { ...message('protocol'), message: { protocolMessage: {} } },
      groupMessage('group-unmentioned', false),
      groupMessage('group-mentioned', true),
    ],
  });
  session.events.emit('messages.upsert', {
    type: 'notify',
    messages: [message('offline'), message('live')],
  });
  await tick();
  await client.stop();
  assert.deepEqual(
    [...archived],
    [
      ['offline', true],
      ['old', false],
      ['future', false],
      ['group-unmentioned', false],
      ['group-mentioned', true],
      ['live', true],
    ],
  );
  assert.equal(client.getStatus().metrics.duplicates, 1);
  assert.equal(client.getStatus().metrics.errors, 0);
  assert.deepEqual(acknowledged, [
    'offline',
    'old',
    'future',
    'group-unmentioned',
    'group-mentioned',
    'offline',
    'live',
  ]);
});

test('stop finishes active work, skips queued messages, and saves final credentials', async () => {
  const session = new FakeSession();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  const client = new BaileysClient({
    createSession: async () => session,
    logger: pino({ level: 'silent' }),
    onQr() {},
    handleMessage: async (candidate) => {
      seen.push(candidate.messageId);
      await held;
      assert.equal(session.closed, false);
      return 'sent';
    },
  });
  await client.start();
  session.events.emit('messaging-history.set', { messages: [message('history')] });
  session.events.emit('messages.upsert', {
    type: 'notify',
    messages: [message('first'), message('second')],
  });
  await tick();
  const stopping = client.stop();
  session.events.emit('messages.upsert', { type: 'notify', messages: [message('too-late')] });
  assert.equal(session.closed, false);
  release();
  await stopping;
  assert.deepEqual(seen, ['first']);
  assert.equal(session.closed, true);
  assert.equal(session.saved, 1);
  assert.equal(client.getStatus().state, 'stopped');
  assert.equal(session.events.listenerCount('messages.upsert'), 0);
});

test('pairing state is transient, terminal logout requires manual reconnect, and reconnects can be stopped', async () => {
  const sessions: FakeSession[] = [];
  const client = new BaileysClient({
    createSession: async () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    logger: pino({ level: 'silent' }),
    onQr() {},
    handleMessage: async () => 'sent',
  });
  await client.start();
  const first = sessions[0]!;
  first.events.emit('connection.update', { qr: 'synthetic-qr' });
  assert.equal(client.getStatus().qr, 'synthetic-qr');
  first.events.emit('connection.update', { connection: 'open' });
  assert.equal(client.getStatus().qr, null);
  first.events.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
  });
  assert.equal(client.getStatus().state, 'error');
  await client.start();
  assert.equal(sessions.length, 2);
  assert.equal(first.closed, true);
  sessions[1]!.events.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
  });
  assert.equal(client.getStatus().state, 'reconnecting');
  await client.stop();
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(sessions.length, 2, 'stop cancels the scheduled reconnect');
});

test('reconnect delays are bounded and revoked sessions are terminal', () => {
  assert.equal(
    reconnectDelay(undefined, 0, () => 0),
    500,
  );
  assert.equal(
    reconnectDelay(undefined, 0, () => 1 - Number.EPSILON),
    1000,
  );
  assert.equal(
    reconnectDelay(undefined, 100, () => 0),
    15_000,
  );
  assert.equal(
    reconnectDelay(undefined, 100, () => 1 - Number.EPSILON),
    30_000,
  );
  assert.equal(reconnectDelay(DisconnectReason.restartRequired, 5), 500);
  assert.equal(reconnectDelay(DisconnectReason.connectionReplaced, 0), null);
});

test('a flood is bounded and admitted messages drain in order', async () => {
  const session = new FakeSession();
  const seen: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = new BaileysClient({
    createSession: async () => session,
    maxPendingMessages: 3,
    logger: pino({ level: 'silent' }),
    onQr() {},
    handleMessage: async (candidate) => {
      seen.push(candidate.messageId);
      await held;
      return 'sent';
    },
  });
  await client.start();
  session.events.emit('messages.upsert', {
    type: 'notify',
    messages: Array.from({ length: 100 }, (_, id) => message(String(id))),
  });
  await tick();
  assert.equal(client.getStatus().metrics.dropped, 97);
  release();
  await tick();
  await client.stop();
  assert.deepEqual(seen, ['0', '1', '2']);
});

for (const cause of ['stop', 'connection loss', 'storage failure'] as const) {
  test(`${cause} cancels delayed replies and skips queued messages`, async () => {
    const session = new FakeSession();
    const repository = new MemoryGreetingRepository();
    const service = new GreetingService(
      repository,
      300_000,
      Date.now,
      createReplyDelay({ minMs: 60_000, maxMs: 60_000 }),
    );
    session.reply = async () => {
      assert.fail('pending replies must be cancelled');
    };
    const client = new BaileysClient({
      createSession: async () => session,
      logger: pino({ level: 'silent' }),
      onQr() {},
      handleMessage: (candidate, reply, signal) => service.handle(candidate, reply, signal),
    });
    await client.start();
    session.events.emit('messages.upsert', {
      type: 'notify',
      messages: [message('waiting'), message('queued')],
    });
    await tick();
    assert.equal(repository.claims.size, 1);
    if (cause === 'connection loss') {
      session.events.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } },
      });
    } else if (cause === 'storage failure') {
      session.saveCredentials = async () => {
        throw new Error('disk full');
      };
      session.events.emit('creds.update', {});
    } else {
      await client.stop();
    }
    await tick();
    assert.equal(client.getStatus().metrics.replied, 0);
    assert.equal(client.getStatus().metrics.errors, 0);
    assert.deepEqual([...repository.claims.values()], ['CLAIMED']);
    await client.stop();
    assert.equal(session.closed, true);
  });
}

test('transient session creation failures continue retrying and can recover', async () => {
  let attempts = 0;
  const session = new FakeSession();
  const client = new BaileysClient({
    createSession: async () => {
      if (++attempts < 3) throw new Error('network');
      return session;
    },
    retryDelay: () => 5,
    logger: pino({ level: 'silent' }),
    onQr() {},
    handleMessage: async () => 'sent',
  });
  try {
    await assert.rejects(client.start(), /network/);
    for (let i = 0; i < 100 && attempts < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(attempts, 3);
    session.events.emit('connection.update', { connection: 'open' });
    assert.equal(client.getStatus().state, 'connected');
  } finally {
    await client.stop();
  }
});

test('credential failure closes the socket and prevents more replies', async () => {
  const session = new FakeSession();
  session.saveCredentials = async () => {
    throw new Error('disk full');
  };
  let replies = 0;
  const client = new BaileysClient({
    createSession: async () => session,
    logger: pino({ level: 'silent' }),
    onQr() {},
    handleMessage: async () => {
      replies++;
      return 'sent';
    },
  });
  await client.start();
  session.events.emit('connection.update', { qr: 'private-qr' });
  session.events.emit('creds.update', {});
  await tick();
  await tick();
  session.events.emit('messages.upsert', { type: 'notify', messages: [message('after-failure')] });
  assert.equal(client.getStatus().state, 'error');
  assert.equal(client.getStatus().qr, null);
  assert.equal(session.closed, true);
  assert.equal(replies, 0);
  await client.stop();
});
