/** Real local SQL and encrypted transport provenance; synthetic data, no models or WhatsApp. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { PersonalRepository } from '../../src/infrastructure/database/personal.repository.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { toInboxCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import type { PersonalOperation } from '../../src/modules/scheduling/scheduling.types.js';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';

const actor = { employeeId: 23, phoneE164: '+919000000023', chatId: '123456789012345@lid' };
const future = () => ({
  dueAt: new Date(Date.now() + 86400000).toISOString(),
  timezone: 'Asia/Kolkata' as const,
});
const original = (
  message: WAMessage['message'] = { conversation: 'Remind me tomorrow to call the owner.' },
): WAMessage => ({
  key: { remoteJid: actor.chatId, id: randomUUID(), fromMe: false },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message,
});

test(
  'reminder quote provenance is durable, private and limited to the current direct command',
  { skip: !postgresTestsEnabled },
  async (t) => {
    const db = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url'),
      cipher = authCipher(key);
    const fixture = () => {
      const account = randomUUID();
      return {
        account,
        repo: new PersonalRepository(db.runtime, account, key),
        queue: new MessageQueueRepository(db.runtime, account),
      };
    };
    type Fixture = ReturnType<typeof fixture>;
    const enqueue = async (f: Fixture, message: WAMessage) => {
      const id = randomUUID();
      const candidate = toInboxCandidate(message, []);
      assert.ok(candidate);
      assert.equal(
        await f.queue.enqueue(
          id,
          candidate,
          cipher.seal('message', id, Buffer.from(proto.WebMessageInfo.encode(message).finish())),
          300000,
          100,
        ),
        'queued',
      );
      return id;
    };
    const command = async (f: Fixture, messages = [original()]) => {
      const ids: string[] = [];
      for (const message of messages) ids.push(await enqueue(f, message));
      if (ids.length > 1)
        await db.admin.query(
          `UPDATE public."ramesh-inbound-queue" SET batch_parent=$1 WHERE message_id=ANY($2::uuid[])`,
          [ids[0], ids.slice(1)],
        );
      const job = await f.queue.claimInbound(30000);
      assert.ok(job);
      assert.equal(job.id, ids[0]);
      assert.equal(await f.queue.beginAgentRun(job), true);
      return {
        ids,
        job,
        ctx: { ...actor, runId: job.id, leaseToken: job.token, requestTimeMs: Date.now() },
      };
    };
    const save = async (
      f: Fixture,
      c: Awaited<ReturnType<typeof command>>,
      sourceMessageId?: string,
    ) => {
      const receipt = await f.repo.applyBatch(c.ctx, [
        {
          kind: 'reminder_create',
          text: 'call the owner',
          schedule: future(),
          ...(sourceMessageId ? { sourceMessageId } : {}),
        },
      ]);
      await f.queue.complete(c.job, 'FAILED', 'synthetic_command_finished');
      return receipt.records[0]!;
    };
    const forceDue = async (id: string, recurring = false) => {
      const dueAt = new Date(Date.now() - 30000).toISOString();
      await db.admin.query(
        `UPDATE public."ramesh-reminders" SET next_due_at=$2,schedule=$3 WHERE id=$1`,
        [
          id,
          dueAt,
          {
            dueAt,
            timezone: 'Asia/Kolkata',
            ...(recurring ? { recurrence: { frequency: 'daily' } } : {}),
          },
        ],
      );
    };
    const snapshot = async (id: string) => {
      const row = (
        await db.admin.query(
          `SELECT source_quote_encrypted FROM public."ramesh-reminders" WHERE id=$1`,
          [id],
        )
      ).rows[0];
      return row.source_quote_encrypted
        ? cipher.open('personal-reminder-source:23', id, row.source_quote_encrypted)
        : null;
    };
    try {
      await t.test(
        'exact text survives original message cleanup and recurrence and snooze keep the creation quote',
        async () => {
          const f = fixture(),
            text = '  Remind me tomorrow to call the owner.\n';
          const wire = original({
            extendedTextMessage: {
              text,
              contextInfo: { quotedMessage: { conversation: 'Unrelated nested private message' } },
            },
          });
          const c = await command(f, [wire]);
          const record = await save(f, c, c.ids[0]);
          const expected = { chatId: actor.chatId, messageId: wire.key.id, kind: 'text', text };
          assert.deepEqual(await snapshot(record.id), expected);
          await db.admin.query(`DELETE FROM public."ramesh-messages" WHERE id=$1`, [c.job.id]);
          await forceDue(record.id, true);
          const due = await f.repo.claimDue(30000);
          assert.ok(due);
          assert.deepEqual(due.sourceQuote, expected);
          const later = await command(f);
          const op: PersonalOperation = {
            kind: 'reminder_snooze',
            id: record.id,
            expectedVersion: record.version,
            occurrenceId: due.id,
            dueAt: future().dueAt,
          };
          const snoozed = await f.repo.applyBatch(later.ctx, [op]);
          await f.queue.complete(later.job, 'FAILED', 'synthetic_command_finished');
          assert.deepEqual(await snapshot(record.id), expected);
          assert.equal(snoozed.records[0]!.schedule?.recurrence?.frequency, 'daily');
          await db.admin.query(
            `UPDATE public."ramesh-reminder-occurrences" SET eligible_at=clock_timestamp()-interval '1 second',not_after=clock_timestamp()+interval '1 hour',next_attempt_at=clock_timestamp() WHERE id=$1`,
            [snoozed.records[0]!.occurrenceId],
          );
          assert.deepEqual((await f.repo.claimPrepared(30000))?.sourceQuote, expected);
        },
      );
      await t.test(
        'a debounced audio command retains only its original key, without media, transcript or nested quote',
        async () => {
          const f = fixture();
          const wire = original({
            audioMessage: {
              ptt: true,
              url: 'https://example.invalid/private-audio',
              mediaKey: Buffer.from('private-key'),
              mimetype: 'audio/ogg',
              contextInfo: { quotedMessage: { conversation: 'Do not retain this nested content' } },
            },
          });
          const c = await command(f, [original(), wire]);
          const record = await save(f, c, c.ids[1]);
          const expected = { chatId: actor.chatId, messageId: wire.key.id, kind: 'audio' };
          assert.deepEqual(await snapshot(record.id), expected);
          await forceDue(record.id);
          assert.deepEqual((await f.repo.claimDue(30000))?.sourceQuote, expected);
        },
      );
      await t.test(
        'older unrelated, cross-chat, forged-key and forwarded sources cannot create a quoted reminder',
        async () => {
          for (const variant of ['unrelated', 'cross-chat', 'forged-key', 'forwarded'] as const) {
            const f = fixture();
            let source: string | undefined;
            if (variant === 'unrelated') {
              const old = await command(f);
              source = old.ids[0];
              await f.queue.complete(old.job, 'FAILED', 'old_finished');
            }
            const wire =
              variant === 'forwarded'
                ? original({
                    extendedTextMessage: {
                      text: 'Remind me tomorrow to call the owner',
                      contextInfo: { isForwarded: true },
                    },
                  })
                : original();
            const c = await command(f, [wire]);
            source ??= c.ids[0]!;
            if (variant === 'cross-chat')
              await db.admin.query(
                `UPDATE public."ramesh-messages" SET chat_id='919000000024@s.whatsapp.net' WHERE id=$1`,
                [source],
              );
            if (variant === 'forged-key')
              await db.admin.query(
                `UPDATE public."ramesh-messages" SET whatsapp_message_id='UNRELATED-KEY' WHERE id=$1`,
                [source],
              );
            await assert.rejects(
              f.repo.applyBatch(c.ctx, [
                {
                  kind: 'reminder_create',
                  text: 'call the owner',
                  schedule: future(),
                  sourceMessageId: source,
                },
              ]),
              (error: unknown) =>
                !!error &&
                typeof error === 'object' &&
                'code' in error &&
                ['PERSONAL_SOURCE_INVALID', 'PERSONAL_LEASE_LOST'].includes(String(error.code)),
            );
            assert.equal(
              (
                await db.admin.query(
                  `SELECT count(*)::int AS n FROM public."ramesh-reminders" WHERE account_id=$1`,
                  [f.account],
                )
              ).rows[0].n,
              0,
            );
          }
        },
      );
      await t.test(
        'legacy, corrupt, malformed and destination-mismatched snapshots safely deliver without a quote',
        async () => {
          for (const variant of ['legacy', 'cipher', 'malformed', 'destination'] as const) {
            const f = fixture(),
              c = await command(f);
            const record = await save(f, c, variant === 'legacy' ? undefined : c.ids[0]);
            if (variant !== 'legacy') {
              const value =
                variant === 'cipher'
                  ? 'not-a-valid-ciphertext'
                  : cipher.seal(
                      'personal-reminder-source:23',
                      record.id,
                      variant === 'malformed'
                        ? {
                            chatId: actor.chatId,
                            messageId: 'SOURCE',
                            kind: 'audio',
                            text: 'Injected transcript',
                          }
                        : {
                            chatId: '919000000024@s.whatsapp.net',
                            messageId: 'SOURCE',
                            kind: 'text',
                            text: 'Other chat',
                          },
                    );
              await db.admin.query(
                `UPDATE public."ramesh-reminders" SET source_quote_encrypted=$2 WHERE id=$1`,
                [record.id, value],
              );
            }
            await forceDue(record.id);
            const due = await f.repo.claimDue(30000);
            assert.ok(due);
            assert.equal(due.text, 'call the owner');
            assert.equal(due.sourceQuote, undefined);
          }
        },
      );
      await t.test(
        'image, video and document quotes retain exact captions and type without media or nested private content',
        async () => {
          for (const kind of ['image', 'video', 'document'] as const) {
            for (const caption of ['  Remind me tomorrow to call the owner.\n', undefined]) {
              const f = fixture();
              const media = {
                ...(caption ? { caption } : {}),
                url: 'https://example.invalid/private-media',
                mediaKey: Buffer.from('private-key'),
                jpegThumbnail: Buffer.from('private-thumbnail'),
                contextInfo: {
                  quotedMessage: { conversation: 'Unrelated nested private message' },
                },
              };
              const wire = original(
                kind === 'image'
                  ? { imageMessage: media }
                  : kind === 'video'
                    ? { videoMessage: media }
                    : { documentMessage: media },
              );
              const c = await command(f, [wire]);
              const record = await save(f, c, c.ids[0]);
              const expected = {
                chatId: actor.chatId,
                messageId: wire.key.id,
                kind,
                ...(caption ? { text: caption } : {}),
              };
              assert.deepEqual(await snapshot(record.id), expected);
              await forceDue(record.id);
              assert.deepEqual((await f.repo.claimDue(30000))?.sourceQuote, expected);
            }
          }
        },
      );
    } finally {
      await db.close();
    }
  },
);
