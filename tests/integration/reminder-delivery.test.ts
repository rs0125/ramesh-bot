/** Real SQL fences with synthetic schedules and identity; no models or WhatsApp sends. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { ReminderSourceQuote } from '../../src/contracts/reminder-quote.js';
import {
  MessageQueueRepository,
  type MessageJob,
} from '../../src/infrastructure/database/message-queue.repository.js';
import { PersonalRepository } from '../../src/infrastructure/database/personal.repository.js';
import { PersonalSchedulerService } from '../../src/modules/scheduling/scheduler.service.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { InboxRepository } from '../../src/infrastructure/database/inbox.repository.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { encodeReply } from '../../src/modules/messaging/reply-payload.js';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';

const employee = {
  employeeId: 23,
  phoneE164: '+919000000023',
  email: 'synthetic@example.test',
  active: true,
};
const proof = () => ({ employee, checkedAtMs: Date.now() });

test(
  'reminder queue integration: atomic admission, human priority and final send fences',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async (t) => {
    const db = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url'),
      cipher = authCipher(key);
    const chat = '123456789012345@lid';
    const fixture = async (account: string, task = false) => {
      const reminderId = randomUUID(),
        taskId = task ? randomUUID() : null;
      if (taskId)
        await db.admin.query(
          `INSERT INTO public."ramesh-tasks"
        (id,account_id,owner_employee_id,text_encrypted,creation_command_key) VALUES ($1,$2,23,$3,$4)`,
          [
            taskId,
            account,
            cipher.seal('personal-task:23', taskId, 'Synthetic task'),
            randomUUID(),
          ],
        );
      const dueAt = new Date(Date.now() - 30000).toISOString();
      await db.admin.query(
        `INSERT INTO public."ramesh-reminders"
        (id,account_id,owner_employee_id,recipient_phone_e164,recipient_chat_id,text_encrypted,task_id,schedule,next_due_at,creation_command_key)
        VALUES($1,$2,23,$3,$4,$5,$6,$7,$8,$9)`,
        [
          reminderId,
          account,
          employee.phoneE164,
          chat,
          cipher.seal('personal-reminder:23', reminderId, 'Synthetic private reminder'),
          taskId,
          { dueAt, timezone: 'Asia/Kolkata' },
          dueAt,
          randomUUID(),
        ],
      );
      const queue = new MessageQueueRepository(db.runtime, account);
      const personal = new PersonalRepository(db.runtime, account, key);
      const scheduler = new PersonalSchedulerService(personal, queue, {
        encryptionKey: key,
        capacity: 100,
        resolveEmployee: async () => employee,
      });
      return { queue, personal, scheduler, reminderId, taskId, account };
    };
    const human = async (queue: MessageQueueRepository, eligible = true) => {
      const id = randomUUID();
      await queue.enqueue(
        id,
        {
          chatId: chat,
          senderId: chat,
          messageId: randomUUID(),
          sentAtMs: Date.now(),
          fromMe: false,
          isGroup: false,
          mentionsBot: false,
          text: 'Cancel the synthetic reminder',
        },
        'opaque',
        300000,
        100,
        {
          replyEligible: eligible,
          content: cipher.seal('inbox', id, {
            text: 'Synthetic human turn',
            senderId: chat,
            senderName: 'Test employee',
            chatName: null,
            kind: 'text',
          }),
        },
      );
      return id;
    };
    const finish = async (queue: MessageQueueRepository, job: MessageJob) => {
      assert.equal(
        await queue.beginSend(job, job.origin === 'reminder' ? proof() : undefined),
        true,
      );
      assert.equal(await queue.complete(job, 'SENT'), true);
    };
    try {
      await t.test(
        'durable sender quotes the original command; legacy jobs send unquoted with alarm prefix',
        async () => {
          for (const kind of ['text', 'audio', 'legacy'] as const) {
            const f = await fixture(`reminder-native-quote-${kind}`);
            const source: ReminderSourceQuote | undefined =
              kind === 'legacy'
                ? undefined
                : {
                    chatId: chat,
                    messageId: `ORIGINAL-${kind}`,
                    ...(kind === 'text'
                      ? { kind, text: '  Remind me tomorrow at 9 to review this.\n' }
                      : { kind }),
                  };
            if (source)
              await db.admin.query(
                `UPDATE public."ramesh-reminders" SET source_quote_encrypted=$2 WHERE id=$1`,
                [f.reminderId, cipher.seal('personal-reminder-source:23', f.reminderId, source)],
              );
            await f.scheduler.tick();
            if (kind === 'legacy') {
              const row = (
                await db.admin.query(
                  `SELECT id FROM public."ramesh-messages" WHERE account_id=$1`,
                  [f.account],
                )
              ).rows[0];
              await db.admin.query(
                `UPDATE public."ramesh-outbound-queue" SET payload_encrypted=$2 WHERE message_id=$1`,
                [
                  row.id,
                  cipher.seal(
                    'outbound-reply',
                    row.id,
                    encodeReply('Reminder: Existing queued reminder', true),
                  ),
                ],
              );
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 3000);
            const sends: Array<{
              text: string;
              quoted?: WAMessage;
              chat?: string;
              messageId?: string;
            }> = [];
            let completed: string | undefined;
            const repository = new Proxy(f.queue, {
              get(target, property) {
                if (property === 'complete')
                  return async (...args: Parameters<MessageQueueRepository['complete']>) => {
                    const result = await target.complete(...args);
                    completed = args[1];
                    controller.abort();
                    return result;
                  };
                const member = Reflect.get(target, property);
                return typeof member === 'function' ? member.bind(target) : member;
              },
            });
            const consumer = new DurableMessages(repository, {
              encryptionKey: key,
              accountId: f.account,
              maxAgeMs: 300000,
              capacity: 100,
              leaseMs: 30000,
              pollMs: 5,
              waitBeforeReply: async () => true,
              prepareReply: async () => {
                throw new Error('No graph calls at reminder delivery');
              },
              reminderEmployee: async () => employee,
            });
            try {
              await consumer.consume(
                {
                  botJids: [],
                  on: () => () => {},
                  async close() {},
                  async saveCredentials() {},
                  async reply(quoted, text, options) {
                    sends.push({ quoted, text, messageId: options?.messageId });
                  },
                  async sendText(destination, text, options) {
                    sends.push({ chat: destination, text, messageId: options?.messageId });
                  },
                },
                controller.signal,
                () => {},
              );
            } finally {
              clearTimeout(timer);
            }
            assert.equal(completed, 'SENT');
            assert.equal(sends.length, 1);
            assert.match(sends[0]!.text, /^⏰ /);
            assert.match(sends[0]!.messageId!, /^3EB0[A-F0-9]{36}$/);
            const occurrence = (
              await db.admin.query(
                `SELECT state,whatsapp_message_id FROM public."ramesh-reminder-occurrences" WHERE account_id=$1 AND reminder_id=$2`,
                [f.account, f.reminderId],
              )
            ).rows[0];
            assert.equal(occurrence.state, 'sent');
            assert.equal(occurrence.whatsapp_message_id, sends[0]!.messageId);
            if (source) {
              assert.deepEqual(sends[0]!.quoted?.key, {
                remoteJid: chat,
                id: source.messageId,
                fromMe: false,
              });
              assert.deepEqual(
                sends[0]!.quoted?.message,
                source.kind === 'text'
                  ? { conversation: source.text }
                  : { audioMessage: { ptt: true } },
              );
            } else {
              assert.equal(sends[0]!.quoted, undefined);
              assert.equal(sends[0]!.chat, chat);
              assert.equal(sends[0]!.text, '⏰ Reminder: Existing queued reminder');
            }
          }
        },
      );
      await t.test(
        'due admission commits private job and occurrence together; final state survives cleanup',
        async () => {
          const f = await fixture('reminder-basic');
          await f.scheduler.tick();
          const job = await f.queue.claimOutbound(30000);
          assert.ok(job);
          assert.equal(job.origin, 'reminder');
          assert.equal(job.chatId, chat);
          assert.equal(job.replyKind, 'business');
          assert.equal(job.reminder?.ownerEmployeeId, 23);
          assert.equal(
            (
              await db.admin.query(
                `SELECT state FROM public."ramesh-reminder-occurrences" WHERE outbound_message_id=$1`,
                [job.id],
              )
            ).rows[0].state,
            'queued',
          );
          const inbox = new InboxRepository(db.runtime, f.account, key);
          const page = await inbox.messages(chat);
          assert.equal(page.messages.length, 1);
          assert.equal(page.messages[0]?.source, 'assistant', 'v1 admin source stays compatible');
          assert.equal(page.messages[0]?.text.includes('Synthetic private'), false);
          await finish(f.queue, job);
          assert.equal(
            (
              await db.admin.query(
                `SELECT state FROM public."ramesh-reminder-occurrences" WHERE id=$1`,
                [job.reminder!.occurrenceId],
              )
            ).rows[0].state,
            'sent',
          );
          await db.admin.query(
            `UPDATE public."ramesh-messages" SET finished_at=clock_timestamp()-interval '31 days' WHERE id=$1`,
            [job.id],
          );
          await f.queue.clean();
          await f.personal.clean();
          await f.scheduler.tick();
          assert.equal(
            await f.queue.claimOutbound(30000),
            null,
            'consumed one-off is never recreated',
          );
          assert.equal(
            (
              await db.admin.query(`SELECT state FROM public."ramesh-reminders" WHERE id=$1`, [
                f.reminderId,
              ])
            ).rows[0].state,
            'completed',
          );
        },
      );
      await t.test(
        'human turn bypasses a ready reminder and retains priority through its reply',
        async () => {
          const f = await fixture('reminder-human');
          await f.scheduler.tick();
          const id = await human(f.queue);
          const turn = await f.queue.claimNext(30000);
          assert.equal(turn?.id, id);
          assert.equal(turn?.direction, 'inbound');
          assert.equal(await f.queue.claimOutbound(30000), null);
          await f.queue.handoff(turn!, 'opaque');
          const answer = await f.queue.claimNext(30000);
          assert.equal(answer?.id, id);
          assert.equal(answer?.direction, 'outbound');
          await finish(f.queue, answer!);
          const reminder = await f.queue.claimNext(30000);
          assert.equal(reminder?.origin, 'reminder');
          await finish(f.queue, reminder!);
        },
      );
      await t.test(
        'an admin predecessor does not deadlock a later cancellation behind a reminder',
        async () => {
          const f = await fixture('reminder-admin');
          await human(f.queue, false);
          await f.scheduler.tick();
          const adminId = randomUUID();
          assert.equal(
            await f.queue.enqueueAdmin(adminId, chat, 'opaque', 'opaque', 100, 'a'.repeat(64)),
            'queued',
          );
          const humanId = await human(f.queue);
          const admin = await f.queue.claimNext(30000);
          assert.equal(admin?.id, adminId);
          await finish(f.queue, admin!);
          const turn = await f.queue.claimNext(30000);
          assert.equal(turn?.id, humanId);
          await db.admin.query(
            `UPDATE public."ramesh-reminders" SET state='cancelled',version=version+1 WHERE id=$1`,
            [f.reminderId],
          );
          await f.queue.handoff(turn!, 'opaque');
          await finish(f.queue, (await f.queue.claimNext(30000))!);
          const invalid = await f.queue.claimNext(30000);
          assert.equal(invalid?.origin, 'reminder');
          assert.equal(await f.queue.beginSend(invalid!, proof()), false);
          assert.equal(
            (
              await db.admin.query(`SELECT state FROM public."ramesh-messages" WHERE id=$1`, [
                invalid!.id,
              ])
            ).rows[0].state,
            'EXPIRED',
          );
        },
      );
      await t.test(
        'leased reminder yields without consuming retry budget; final fence also yields',
        async () => {
          const f = await fixture('reminder-leased');
          await f.scheduler.tick();
          const leased = await f.queue.claimOutbound(30000);
          assert.ok(leased);
          const humanId = await human(f.queue);
          assert.equal(await f.queue.beginSend(leased, proof()), false);
          const state = (
            await db.admin.query(
              `SELECT state,attempts FROM public."ramesh-outbound-queue" WHERE message_id=$1`,
              [leased.id],
            )
          ).rows[0];
          assert.deepEqual(state, { state: 'READY', attempts: 0 });
          const turn = await f.queue.claimInbound(30000);
          assert.equal(turn?.id, humanId);
          await f.queue.handoff(turn!, 'opaque');
          await finish(f.queue, (await f.queue.claimOutbound(30000))!);
          await finish(f.queue, (await f.queue.claimOutbound(30000))!);
        },
      );
      await t.test(
        'owner proof, original deadline and linked task state are checked at SENDING',
        async () => {
          const f = await fixture('reminder-fences', true);
          await f.scheduler.tick();
          const job = await f.queue.claimOutbound(30000);
          assert.ok(job);
          assert.equal(
            await f.queue.beginSend({ ...job, origin: 'whatsapp' }),
            false,
            'cannot bypass by relabeling origin',
          );
          assert.equal(
            await f.queue.beginSend(job, {
              employee: { ...employee, phoneE164: '+919000000099' },
              checkedAtMs: Date.now(),
            }),
            false,
          );
          assert.equal(
            await f.queue.beginSend(job, { employee, checkedAtMs: Date.now() - 11000 }),
            false,
          );
          await db.admin.query(`UPDATE public."ramesh-tasks" SET state='done' WHERE id=$1`, [
            f.taskId,
          ]);
          assert.equal(await f.queue.beginSend(job, proof()), false);
          const expired = await fixture('reminder-expired');
          await expired.scheduler.tick();
          const waiting = await expired.queue.claimOutbound(30000);
          assert.ok(waiting);
          await db.admin.query(
            `UPDATE public."ramesh-reminder-occurrences" SET eligible_at=clock_timestamp()-interval '2 hours',not_after=clock_timestamp()-interval '1 second' WHERE id=$1`,
            [waiting.reminder!.occurrenceId],
          );
          assert.equal(await expired.queue.beginSend(waiting, proof()), false);
        },
      );
      await t.test(
        'a send that crossed SENDING remains uncertain after interruption, never recreated',
        async () => {
          const f = await fixture('reminder-uncertain');
          await f.scheduler.tick();
          const job = await f.queue.claimOutbound(30000);
          assert.ok(job);
          assert.equal(await f.queue.beginSend(job, proof()), true);
          await db.admin.query(
            `UPDATE public."ramesh-reminders" SET state='cancelled',version=version+1 WHERE id=$1`,
            [f.reminderId],
          );
          assert.equal(await f.queue.complete(job, 'UNCERTAIN', 'send_interrupted'), true);
          await f.scheduler.tick();
          assert.equal(await f.queue.claimOutbound(30000), null);
          assert.equal(
            (
              await db.admin.query(
                `SELECT state FROM public."ramesh-reminder-occurrences" WHERE id=$1`,
                [job.reminder!.occurrenceId],
              )
            ).rows[0].state,
            'uncertain',
          );
        },
      );
    } finally {
      await db.close();
    }
  },
);
