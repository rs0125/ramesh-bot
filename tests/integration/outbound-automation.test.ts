/** Synthetic local PostgreSQL checks: no models, external data or transport sends. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { temporaryMessageDatabase, postgresTestsEnabled } from '../fixtures/message-database.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { InboxRepository } from '../../src/infrastructure/database/inbox.repository.js';
import { AutomationOutboundService } from '../../src/modules/messaging/outbound-automation.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import type { GreetingCandidate } from '../../src/modules/greetings/greeting.types.js';

const chatId = '919000000099@s.whatsapp.net';
const candidate = (id: string = randomUUID()): GreetingCandidate => ({
  chatId,
  messageId: id,
  sentAtMs: Date.now(),
  fromMe: false,
  isGroup: false,
  mentionsBot: false,
});

test(
  'outbound automation storage and inbox boundaries',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async (t) => {
    const db = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url');
    const cipher = authCipher(key);
    const fixture = (text = 'Synthetic private reminder', media = true) => {
      const id = randomUUID();
      const data = Buffer.from('%PDF-1.7\nSynthetic attachment');
      return {
        id,
        fingerprint: createHash('sha256')
          .update(JSON.stringify([chatId, text, media, 900]))
          .digest('hex'),
        content: cipher.seal('inbox', id, {
          text,
          senderId: null,
          senderName: 'Ramesh',
          chatName: null,
          kind: media ? 'document' : 'text',
        }),
        reply: cipher.seal('outbound-reply', id, text),
        media: media
          ? {
              payload: cipher.seal('outbound-media', id, {
                version: 1,
                dataBase64: data.toString('base64'),
              }),
              byteLength: data.length,
            }
          : undefined,
      };
    };
    const enqueue = (repo: MessageQueueRepository, f = fixture(), capacity = 100) =>
      repo.enqueueAutomation(
        f.id,
        chatId,
        f.content,
        f.reply,
        capacity,
        f.fingerprint,
        900,
        f.media,
      );
    const mediaFor = async (id: string) =>
      (
        await db.admin.query(
          `SELECT media_payload_encrypted,media_byte_length,media_expires_at FROM public."ramesh-outbound-queue" WHERE message_id=$1`,
          [id],
        )
      ).rows[0];
    const assertPurged = async (id: string) =>
      assert.deepEqual(await mediaFor(id), {
        media_payload_encrypted: null,
        media_byte_length: null,
        media_expires_at: null,
      });
    try {
      await t.test(
        'concurrent identical retries admit once, retain expiry and reject conflicting reuse',
        async () => {
          const repo = new MessageQueueRepository(db.runtime, 'automation-idempotent');
          const f = fixture();
          const outcomes = await Promise.all(Array.from({ length: 5 }, () => enqueue(repo, f, 1)));
          assert.equal(outcomes.filter((x) => x === 'queued').length, 1);
          assert.equal(outcomes.filter((x) => x === 'duplicate').length, 4);
          const before = await repo.automationStatus(f.id);
          assert.equal(before!.state, 'READY_TO_SEND');
          assert.equal(
            Object.keys(before!).sort().join(','),
            'createdAt,expiresAt,finishedAt,messageId,reason,state',
          );
          assert.equal(await enqueue(repo, fixture(), 1), 'full');
          assert.equal(
            await repo.enqueueAutomation(
              f.id,
              chatId,
              f.content,
              f.reply,
              1,
              'f'.repeat(64),
              900,
              f.media,
            ),
            'conflict',
          );
          const claim = (await repo.claimNext(30000))!;
          assert.equal(claim.origin, 'automation');
          assert.equal(claim.mediaPayload, f.media!.payload);
          assert.equal(await repo.beginSend(claim), true);
          assert.equal(await repo.complete(claim, 'SENT'), true);
          await assertPurged(f.id);
          assert.equal(await enqueue(repo, f), 'duplicate', 'a sent attachment is never recreated');
          assert.equal((await repo.automationStatus(f.id))!.expiresAt, before!.expiresAt);
          assert.equal((await repo.automationStatus(f.id))!.state, 'SENT');
          await assertPurged(f.id);
          assert.equal(
            (
              await db.admin.query(
                `SELECT 1 FROM public."ramesh-inbound-queue" WHERE message_id=$1`,
                [f.id],
              )
            ).rowCount,
            0,
          );
          assert.ok(!JSON.stringify(await mediaFor(f.id)).includes('Synthetic attachment'));
        },
      );

      await t.test(
        'admission rolls back the ledger when outbound insertion fails, with media bounds enforced',
        async () => {
          const repo = new MessageQueueRepository(db.runtime, 'automation-atomic');
          const f = fixture();
          await db.admin.query(
            'REVOKE INSERT ON public."ramesh-outbound-queue" FROM ramesh_worker',
          );
          try {
            await assert.rejects(enqueue(repo, f), /permission denied/);
          } finally {
            await db.admin.query('GRANT INSERT ON public."ramesh-outbound-queue" TO ramesh_worker');
          }
          assert.equal(await repo.automationStatus(f.id), null);
          assert.equal(
            (await db.admin.query(`SELECT 1 FROM public."ramesh-messages" WHERE id=$1`, [f.id]))
              .rowCount,
            0,
          );
          await assert.rejects(
            repo.enqueueAutomation(f.id, chatId, f.content, f.reply, 100, f.fingerprint, 900, {
              payload: 'opaque',
              byteLength: 8388609,
            }),
            /INVALID_AUTOMATION_ENQUEUE/,
          );
          await assert.rejects(
            repo.enqueueAutomation(f.id, 'group@g.us', f.content, f.reply, 100, f.fingerprint, 900),
            /INVALID_AUTOMATION_ENQUEUE/,
          );
          await assert.rejects(
            repo.enqueueAutomation(f.id, chatId, f.content, f.reply, 100, f.fingerprint, 86401),
            /INVALID_AUTOMATION_ENQUEUE/,
          );
          assert.equal(await enqueue(repo, f), 'queued');
          const raw = await mediaFor(f.id);
          assert.equal(raw.media_byte_length, f.media!.byteLength);
          assert.ok(!JSON.stringify(raw).includes('Synthetic attachment'));
          await assert.rejects(
            db.runtime.query(
              `UPDATE public."ramesh-outbound-queue" SET media_byte_length=8388609 WHERE message_id=$1`,
              [f.id],
            ),
            /check constraint/,
          );
          await assert.rejects(
            db.runtime.query(
              `UPDATE public."ramesh-outbound-queue" SET media_expires_at=NULL WHERE message_id=$1`,
              [f.id],
            ),
            /check constraint/,
          );
          const functionAcl = (
            await db.admin.query(
              `SELECT has_function_privilege('anon','public."ramesh-purge-terminal-outbound-media"()','EXECUTE') AS anon, has_function_privilege('ramesh_worker','public."ramesh-purge-terminal-outbound-media"()','EXECUTE') AS worker`,
            )
          ).rows[0];
          assert.deepEqual(functionAcl, { anon: false, worker: true });
        },
      );

      await t.test(
        'terminal outcomes, expired work and interrupted sends erase attachment bytes',
        async () => {
          for (const state of ['FAILED', 'EXPIRED', 'UNCERTAIN'] as const) {
            const repo = new MessageQueueRepository(
              db.runtime,
              `automation-${state.toLowerCase()}`,
            );
            const f = fixture();
            await enqueue(repo, f);
            assert.equal(await repo.complete((await repo.claimNext(30000))!, state), true);
            await assertPurged(f.id);
            assert.equal(await enqueue(repo, f), 'duplicate');
          }
          const crashed = new MessageQueueRepository(db.runtime, 'automation-interrupted');
          const f = fixture();
          await enqueue(crashed, f);
          const old = (await crashed.claimNext(30000))!;
          await crashed.beginSend(old);
          await db.admin.query(
            `UPDATE public."ramesh-outbound-queue" SET lease_until=clock_timestamp()-interval '1 second' WHERE message_id=$1`,
            [f.id],
          );
          await crashed.clean();
          assert.equal((await crashed.automationStatus(f.id))!.state, 'UNCERTAIN');
          await assertPurged(f.id);
          assert.equal(await crashed.complete(old, 'SENT'), false);
          const expired = new MessageQueueRepository(db.runtime, 'automation-expired');
          const stale = fixture();
          await enqueue(expired, stale);
          await db.admin.query(
            `UPDATE public."ramesh-messages" SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
            [stale.id],
          );
          await assertPurged(stale.id);
          await expired.clean();
          assert.equal((await expired.automationStatus(stale.id))!.state, 'EXPIRED');
          assert.equal(await expired.claimNext(30000), null);
          // Time can expire media while the message has a live lease; maintenance still clears it.
          const retained = fixture();
          await enqueue(expired, retained);
          await expired.claimNext(30000);
          await db.admin.query(
            `UPDATE public."ramesh-outbound-queue" SET media_expires_at=clock_timestamp()-interval '1 second' WHERE message_id=$1`,
            [retained.id],
          );
          await expired.clean();
          await assertPurged(retained.id);
        },
      );

      await t.test(
        'new targets appear as outgoing-only chats while operator destination restrictions stay intact',
        async () => {
          const repo = new MessageQueueRepository(db.runtime, 'automation-inbox');
          const inbox = new InboxRepository(db.runtime, repo.accountId, key);
          const f = fixture('Synthetic scheduled reminder', false);
          await enqueue(repo, f);
          const chats = await inbox.conversations();
          assert.equal(chats.conversations.length, 1);
          assert.equal(chats.conversations[0]!.chatId, chatId);
          assert.equal(chats.conversations[0]!.name, '+919000000099');
          assert.equal(chats.conversations[0]!.lastMessage, 'Synthetic scheduled reminder');
          const visible = await inbox.messages(chatId);
          assert.equal(visible.messages.length, 1);
          assert.equal(visible.messages[0]!.source, 'automation');
          assert.equal(visible.messages[0]!.direction, 'outbound');
          assert.equal(
            await repo.enqueueAdmin(randomUUID(), chatId, 'opaque', 'opaque', 100, 'a'.repeat(64)),
            'unknown_chat',
          );
          const outbound = (await repo.claimNext(30000))!;
          await repo.beginSend(outbound);
          await repo.complete(outbound, 'SENT');
          const trigger = candidate();
          const inputId = randomUUID();
          await repo.enqueue(inputId, trigger, 'opaque', 300000, 100, {
            content: cipher.seal('inbox', inputId, {
              text: 'Acknowledge reminder',
              senderId: chatId,
              senderName: 'Fixture recipient',
              chatName: null,
              kind: 'text',
            }),
            replyEligible: true,
          });
          const context = await inbox.context(trigger);
          assert.deepEqual(context, [
            { role: 'assistant', content: 'Synthetic scheduled reminder' },
          ]);
          assert.equal((await inbox.conversations()).conversations[0]!.name, 'Fixture recipient');
          assert.equal(
            await repo.enqueueAdmin(randomUUID(), chatId, 'opaque', 'opaque', 100, 'b'.repeat(64)),
            'queued',
          );
          const laterAutomation = fixture('Later automation', false);
          await enqueue(repo, laterAutomation);
          const inbound = (await repo.claimNext(30000))!;
          assert.equal(inbound.id, inputId);
          assert.equal(
            await repo.claimOutbound(30000),
            null,
            'later admin and automation cannot overtake incoming turn',
          );
        },
      );

      await t.test(
        'real automation envelope keeps attachment bytes out of retained text and conversation history',
        async () => {
          const repo = new MessageQueueRepository(db.runtime, 'automation-envelope');
          const service = new AutomationOutboundService(repo, key, 100);
          const inbox = new InboxRepository(db.runtime, repo.accountId, key);
          const dataBase64 = Buffer.from('%PDF-1.7\nPrivate fixture-only body').toString('base64');
          const request = {
            to: '+919000000099',
            text: '',
            expiresInSeconds: 900,
            media: { mimeType: 'application/pdf' as const, fileName: 'fixture.pdf', dataBase64 },
          };
          const result = await service.enqueue('fixture-envelope-key', request);
          assert.equal(result.status, 'queued');
          const row = (
            await db.admin.query(`SELECT * FROM public."ramesh-messages" WHERE id=$1`, [
              result.messageId,
            ])
          ).rows[0];
          const reply = cipher.open('outbound-reply', result.messageId, row.reply_encrypted);
          assert.ok(!JSON.stringify(reply).includes(dataBase64));
          assert.ok(!JSON.stringify(reply).includes('Private fixture-only body'));
          assert.ok(
            !JSON.stringify(cipher.open('inbox', result.messageId, row.content_encrypted)).includes(
              dataBase64,
            ),
          );
          const visible = await inbox.messages(chatId);
          assert.equal(visible.messages.length, 1);
          assert.equal(visible.messages[0]!.text, '[Document]');
          assert.equal(visible.messages[0]!.kind, 'document');
          assert.equal(visible.messages[0]!.direction, 'outbound');
          const job = (await repo.claimNext(30000))!;
          assert.ok(job.mediaPayload);
          assert.ok(
            JSON.stringify(cipher.open('outbound-media', job.id, job.mediaPayload!)).includes(
              dataBase64,
            ),
          );
          await repo.beginSend(job);
          await repo.complete(job, 'SENT');
          await assertPurged(job.id);
          assert.equal(
            (await service.enqueue('fixture-envelope-key', request)).status,
            'duplicate',
          );
          assert.equal(
            (
              await service.enqueue('fixture-envelope-key', {
                ...request,
                text: 'Different content',
              })
            ).status,
            'conflict',
          );
          const trigger = candidate();
          const inputId = randomUUID();
          await repo.enqueue(inputId, trigger, 'opaque', 300000, 100, {
            content: cipher.seal('inbox', inputId, {
              text: 'Thanks',
              senderId: chatId,
              senderName: 'Fixture',
              chatName: null,
              kind: 'text',
            }),
            replyEligible: true,
          });
          assert.deepEqual(await inbox.context(trigger), [
            { role: 'assistant', content: '[Document]' },
          ]);
        },
      );

      await t.test(
        'status is origin/account scoped and never reveals arbitrary failure text',
        async () => {
          const repo = new MessageQueueRepository(db.runtime, 'automation-status');
          const f = fixture();
          await enqueue(repo, f);
          assert.equal(
            await new MessageQueueRepository(db.runtime, 'unrelated').automationStatus(f.id),
            null,
          );
          const inboundId = randomUUID();
          await repo.enqueue(inboundId, candidate(), 'opaque', 300000, 100);
          assert.equal(await repo.automationStatus(inboundId), null);
          await db.admin.query(
            `UPDATE public."ramesh-messages" SET reason='sensitive-provider-error' WHERE id=$1`,
            [f.id],
          );
          assert.equal((await repo.automationStatus(f.id))!.reason, null);
          await db.admin.query(
            `UPDATE public."ramesh-messages" SET reason='processing_retry' WHERE id=$1`,
            [f.id],
          );
          assert.equal((await repo.automationStatus(f.id))!.reason, 'processing_retry');
          const before = (
            await db.admin.query(`SELECT updated_at FROM public."ramesh-messages" WHERE id=$1`, [
              f.id,
            ])
          ).rows[0].updated_at;
          await repo.automationStatus(f.id);
          const after = (
            await db.admin.query(`SELECT updated_at FROM public."ramesh-messages" WHERE id=$1`, [
              f.id,
            ])
          ).rows[0].updated_at;
          assert.deepEqual(after, before, 'status reads never mutate or renew work');
        },
      );
    } finally {
      await db.close();
    }
  },
);
