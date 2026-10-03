/** Native pins use the same isolated local PostgreSQL queue as ordinary WhatsApp messages. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { InboxRepository } from '../../src/infrastructure/database/inbox.repository.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { toInboxCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';

test(
  'native pins persist encrypted, share burst membership with text and survive inbox history reload',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async () => {
    const db = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url');
    const cipher = authCipher(key);
    const account = 'native-pin-test';
    const chat = 'synthetic@lid';
    const policy = { textMs: 10000, burstMs: 15000, maxMs: 20000 };
    const repo = new MessageQueueRepository(db.runtime, account, policy);
    const queue = new DurableMessages(repo, {
      encryptionKey: key,
      maxAgeMs: 300000,
      capacity: 100,
      leaseMs: 30000,
      pollMs: 5,
      waitBeforeReply: async () => true,
    });
    const pin = (id: string, latitude: number, forwarded: boolean): WAMessage => ({
      key: { id, remoteJid: chat },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        locationMessage: {
          degreesLatitude: latitude,
          degreesLongitude: 78.123456,
          name: 'Synthetic site pin',
          contextInfo: { isForwarded: forwarded },
        },
      },
    });
    const pins = [pin('pin-one', 0, false), pin('pin-two', 17, true)];
    try {
      for (const value of pins)
        assert.equal(await queue.enqueue(value, toInboxCandidate(value, [])!), 'queued');
      const first = (
        await db.admin.query(
          `SELECT message_id,batch_count,media_count,
        extract(epoch FROM available_at-created_at)*1000 AS delay FROM public."ramesh-inbound-queue"
        WHERE account_id=$1 AND batch_parent IS NULL`,
          [account],
        )
      ).rows[0];
      assert.equal(first.batch_count, 2);
      assert.equal(first.media_count, 0, 'pins do not consume file attachment quota');
      assert.ok(Number(first.delay) >= 14000, 'native pin uses the configured burst window');
      const trigger: WAMessage = {
        key: { id: 'ask', remoteJid: chat },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'Compare both sites' },
      };
      assert.equal(await queue.enqueue(trigger, toInboxCandidate(trigger, [])!), 'queued');
      const afterText = (
        await db.admin.query(
          `SELECT batch_count,extract(epoch FROM available_at-clock_timestamp())*1000 AS remaining
        FROM public."ramesh-inbound-queue" WHERE message_id=$1`,
          [first.message_id],
        )
      ).rows[0];
      assert.equal(afterText.batch_count, 3);
      assert.ok(Number(afterText.remaining) <= 10000, 'following text closes the burst sooner');
      const rows = (
        await db.admin.query(
          `SELECT id,content_encrypted FROM public."ramesh-messages"
        WHERE account_id=$1 ORDER BY created_at,id`,
          [account],
        )
      ).rows;
      assert.doesNotMatch(JSON.stringify(rows), /Synthetic site pin|78\.123456/);
      const decoded = rows
        .slice(0, 2)
        .map((row) => cipher.open('inbox', row.id, row.content_encrypted) as { location: unknown });
      assert.deepEqual(
        decoded.map((value) => value.location),
        pins.map((value) => toInboxCandidate(value, [])!.location),
      );
      const restarted = new InboxRepository(db.runtime, account, key);
      const history = await restarted.context(toInboxCandidate(trigger, [])!);
      assert.deepEqual(
        history.map((item) => JSON.parse(item.content).latitude),
        [0, 17],
      );
      assert.ok(history.every((item) => item.role === 'user'));
      await db.admin.query(
        `UPDATE public."ramesh-inbound-queue" SET available_at=clock_timestamp()-interval '1 millisecond'
        WHERE account_id=$1`,
        [account],
      );
      const restoredQueue = new MessageQueueRepository(db.runtime, account, policy);
      const job = await restoredQueue.claimInbound(30000);
      assert.equal(job?.id, first.message_id);
      assert.equal(job?.members?.length, 2);
      // Untagged group pins are archived with coordinates, never admitted to a reply job.
      const untagged = pin('group-pin', 20, false);
      untagged.key = { ...untagged.key, remoteJid: 'synthetic@g.us', participant: chat };
      assert.equal(await queue.enqueue(untagged, toInboxCandidate(untagged, [])!), 'observed');
      const archived = (await restarted.messages('synthetic@g.us')).messages[0]!;
      assert.equal(JSON.parse(archived.text).latitude, 20);
      assert.equal(
        (
          await db.admin.query(
            `SELECT payload_encrypted FROM public."ramesh-messages"
        WHERE account_id=$1 AND whatsapp_message_id='group-pin'`,
            [account],
          )
        ).rows[0].payload_encrypted,
        null,
      );
    } finally {
      await db.close();
    }
  },
);
