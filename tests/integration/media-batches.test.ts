import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryMessageDatabase, postgresTestsEnabled } from '../fixtures/message-database.js';
import { MediaRepository } from '../../src/infrastructure/database/media.repository.js';
import { MediaService, mediaOwner } from '../../src/modules/media/media.service.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { toInboxCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import type { WAMessage } from '@whiskeysockets/baileys';
const policy = { textMs: 40, burstMs: 100, maxMs: 300 };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test(
  'durable bursts and private media contracts',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async (t) => {
    const db = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url');
    try {
      await t.test(
        'private media encrypts raw/extracted data, fences leases, expires before cleanup and survives service restart',
        async () => {
          const store = new MediaRepository(db.runtime, 'media-test', key, 'production');
          const owner = mediaOwner('a', 'chat', 'sender');
          let calls = 0;
          const processor = {
            extract: async () => {
              calls++;
              return 'Private voice note: site visit at 3 pm.';
            },
          };
          const service = new MediaService(store, processor);
          const source = randomUUID();
          const upload = {
            bytes: Buffer.from('%PDF-1.7\nprivate'),
            mime: 'application/pdf',
            name: 'private.pdf',
          };
          const id = await service.ingest(owner, source, upload);
          await service.drain();
          assert.equal(await service.ingest(owner, source, upload), id);
          await service.drain();
          assert.equal(calls, 1);
          assert.equal((await store.get(mediaOwner('a', 'chat', 'other'), [id])).length, 0);
          const atRest = (
            await db.admin.query(
              'SELECT upload_encrypted,extract_encrypted FROM public."ramesh-media" WHERE id=$1',
              [id],
            )
          ).rows[0];
          assert.ok(!JSON.stringify(atRest).includes('Private voice'));
          const restored = new MediaService(
            new MediaRepository(db.runtime, 'media-test', key, 'production'),
            processor,
          );
          assert.match(
            await restored.context(
              owner,
              [],
              'summarize the voice note',
              AbortSignal.timeout(1000),
            ),
            /site visit/,
          );
          assert.equal(await restored.context(owner, [], 'hello', AbortSignal.timeout(1000)), '');
          await db.admin.query(
            'UPDATE public."ramesh-media" SET expires_at=clock_timestamp()-interval \'1 second\' WHERE id=$1',
            [id],
          );
          assert.equal((await store.get(owner, [id])).length, 0);
          assert.match(
            await restored.context(owner, [id], 'summarize', AbortSignal.timeout(1000)),
            /unavailable_or_expired/,
          );
          await store.clean();
          assert.equal(
            (await db.admin.query('SELECT 1 FROM public."ramesh-media" WHERE id=$1', [id]))
              .rowCount,
            0,
          );
        },
      );
      await t.test(
        'forwarded text burst persists membership, ignores duplicates and produces one answer after restart',
        async () => {
          const account = 'burst-test';
          // Keep admission open independently of host load; advance persisted eligibility below.
          const burstPolicy = { textMs: 10000, burstMs: 15000, maxMs: 20000 };
          const repo = new MessageQueueRepository(db.runtime, account, burstPolicy);
          const inputs = ['Forwarded one', 'Forwarded two', 'Forwarded three', 'Summarize these'];
          const make = (i: number): WAMessage => ({
            key: { id: `forward-${i}`, remoteJid: '100@s.whatsapp.net' },
            message: {
              extendedTextMessage: { text: inputs[i], contextInfo: { isForwarded: i < 3 } },
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
          });
          const opts = {
            encryptionKey: key,
            maxAgeMs: 300000,
            capacity: 100,
            leaseMs: 30000,
            pollMs: 10,
            waitBeforeReply: async () => true,
          };
          const initial = new DurableMessages(repo, opts);
          for (let i = 0; i < 4; i++) {
            const m = make(i);
            await initial.enqueue(m, toInboxCandidate(m, [])!);
          }
          const deadlines = async () =>
            (
              await db.admin.query(
                'SELECT message_id,available_at,batch_count FROM public."ramesh-inbound-queue" WHERE account_id=$1 ORDER BY message_id',
                [account],
              )
            ).rows;
          const beforeDuplicate = await deadlines();
          assert.equal(await initial.enqueue(make(0), toInboxCandidate(make(0), [])!), 'duplicate');
          assert.deepEqual(await deadlines(), beforeDuplicate);
          assert.equal(await repo.claimInbound(30000), null);
          await db.admin.query(
            `UPDATE public."ramesh-inbound-queue" SET available_at=clock_timestamp()-interval '1 millisecond' WHERE account_id=$1`,
            [account],
          );
          let runs = 0,
            sends = 0;
          const restored = new DurableMessages(
            new MessageQueueRepository(db.runtime, account, burstPolicy),
            {
              ...opts,
              prepareReply: async (candidate) => {
                runs++;
                const parsed = JSON.parse(candidate.text!);
                assert.equal(parsed.messages.length, 4);
                assert.equal(parsed.messages[3].text, 'Summarize these');
                return { text: 'Combined reply' };
              },
            },
          );
          const abort = new AbortController();
          const work = restored.consume(
            {
              botJids: [],
              on: () => () => {},
              saveCredentials: async () => {},
              close: async () => {},
              reply: async () => {
                sends++;
                abort.abort();
              },
            },
            abort.signal,
            () => {},
          );
          await work;
          assert.equal(runs, 1);
          assert.equal(sends, 1);
          const rows = (
            await db.admin.query(
              'SELECT state,reason FROM public."ramesh-messages" WHERE account_id=$1 ORDER BY created_at',
              [account],
            )
          ).rows;
          assert.deepEqual(
            rows.map((r) => r.state),
            ['SENT', 'OBSERVED', 'OBSERVED', 'OBSERVED'],
          );
          assert.equal(await repo.claimInbound(30000), null);
        },
      );
      await t.test('different senders never merge and retry keeps closed membership', async () => {
        const repo = new MessageQueueRepository(db.runtime, 'separate', policy);
        const candidate = (sender: string, id: string) => ({
          chatId: 'g@g.us',
          senderId: sender,
          messageId: id,
          sentAtMs: Date.now(),
          fromMe: false,
          isGroup: true,
          mentionsBot: true,
          text: 'forwarded',
          forwarded: true,
        });
        const one = randomUUID(),
          two = randomUUID();
        await repo.enqueue(one, candidate('a', '1'), 'a', 300000, 100);
        await repo.enqueue(two, candidate('b', '2'), 'b', 300000, 100);
        await delay(120);
        const job = await repo.claimInbound(30000);
        assert.ok(job);
        assert.equal(job.members, undefined);
        await repo.releaseUnsent(job, true);
        await repo.enqueue(randomUUID(), candidate('a', '3'), 'c', 300000, 100);
        const rows = (
          await db.admin.query(
            'SELECT batch_parent FROM public."ramesh-inbound-queue" WHERE account_id=$1',
            ['separate'],
          )
        ).rows;
        assert.ok(rows.every((r) => r.batch_parent === null));
      });
      await t.test(
        'out-of-order voice downloads preserve the original burst and attachment order',
        async () => {
          const account = 'ordered-voice-test';
          const owner = mediaOwner(account, '101@s.whatsapp.net', '101@s.whatsapp.net');
          const store = new MediaRepository(db.runtime, account, key, 'production');
          const media = new MediaService(store, {
            extract: async (upload) => upload.bytes.toString('utf8', 12),
          });
          const gates = Array.from({ length: 3 }, gate);
          const allStarted = gate();
          let downloads = 0;
          let delivered: string | undefined;
          const abort = new AbortController();
          const session = {
            botJids: [],
            on: () => () => {},
            saveCredentials: async () => {},
            close: async () => {},
            reply: async (_message: WAMessage, text: string) => {
              delivered = text;
              abort.abort();
            },
            downloadMedia: async (message: WAMessage) => {
              const index = Number(message.key.id!.split('-')[1]);
              if (++downloads === 3) allStarted.resolve();
              await gates[index]!.promise;
              return {
                bytes: Buffer.from(`RIFF0000WAVEVoice note ${index + 1}`),
                mime: 'audio/wav',
                name: 'voice.wav',
              };
            },
          };
          let prepared = 0;
          let captured: { text: string; mediaContext: string } | undefined;
          const durable = new DurableMessages(
            new MessageQueueRepository(db.runtime, account, policy),
            {
              encryptionKey: key,
              accountId: account,
              maxAgeMs: 300000,
              capacity: 100,
              leaseMs: 30000,
              pollMs: 10,
              waitBeforeReply: async () => true,
              media,
              prepareReply: async (candidate, _signal, trusted) => {
                prepared++;
                captured = { text: candidate.text!, mediaContext: trusted!.mediaContext! };
                return { text: 'One ordered summary' };
              },
            },
          );
          for (let i = 0; i < 4; i++) {
            const message: WAMessage = {
              key: { id: `voice-${i}`, remoteJid: '101@s.whatsapp.net' },
              messageTimestamp: Math.floor(Date.now() / 1000),
              message:
                i < 3
                  ? { audioMessage: { mimetype: 'audio/ogg', contextInfo: { isForwarded: true } } }
                  : { conversation: 'Summarize these three notes' },
            };
            await durable.enqueue(message, toInboxCandidate(message, [])!, session);
          }
          await allStarted.promise;
          // Persist in the opposite order before claiming; retrieval time is not send order.
          for (let i = 2; i >= 0; i--) {
            gates[i]!.resolve();
            while ((await store.get(owner)).length < 3 - i) await delay(5);
          }
          await durable.consume(
            session,
            AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
            () => {},
          );
          assert.equal(prepared, 1);
          assert.equal(
            delivered,
            'Voice note 1\n_"Voice note 1"_\n\nVoice note 2\n_"Voice note 2"_\n\nVoice note 3\n_"Voice note 3"_\n\nOne ordered summary',
          );
          const savedRow = (
            await db.admin.query(
              'SELECT id,reply_encrypted FROM public."ramesh-messages" WHERE account_id=$1 AND reply_encrypted IS NOT NULL',
              [account],
            )
          ).rows[0];
          const payload = authCipher(key).open(
            'outbound-reply',
            savedRow.id,
            savedRow.reply_encrypted,
          ) as { text: string; voice: { ids: string[] } };
          assert.equal(payload.text, 'One ordered summary');
          assert.equal(payload.voice.ids.length, 3);
          assert.ok(!JSON.stringify(payload).includes('Voice note 1'));

          const burst = JSON.parse(captured!.text);
          const context = JSON.parse(captured!.mediaContext);
          assert.deepEqual(
            context.attachments.map((a: { text: string }) => a.text),
            ['Voice note 1', 'Voice note 2', 'Voice note 3'],
          );
          for (let i = 0; i < 3; i++)
            assert.equal(burst.messages[i].attachments[0], context.attachments[i].attachment);
          assert.equal(burst.messages[3].text, 'Summarize these three notes');
          const later = JSON.parse(
            await media.context(owner, [], 'the second voice note', AbortSignal.timeout(1000)),
          );
          assert.deepEqual(
            later.attachments.map((a: { text: string }) => a.text),
            ['Voice note 1', 'Voice note 2', 'Voice note 3'],
          );
          await media.stop();
        },
      );
    } finally {
      await db.close();
    }
  },
);
