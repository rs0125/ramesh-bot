/** Exact native IDs, SQL ownership/lease fences and audit; no model or WhatsApp transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { proto } from '@whiskeysockets/baileys';
import { PersonalRepository } from '../../src/infrastructure/database/personal.repository.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { PersonalToolService } from '../../src/modules/scheduling/personal-tools.js';
import { renderList } from '../../src/modules/scheduling/personal-presentation.js';
import type { PersonalCommandContext } from '../../src/modules/scheduling/scheduling.types.js';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';

const actor = { employeeId: 23, phoneE164: '+919000000023', chatId: '123456789012345@lid' };
test(
  'native reminder replies update only the exact authorized occurrence and keep durable receipts',
  { skip: !postgresTestsEnabled },
  async (t) => {
    const db = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url'),
      cipher = authCipher(key);
    const fixture = () => {
      const account = randomUUID(),
        repo = new PersonalRepository(db.runtime, account, key);
      return {
        account,
        repo,
        queue: new MessageQueueRepository(db.runtime, account),
        service: new PersonalToolService(repo, async () => actor),
      };
    };
    type Fixture = ReturnType<typeof fixture>;
    const seed = async (
      f: Fixture,
      options: {
        linked?: boolean;
        recurring?: boolean;
        owner?: number;
        phone?: string;
        chat?: string;
        state?: string;
        key?: string;
      } = {},
    ) => {
      const reminder = randomUUID(),
        occurrence = randomUUID(),
        task = options.linked ? randomUUID() : null;
      const owner = options.owner ?? actor.employeeId,
        nativeKey = options.key ?? randomUUID();
      const dueAt = new Date(Date.now() - 60000).toISOString();
      const schedule = {
        dueAt,
        timezone: 'Asia/Kolkata',
        ...(options.recurring ? { recurrence: { frequency: 'daily' } } : {}),
      };
      if (task)
        await db.admin.query(
          `INSERT INTO public."ramesh-tasks"(id,account_id,owner_employee_id,text_encrypted,creation_command_key) VALUES($1,$2,$3,$4,$5)`,
          [
            task,
            f.account,
            owner,
            cipher.seal(`personal-task:${owner}`, task, 'Synthetic linked task'),
            randomUUID(),
          ],
        );
      await db.admin.query(
        `INSERT INTO public."ramesh-reminders"(id,account_id,owner_employee_id,recipient_phone_e164,recipient_chat_id,text_encrypted,task_id,schedule,next_due_at,creation_command_key,state,consumed)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          reminder,
          f.account,
          owner,
          options.phone ?? actor.phoneE164,
          options.chat ?? actor.chatId,
          cipher.seal(`personal-reminder:${owner}`, reminder, 'Synthetic reminder'),
          task,
          schedule,
          options.recurring ? new Date(Date.now() + 86400000).toISOString() : null,
          randomUUID(),
          options.recurring ? 'scheduled' : 'completed',
          !options.recurring,
        ],
      );
      await db.admin.query(
        `INSERT INTO public."ramesh-reminder-occurrences"(id,account_id,reminder_id,schedule_version,slot_key,scheduled_for,eligible_at,not_after,state,next_attempt_at,recipient_employee_id,recipient_phone_e164,recipient_chat_id,finished_at,whatsapp_message_id)
      VALUES($1,$2,$3,1,$4,$4,$4,$5,$6,clock_timestamp(),$7,$8,$9,clock_timestamp(),$10)`,
        [
          occurrence,
          f.account,
          reminder,
          dueAt,
          new Date(Date.now() + 3600000).toISOString(),
          options.state ?? 'sent',
          owner,
          options.phone ?? actor.phoneE164,
          options.chat ?? actor.chatId,
          nativeKey,
        ],
      );
      return { reminder, occurrence, task, nativeKey, schedule };
    };
    const command = async (f: Fixture, text: string, quotedMessageId: string) => {
      const id = randomUUID(),
        receivedAtMs = Date.now();
      const incoming = {
        key: { remoteJid: actor.chatId, id, fromMe: false },
        messageTimestamp: Math.floor(receivedAtMs / 1000),
        message: { extendedTextMessage: { text, contextInfo: { stanzaId: quotedMessageId } } },
      };
      await f.queue.enqueue(
        id,
        {
          chatId: actor.chatId,
          senderId: actor.chatId,
          messageId: id,
          sentAtMs: receivedAtMs,
          fromMe: false,
          isGroup: false,
          mentionsBot: false,
          text,
        },
        cipher.seal('message', id, Buffer.from(proto.WebMessageInfo.encode(incoming).finish())),
        300000,
        100,
      );
      const job = await f.queue.claimInbound(30000);
      assert.ok(job);
      assert.equal(await f.queue.beginAgentRun(job), true);
      const ctx: PersonalCommandContext = {
        ...actor,
        runId: id,
        leaseToken: job.token,
        requestTimeMs: receivedAtMs,
      };
      const run = (await f.service.open(
        {
          runId: id,
          key: incoming.key,
          checkpointLease: { leaseToken: job.token },
          commandMessages: [{ id, text, receivedAtMs, forwarded: false, quotedMessageId }],
        },
        AbortSignal.timeout(5000),
      ))!;
      return { ctx, run, job };
    };
    const end = async (f: Fixture, c: Awaited<ReturnType<typeof command>>) =>
      f.queue.complete(c.job, 'FAILED', 'synthetic_complete');
    const state = async (id: string) =>
      (await db.admin.query(`SELECT * FROM public."ramesh-reminder-occurrences" WHERE id=$1`, [id]))
        .rows[0];
    try {
      await t.test(
        'done acknowledges an older quoted reminder only, retaining its linked task and future recurrence',
        async () => {
          const f = fixture(),
            first = await seed(f, { linked: true, recurring: true }),
            later = await seed(f);
          const c = await command(f, 'done', first.nativeKey);
          const reply = await c.run.quickReply(AbortSignal.timeout(5000));
          assert.match(reply!.text, /Future reminders are unchanged/);
          assert.match(reply!.text, /linked task is unchanged/);
          const acknowledged = (await state(first.occurrence)).acknowledged_at;
          assert.ok(acknowledged);
          assert.equal((await state(later.occurrence)).acknowledged_at, null);
          assert.equal(
            (await state(first.occurrence)).state,
            'sent',
            'acknowledgement does not rewrite delivery history',
          );
          assert.equal(
            (
              await db.admin.query(`SELECT state FROM public."ramesh-tasks" WHERE id=$1`, [
                first.task,
              ])
            ).rows[0].state,
            'open',
          );
          const definition = (
            await db.admin.query(
              `SELECT state,version,schedule,next_due_at FROM public."ramesh-reminders" WHERE id=$1`,
              [first.reminder],
            )
          ).rows[0];
          assert.equal(definition.state, 'scheduled');
          assert.equal(definition.version, 1);
          assert.deepEqual(definition.schedule, first.schedule);
          assert.ok(definition.next_due_at);
          const recovered = (await c.run.recover(AbortSignal.timeout(5000)))!;
          assert.deepEqual(
            { ...recovered, delivery: { ...recovered.delivery, history: reply!.delivery.history } },
            reply,
          );
          assert.equal(recovered.delivery.history!.activity.at(-1)!.phase, 'recovery');
          const listed = await f.repo.list(actor, 'reminder', c.ctx.runId, { state: 'all' });
          assert.ok(
            listed.records.find((record) => record.id === first.reminder)?.occurrenceAcknowledgedAt,
          );
          assert.match(renderList('reminder', listed), /last occurrence sent, marked done/);
          assert.equal(
            (
              await db.admin.query(
                `SELECT count(*)::int AS n FROM public."ramesh-assistant-commands" WHERE account_id=$1 AND kind='mutation'`,
                [f.account],
              )
            ).rows[0].n,
            1,
          );
          const audits = (
            await db.admin.query(
              `SELECT * FROM public."ramesh-write-events" WHERE account_id=$1 AND personal_command_id=$2`,
              [f.account, reply!.delivery.commandId],
            )
          ).rows;
          assert.equal(audits.length, 1);
          await end(f, c);
          const again = await command(f, 'done', first.nativeKey);
          assert.match(
            (await again.run.quickReply(AbortSignal.timeout(5000)))!.text,
            /occurrence done/,
          );
          assert.deepEqual((await state(first.occurrence)).acknowledged_at, acknowledged);
          await end(f, again);
          const snooze = await command(f, 'snooze 30m', first.nativeKey);
          assert.equal(
            (await snooze.run.quickReply(AbortSignal.timeout(5000)))!.delivery.commandId,
            undefined,
          );
          assert.equal(
            (
              await db.admin.query(
                `SELECT count(*)::int AS n FROM public."ramesh-reminder-occurrences" WHERE reminder_id=$1`,
                [first.reminder],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'snooze replaces exactly the quoted slot once, preserving series and quote provenance',
        async () => {
          const f = fixture(),
            first = await seed(f, { recurring: true }),
            later = await seed(f);
          const source = {
            chatId: actor.chatId,
            messageId: 'CREATION-SOURCE',
            kind: 'text',
            text: 'Remind me daily to review this.',
          };
          await db.admin.query(
            `UPDATE public."ramesh-reminders" SET source_quote_encrypted=$2 WHERE id=$1`,
            [first.reminder, cipher.seal('personal-reminder-source:23', first.reminder, source)],
          );
          const c = await command(f, 'snooze 30m', first.nativeKey);
          const reply = await c.run.quickReply(AbortSignal.timeout(5000));
          assert.ok(reply!.delivery.commandId);
          const rows = (
            await db.admin.query(
              `SELECT * FROM public."ramesh-reminder-occurrences" WHERE reminder_id=$1 ORDER BY dispatch_generation`,
              [first.reminder],
            )
          ).rows;
          assert.equal(rows.length, 2);
          assert.equal(rows[1].dispatch_generation, 1);
          assert.equal(rows[1].state, 'pending');
          assert.equal(
            rows[1].eligible_at.toISOString(),
            new Date(c.ctx.requestTimeMs + 1800000).toISOString(),
          );
          assert.equal(rows[1].whatsapp_message_id, null);
          assert.equal((await state(later.occurrence)).state, 'sent');
          const definition = (
            await db.admin.query(
              `SELECT schedule,source_quote_encrypted FROM public."ramesh-reminders" WHERE id=$1`,
              [first.reminder],
            )
          ).rows[0];
          assert.deepEqual(definition.schedule, first.schedule);
          assert.deepEqual(
            cipher.open(
              'personal-reminder-source:23',
              first.reminder,
              definition.source_quote_encrypted,
            ),
            source,
          );
          const recovered = (await c.run.recover(AbortSignal.timeout(5000)))!;
          assert.deepEqual(
            { ...recovered, delivery: { ...recovered.delivery, history: reply!.delivery.history } },
            reply,
          );
          assert.equal(recovered.delivery.history!.activity.at(-1)!.phase, 'recovery');
          await end(f, c);
          for (const text of ['done', 'snooze 30m']) {
            const stale = await command(f, text, first.nativeKey);
            assert.equal(
              (await stale.run.quickReply(AbortSignal.timeout(5000)))!.delivery.commandId,
              undefined,
            );
            await end(f, stale);
          }
          assert.equal(
            (
              await db.admin.query(
                `SELECT count(*)::int AS n FROM public."ramesh-reminder-occurrences" WHERE reminder_id=$1`,
                [first.reminder],
              )
            ).rows[0].n,
            2,
          );
        },
      );
      await t.test(
        'unknown and wrong account, owner, phone, chat or delivery state cannot select another reminder',
        async () => {
          for (const variant of [
            'unknown',
            'account',
            'owner',
            'phone',
            'chat',
            'failed',
            'uncertain',
            'cancelled',
            'version',
            'deleted',
          ] as const) {
            const f = fixture(),
              seedScope = variant === 'account' ? fixture() : f;
            const item = await seed(seedScope, {
              ...(variant === 'owner' ? { owner: 24 } : {}),
              ...(variant === 'phone' ? { phone: '+919000000024' } : {}),
              ...(variant === 'chat' ? { chat: '919000000024@s.whatsapp.net' } : {}),
              ...(['failed', 'uncertain', 'cancelled'].includes(variant) ? { state: variant } : {}),
            });
            await seed(f);
            if (variant === 'version')
              await db.admin.query(`UPDATE public."ramesh-reminders" SET version=2 WHERE id=$1`, [
                item.reminder,
              ]);
            if (variant === 'deleted')
              await db.admin.query(`DELETE FROM public."ramesh-reminder-occurrences" WHERE id=$1`, [
                item.occurrence,
              ]);
            const c = await command(
              f,
              'done',
              variant === 'unknown' ? 'NOT-A-REMINDER' : item.nativeKey,
            );
            const reply = await c.run.quickReply(AbortSignal.timeout(5000));
            assert.equal(reply!.delivery.commandId, undefined, variant);
            assert.equal(
              (
                await db.admin.query(
                  `SELECT count(*)::int AS n FROM public."ramesh-assistant-commands" WHERE account_id=$1 AND kind='mutation'`,
                  [f.account],
                )
              ).rows[0].n,
              0,
              variant,
            );
          }
        },
      );
      await t.test(
        'final transaction rejects a stale exact target and expired inbound lease',
        async () => {
          const f = fixture(),
            item = await seed(f),
            other = await seed(f);
          const c = await command(f, 'done', item.nativeKey);
          await assert.rejects(
            f.repo.applyBatch(c.ctx, [
              {
                kind: 'reminder_acknowledge',
                id: other.reminder,
                occurrenceId: other.occurrence,
                expectedVersion: 1,
                quotedMessageId: item.nativeKey,
              },
            ]),
            /PERSONAL_QUOTED_REMINDER_UNAVAILABLE/,
          );
          await db.admin.query(
            `UPDATE public."ramesh-inbound-queue" SET lease_until=clock_timestamp()-interval '1 second' WHERE message_id=$1`,
            [c.job.id],
          );
          await assert.rejects(
            f.repo.resolveReminderQuote(c.ctx, item.nativeKey),
            /PERSONAL_LEASE_LOST/,
          );
          assert.equal((await state(item.occurrence)).acknowledged_at, null);
        },
      );
    } finally {
      await db.close();
    }
  },
);
