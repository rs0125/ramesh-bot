/** Real local queues with fake assistant/WhatsApp boundaries, never provider calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { WAMessage } from '@whiskeysockets/baileys';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { toInboxCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'control did not complete');
    await delay(5);
  }
}

test(
  'STOP cancels live work immediately, clears typing and sends one durable reply without affecting another chat',
  {
    skip: !postgresTestsEnabled,
    timeout: 15000,
  },
  async () => {
    const db = await temporaryMessageDatabase();
    const controller = new AbortController();
    let consumer: Promise<void> | undefined;
    let started = false,
      cancelled = false,
      cleared = false;
    const modelTurns: string[] = [],
      replies: Array<{ id: string; text: string }> = [];
    const repo = new MessageQueueRepository(db.runtime, 'controls');
    const queue = new DurableMessages(repo, {
      encryptionKey: randomBytes(32).toString('base64url'),
      accountId: 'controls',
      maxAgeMs: 300000,
      capacity: 100,
      leaseMs: 30000,
      pollMs: 5,
      concurrency: 2,
      waitBeforeReply: async () => true,
      prepareReply: async (candidate, signal) => {
        modelTurns.push(candidate.text!);
        if (candidate.text === 'Investigate this') {
          started = true;
          await new Promise<void>((resolve) => {
            signal!.addEventListener(
              'abort',
              () => {
                cancelled = true;
                resolve();
              },
              { once: true },
            );
          });
        }
        return {
          text: candidate.text === 'Hello' ? 'Other chat answer' : 'Stale investigation answer',
          onSent:
            candidate.text === 'Investigate this'
              ? () => assert.fail('Cancelled work cannot enter memory')
              : undefined,
        };
      },
    });
    const incoming = (
      id: string,
      text: string,
      chatId = '919000000001@s.whatsapp.net',
    ): WAMessage => ({
      key: { id, remoteJid: chatId, fromMe: false },
      message: { conversation: text },
      messageTimestamp: Math.floor(Date.now() / 1000),
    });
    const admit = (message: WAMessage) => queue.enqueue(message, toInboxCandidate(message, [])!);
    try {
      await admit(incoming('research', 'Investigate this'));
      consumer = queue.consume(
        {
          botJids: [],
          on: () => () => {},
          saveCredentials: async () => {},
          close: async () => {},
          startTyping: (chatId) => () => {
            if (chatId === '919000000001@s.whatsapp.net') cleared = true;
          },
          reply: async (message, text) => {
            replies.push({ id: message.key.id!, text });
          },
        },
        controller.signal,
        () => {},
      );
      await until(() => started);
      await admit(incoming('other', 'Hello', '919000000002@s.whatsapp.net'));
      const stop = incoming('stop', 'stop');
      assert.equal(await admit(stop), 'queued');
      await until(() => cancelled && cleared && replies.length === 2);
      assert.equal(await admit(stop), 'duplicate');
      assert.deepEqual(modelTurns.sort(), ['Hello', 'Investigate this']);
      assert.ok(
        replies.some((reply) => reply.id === 'stop' && reply.text === 'Stopped your pending work.'),
      );
      assert.ok(
        replies.some((reply) => reply.id === 'other' && reply.text === 'Other chat answer'),
      );
      assert.ok(replies.every((reply) => !reply.text.includes('Stale')));
      const stopped = (
        await db.admin.query(
          `SELECT state,reason FROM public."ramesh-messages" WHERE account_id='controls' AND whatsapp_message_id='research'`,
        )
      ).rows[0];
      assert.deepEqual(stopped, { state: 'EXPIRED', reason: 'user_stopped' });
    } finally {
      controller.abort();
      await consumer;
      await db.close();
    }
  },
);
