/** Synthetic PostgreSQL outcomes only: no model, external service, or WhatsApp session. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PersonalRepository } from '../../src/infrastructure/database/personal.repository.js';
import {
  MessageQueueRepository,
  type MessageJob,
} from '../../src/infrastructure/database/message-queue.repository.js';
import { reminderMessageId } from '../../src/modules/scheduling/scheduler.service.js';
import type {
  DueReminder,
  PersonalActor,
  PersonalCommandContext,
  PersonalOperation,
  ReminderDeliveryRef,
} from '../../src/modules/scheduling/scheduling.types.js';
import { temporaryMessageDatabase, postgresTestsEnabled } from '../fixtures/message-database.js';

const actor: PersonalActor = {
  employeeId: 23,
  phoneE164: '+919000000023',
  chatId: '919000000023@s.whatsapp.net',
};
const future = () => ({
  dueAt: new Date(Date.now() + 86400000 * 45).toISOString(),
  timezone: 'Asia/Kolkata' as const,
});
const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === expected;

test(
  'personal intent and delivery persist safely through retries, edits and cleanup',
  { skip: !postgresTestsEnabled },
  async (t) => {
    const db = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url');
    function fixture() {
      const account = randomUUID();
      return {
        account,
        repo: new PersonalRepository(db.runtime, account, key),
        queue: new MessageQueueRepository(db.runtime, account),
      };
    }
    async function command(
      f: ReturnType<typeof fixture>,
      who = actor,
      beforeClaim?: () => Promise<void>,
    ) {
      const id = randomUUID();
      assert.equal(
        await f.queue.enqueue(
          id,
          {
            chatId: who.chatId,
            messageId: id,
            sentAtMs: Date.now(),
            fromMe: false,
            isGroup: false,
            mentionsBot: false,
          },
          'synthetic-encrypted-input',
          300000,
          100,
        ),
        'queued',
      );
      await beforeClaim?.();
      const job = await f.queue.claimInbound(30000);
      assert.ok(job);
      assert.equal(job.id, id);
      assert.equal(await f.queue.beginAgentRun(job), true);
      const ctx: PersonalCommandContext = {
        ...who,
        runId: id,
        leaseToken: job.token,
        requestTimeMs: Date.now(),
      };
      return { job, ctx };
    }
    async function apply(f: ReturnType<typeof fixture>, ops: PersonalOperation[], who = actor) {
      const c = await command(f, who);
      const receipt = await f.repo.applyBatch(c.ctx, ops);
      assert.equal(await f.queue.complete(c.job, 'FAILED', 'synthetic_turn_finished'), true);
      return receipt;
    }
    async function dueNow(id: string, seconds = 60, recurring = false) {
      const at = new Date(Date.now() - seconds * 1000).toISOString();
      await db.admin.query(
        `UPDATE public."ramesh-reminders" SET next_due_at=$2,schedule=$3 WHERE id=$1`,
        [
          id,
          at,
          {
            dueAt: at,
            timezone: 'Asia/Kolkata',
            ...(recurring ? { recurrence: { frequency: 'daily' } } : {}),
          },
        ],
      );
    }
    async function queued(f: ReturnType<typeof fixture>, due: DueReminder) {
      let ref!: ReminderDeliveryRef;
      let id = '';
      const result = await f.repo.enqueueDue(due, actor, async (client, r) => {
        ref = r;
        id = reminderMessageId(f.account, r);
        return f.queue.enqueueReminder(
          client,
          id,
          actor.chatId,
          'encrypted-inbox',
          'encrypted-reply',
          'encrypted-proof',
          100,
          r,
        );
      });
      assert.equal(result, 'queued');
      return { id, ref };
    }
    async function delivered(f: ReturnType<typeof fixture>, job: MessageJob) {
      assert.equal(
        await f.queue.handoff(job, 'synthetic-list', new Date(), 'encrypted-personal-proof'),
        true,
      );
      const outbound = await f.queue.claimOutbound(30000);
      assert.ok(outbound);
      assert.equal(outbound.id, job.id);
      assert.equal(await f.queue.beginSend(outbound), true);
      assert.equal(await f.queue.complete(outbound, 'SENT'), true);
    }
    try {
      await t.test(
        'atomic linked intent, encrypted receipt replay, argument conflict and lost lease',
        async () => {
          const f = fixture();
          const c = await command(f);
          const ops: PersonalOperation[] = [
            { kind: 'task_create', text: 'Synthetic task: check dispatch', alias: 'dispatch' },
            {
              kind: 'reminder_create',
              text: 'Check synthetic dispatch',
              taskRef: 'dispatch',
              schedule: future(),
            },
          ];
          const saved = await f.repo.applyBatch(c.ctx, ops);
          assert.equal(saved.records.length, 2);
          assert.equal(saved.records[1]!.taskId, saved.records[0]!.id);
          const replay = await f.repo.applyBatch(c.ctx, ops);
          assert.equal(replay.commandId, saved.commandId);
          assert.equal(replay.replayed, true);
          assert.equal((await f.repo.getReceipt(c.ctx))?.commandId, saved.commandId);
          await assert.rejects(
            f.repo.applyBatch(c.ctx, [{ kind: 'task_create', text: 'Different intent' }]),
            code('PERSONAL_COMMAND_CONFLICT'),
          );
          const storage = (
            await db.admin.query(
              `SELECT payload_encrypted,result_encrypted FROM public."ramesh-assistant-commands" WHERE account_id=$1`,
              [f.account],
            )
          ).rows;
          assert.equal(storage.length, 1);
          assert.ok(!JSON.stringify(storage).includes('Synthetic task'));
          await db.admin.query(
            `UPDATE public."ramesh-inbound-queue" SET lease_until=clock_timestamp()-interval '1 second' WHERE message_id=$1`,
            [c.job.id],
          );
          await assert.rejects(f.repo.applyBatch(c.ctx, ops), code('PERSONAL_LEASE_LOST'));
          assert.equal(
            (
              await db.admin.query(
                `SELECT count(*)::int n FROM public."ramesh-tasks" WHERE account_id=$1`,
                [f.account],
              )
            ).rows[0].n,
            1,
          );
          const other = fixture(),
            c2 = await command(other);
          await assert.rejects(
            other.repo.applyBatch(c2.ctx, [
              { kind: 'task_create', text: 'Must roll back' },
              {
                kind: 'reminder_create',
                text: 'Invalid linked row',
                taskRef: randomUUID(),
                schedule: future(),
              },
            ]),
            code('PERSONAL_NOT_FOUND'),
          );
          assert.equal(
            (
              await db.admin.query(
                `SELECT count(*)::int n FROM public."ramesh-tasks" WHERE account_id=$1`,
                [other.account],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(await other.repo.getReceipt(c2.ctx), null);
        },
      );
      await t.test(
        'owner scope, optimistic version and cancellation receipts return the committed state',
        async () => {
          const f = fixture();
          const created = await apply(f, [
            { kind: 'task_create', text: 'Synthetic private task' },
            { kind: 'reminder_create', text: 'Synthetic private reminder', schedule: future() },
          ]);
          const task = created.records[0]!,
            reminder = created.records[1]!;
          const stranger = {
            employeeId: 24,
            phoneE164: '+919000000024',
            chatId: '919000000024@s.whatsapp.net',
          };
          const wrong = await command(f, stranger);
          await assert.rejects(
            f.repo.applyBatch(wrong.ctx, [
              { kind: 'task_complete', id: task.id, expectedVersion: 1 },
            ]),
            code('PERSONAL_NOT_FOUND'),
          );
          await f.queue.complete(wrong.job, 'FAILED');
          assert.deepEqual((await f.repo.list(stranger, 'task', randomUUID())).records, []);
          await apply(f, [
            {
              kind: 'task_update',
              id: task.id,
              expectedVersion: 1,
              text: 'Changed synthetic task',
            },
          ]);
          const stale = await command(f);
          await assert.rejects(
            f.repo.applyBatch(stale.ctx, [
              { kind: 'task_complete', id: task.id, expectedVersion: 1 },
            ]),
            code('PERSONAL_VERSION_CONFLICT'),
          );
          await f.queue.complete(stale.job, 'FAILED');
          const cancelled = await apply(f, [
            { kind: 'reminder_cancel', id: reminder.id, expectedVersion: 1 },
          ]);
          assert.equal(cancelled.records[0]!.state, 'cancelled');
          assert.equal(cancelled.records[0]!.version, 2);
          assert.equal(cancelled.records[0]!.nextDueAt, null);
          assert.equal(cancelled.records[0]!.alreadySending, false);
        },
      );
      await t.test(
        'only presented sent lists resolve ordinals; unsent and undisplayed newer lists cannot replace them',
        async () => {
          const f = fixture();
          const initial = await apply(f, [
            { kind: 'task_create', text: 'First synthetic task' },
            { kind: 'task_create', text: 'Second synthetic task' },
          ]);
          const c = await command(f);
          const list = await f.repo.list(actor, 'task', c.ctx.runId);
          const hidden = await f.repo.list(actor, 'task', c.ctx.runId, { limit: 1 });
          await f.repo.finalizeSelections(c.ctx, [list.selectionId]);
          await delivered(f, c.job);
          assert.deepEqual(await f.repo.resolveSelection(actor, 'task', 'latest', 2), {
            id: initial.records[1]!.id,
            expectedVersion: 1,
          });
          await assert.rejects(
            f.repo.resolveSelection(actor, 'task', hidden.selectionId, 1),
            code('PERSONAL_SELECTION_NOT_FOUND'),
          );
          await apply(f, [{ kind: 'task_create', text: 'New third task' }]);
          const later = await command(f);
          const newer = await f.repo.list(actor, 'task', later.ctx.runId, { limit: 1 });
          await f.repo.finalizeSelections(later.ctx, [newer.selectionId]);
          assert.equal(
            (await f.repo.resolveSelection(actor, 'task', 'latest', 2)).id,
            initial.records[1]!.id,
          );
          // A sent generic authorization notice did not present the private list.
          await f.queue.handoff(later.job, 'authorization notice');
          const notice = await f.queue.claimOutbound(30000);
          assert.ok(notice);
          await f.queue.beginSend(notice);
          await f.queue.complete(notice, 'SENT');
          assert.equal(
            (await f.repo.resolveSelection(actor, 'task', 'latest', 2)).id,
            initial.records[1]!.id,
          );
          const uncertain = await command(f);
          const uncertainList = await f.repo.list(actor, 'task', uncertain.ctx.runId);
          await f.repo.finalizeSelections(uncertain.ctx, [uncertainList.selectionId]);
          await f.queue.handoff(
            uncertain.job,
            'synthetic-list',
            new Date(),
            'encrypted-personal-proof',
          );
          const uncertainOut = await f.queue.claimOutbound(30000);
          assert.ok(uncertainOut);
          await f.queue.complete(uncertainOut, 'UNCERTAIN');
          await assert.rejects(
            f.repo.resolveSelection(actor, 'task', 'latest', 1),
            code('PERSONAL_SELECTION_UNCERTAIN'),
          );
          await apply(f, [
            {
              kind: 'task_update',
              id: initial.records[1]!.id,
              expectedVersion: 1,
              text: 'Updated second',
            },
          ]);
          await assert.rejects(
            f.repo.resolveSelection(actor, 'task', list.selectionId, 2),
            code('PERSONAL_VERSION_CONFLICT'),
          );
        },
      );
      await t.test(
        'long horizon intent persists without a delivery job or dependency on source message retention',
        async () => {
          const f = fixture();
          const result = await apply(f, [
            { kind: 'reminder_create', text: 'Review next quarter', schedule: future() },
          ]);
          await db.admin.query(`DELETE FROM public."ramesh-messages" WHERE account_id=$1`, [
            f.account,
          ]);
          await f.repo.clean();
          assert.equal(await f.repo.claimDue(30000), null);
          assert.equal(
            (await f.repo.list(actor, 'reminder', randomUUID())).records[0]!.id,
            result.records[0]!.id,
          );
          assert.equal(
            (
              await db.admin.query(
                `SELECT count(*)::int n FROM public."ramesh-reminder-occurrences" WHERE account_id=$1`,
                [f.account],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await db.admin.query(
                `SELECT count(*)::int n FROM public."ramesh-outbound-queue" WHERE account_id=$1`,
                [f.account],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'two schedulers claim once; expired leases cannot renew or enqueue; failed admission is atomic',
        async () => {
          const f = fixture();
          const r = (
            await apply(f, [
              { kind: 'reminder_create', text: 'Synthetic due item', schedule: future() },
            ])
          ).records[0]!;
          await dueNow(r.id);
          const other = new PersonalRepository(db.runtime, f.account, key);
          const claims = await Promise.all([f.repo.claimDue(30000), other.claimDue(30000)]);
          assert.equal(claims.filter(Boolean).length, 1);
          const old = claims.find(Boolean)!;
          await db.admin.query(
            `UPDATE public."ramesh-reminder-occurrences" SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
            [old.id],
          );
          const fresh = await other.claimDue(30000);
          assert.ok(fresh);
          assert.equal(fresh.id, old.id);
          assert.notEqual(fresh.leaseToken, old.leaseToken);
          assert.equal(await f.repo.renewDue(old, 30000), false);
          let called = false;
          assert.equal(
            await f.repo.enqueueDue(old, actor, async () => {
              called = true;
              return randomUUID();
            }),
            'stale',
          );
          assert.equal(called, false);
          await assert.rejects(
            f.repo.enqueueDue(fresh, actor, async (client, ref) => {
              await f.queue.enqueueReminder(
                client,
                reminderMessageId(f.account, ref),
                actor.chatId,
                'opaque',
                'opaque',
                'opaque',
                100,
                ref,
              );
              throw new Error('synthetic callback failure');
            }),
            /synthetic callback failure/,
          );
          assert.equal(
            (
              await db.admin.query(
                `SELECT count(*)::int n FROM public."ramesh-messages" WHERE account_id=$1 AND origin='reminder'`,
                [f.account],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(await f.repo.enqueueDue(fresh, actor, async () => 'full'), 'full');
          const deferred = (
            await db.admin.query(`SELECT * FROM public."ramesh-reminder-occurrences" WHERE id=$1`, [
              fresh.id,
            ])
          ).rows[0];
          assert.equal(deferred.state, 'pending');
          assert.equal(deferred.lease_token, null);
          assert.equal(deferred.not_after.toISOString(), fresh.notAfter);
          await db.admin.query(
            `UPDATE public."ramesh-reminder-occurrences" SET next_attempt_at=clock_timestamp() WHERE id=$1`,
            [fresh.id],
          );
          const again = await f.repo.claimDue(30000);
          assert.ok(again);
          const out = await queued(f, again);
          assert.equal(await f.repo.canDeliver(out.ref, actor), true);
          assert.equal(
            await f.repo.canDeliver(out.ref, { ...actor, phoneE164: '+919000000099' }),
            false,
          );
        },
      );
      await t.test(
        'completing the linked task cancels a leased unsent reminder and fences its old sender',
        async () => {
          const f = fixture();
          const result = await apply(f, [
            { kind: 'task_create', text: 'Finish synthetic work', alias: 'work' },
            {
              kind: 'reminder_create',
              text: 'Synthetic work reminder',
              taskRef: 'work',
              schedule: future(),
            },
          ]);
          await dueNow(result.records[1]!.id);
          const due = await f.repo.claimDue(30000);
          assert.ok(due);
          const out = await queued(f, due);
          const leased = await f.queue.claimOutbound(30000);
          assert.ok(leased);
          const c = await command(f, actor, async () => {
            assert.equal(await f.queue.yieldReminderToHuman(leased), true);
          });
          const complete = await f.repo.applyBatch(c.ctx, [
            { kind: 'task_complete', id: result.records[0]!.id, expectedVersion: 1 },
          ]);
          await f.queue.complete(c.job, 'FAILED');
          assert.equal(complete.records[0]!.affectedReminders, 1);
          assert.equal(complete.records[0]!.alreadySending, false);
          assert.equal(await f.repo.canDeliver(out.ref, actor), false);
          assert.equal(await f.queue.beginSend(leased), false);
          assert.equal(
            (
              await db.admin.query(`SELECT state FROM public."ramesh-messages" WHERE id=$1`, [
                out.id,
              ])
            ).rows[0].state,
            'EXPIRED',
          );
        },
      );
      await t.test(
        'snooze replaces exactly one dispatch generation and rejects repeated selection of its old source',
        async () => {
          const f = fixture();
          const r = (
            await apply(f, [
              { kind: 'reminder_create', text: 'Snooze synthetic item', schedule: future() },
            ])
          ).records[0]!;
          await dueNow(r.id);
          const due = await f.repo.claimDue(30000);
          assert.ok(due);
          const old = await queued(f, due);
          // Simulate a terminal sender outcome, never a transport call.
          await db.admin.query(
            `UPDATE public."ramesh-messages" SET state='SENT',finished_at=clock_timestamp() WHERE id=$1`,
            [old.id],
          );
          await db.admin.query(
            `UPDATE public."ramesh-outbound-queue" SET state='DONE',payload_encrypted=NULL WHERE message_id=$1`,
            [old.id],
          );
          const c = await command(f);
          const ops: PersonalOperation[] = [
            {
              kind: 'reminder_snooze',
              id: r.id,
              expectedVersion: 1,
              occurrenceId: due.id,
              dueAt: new Date(Date.now() + 3600000).toISOString(),
            },
          ];
          const saved = await f.repo.applyBatch(c.ctx, ops);
          assert.equal(saved.records[0]!.version, 1);
          assert.notEqual(saved.records[0]!.occurrenceId, due.id);
          assert.equal((await f.repo.applyBatch(c.ctx, ops)).commandId, saved.commandId);
          await f.queue.complete(c.job, 'FAILED');
          const another = await command(f);
          await assert.rejects(
            f.repo.applyBatch(another.ctx, ops),
            code('PERSONAL_OCCURRENCE_CONFLICT'),
          );
          await f.queue.complete(another.job, 'FAILED');
          const occurrences = (
            await db.admin.query(
              `SELECT dispatch_generation,state FROM public."ramesh-reminder-occurrences" WHERE reminder_id=$1 ORDER BY dispatch_generation`,
              [r.id],
            )
          ).rows;
          assert.deepEqual(occurrences, [
            { dispatch_generation: 0, state: 'sent' },
            { dispatch_generation: 1, state: 'pending' },
          ]);
        },
      );
      await t.test(
        'explicit rescheduling rebinds a changed verified phone and retains the trusted LID chat',
        async () => {
          const f = fixture();
          const r = (
            await apply(f, [
              { kind: 'reminder_create', text: 'Move synthetic appointment', schedule: future() },
            ])
          ).records[0]!;
          const changed = { ...actor, phoneE164: '+919000000099', chatId: '123456789012345@lid' };
          await apply(
            f,
            [{ kind: 'reminder_reschedule', id: r.id, expectedVersion: 1, schedule: future() }],
            changed,
          );
          await dueNow(r.id);
          const due = await f.repo.claimDue(30000);
          assert.ok(due);
          assert.equal(due.phoneE164, changed.phoneE164);
          assert.equal(due.chatId, changed.chatId);
          let callback = false;
          assert.equal(
            await f.repo.enqueueDue(due, actor, async () => {
              callback = true;
              return randomUUID();
            }),
            'stale',
          );
          assert.equal(callback, false);
          const row = (
            await db.admin.query(
              `SELECT state,lease_token FROM public."ramesh-reminder-occurrences" WHERE id=$1`,
              [due.id],
            )
          ).rows[0];
          assert.equal(row.state, 'suppressed');
          assert.equal(row.lease_token, null);
        },
      );
      await t.test(
        'poison schedule and ciphertext rows cannot starve a valid due reminder',
        async () => {
          const f = fixture();
          const result = await apply(f, [
            { kind: 'reminder_create', text: 'Bad schedule', schedule: future() },
            { kind: 'reminder_create', text: 'Bad content', schedule: future() },
            { kind: 'reminder_create', text: 'Valid content', schedule: future() },
          ]);
          for (const r of result.records) await dueNow(r.id);
          await db.admin.query(`UPDATE public."ramesh-reminders" SET schedule='{}' WHERE id=$1`, [
            result.records[0]!.id,
          ]);
          await db.admin.query(
            `UPDATE public."ramesh-reminders" SET text_encrypted='corrupt' WHERE id=$1`,
            [result.records[1]!.id],
          );
          const due = await f.repo.claimDue(30000);
          assert.ok(due);
          assert.equal(due.reminderId, result.records[2]!.id);
          assert.equal(due.text, 'Valid content');
          assert.equal(
            (
              await db.admin.query(
                `SELECT last_outcome FROM public."ramesh-reminders" WHERE id=$1`,
                [result.records[0]!.id],
              )
            ).rows[0].last_outcome,
            'invalid_schedule',
          );
          assert.equal(
            (
              await db.admin.query(
                `SELECT reason_code FROM public."ramesh-reminder-occurrences" WHERE reminder_id=$1`,
                [result.records[1]!.id],
              )
            ).rows[0].reason_code,
            'invalid_content',
          );
        },
      );
      await t.test(
        'consumed one-off intent never resurrects after occurrence cleanup; recurring cursor skips old slots',
        async () => {
          const f = fixture();
          const r = (
            await apply(f, [
              { kind: 'reminder_create', text: 'One-off synthetic item', schedule: future() },
            ])
          ).records[0]!;
          await dueNow(r.id);
          const due = await f.repo.claimDue(30000);
          assert.ok(due);
          const out = await queued(f, due);
          const outbound = await f.queue.claimOutbound(30000);
          assert.ok(outbound);
          assert.equal(outbound.id, out.id);
          await f.queue.complete(outbound, 'FAILED', 'x'.repeat(64));
          const occurrence = (
            await db.admin.query(
              `SELECT state,reason_code FROM public."ramesh-reminder-occurrences" WHERE id=$1`,
              [due.id],
            )
          ).rows[0];
          assert.equal(occurrence.state, 'failed');
          assert.equal(occurrence.reason_code.length, 64);
          await db.admin.query(
            `UPDATE public."ramesh-reminder-occurrences" SET finished_at=clock_timestamp()-interval '31 days' WHERE id=$1`,
            [due.id],
          );
          await f.repo.clean();
          assert.equal(await f.repo.claimDue(30000), null);
          assert.equal(
            (
              await db.admin.query(
                `SELECT state,consumed FROM public."ramesh-reminders" WHERE id=$1`,
                [r.id],
              )
            ).rows[0].consumed,
            true,
          );
          assert.equal(
            (
              await db.admin.query(
                `SELECT count(*)::int n FROM public."ramesh-reminder-occurrences" WHERE reminder_id=$1`,
                [r.id],
              )
            ).rows[0].n,
            0,
          );
          const recurring = (
            await apply(f, [
              { kind: 'reminder_create', text: 'Daily synthetic review', schedule: future() },
            ])
          ).records[0]!;
          await dueNow(recurring.id, 86400 * 50 + 60, true);
          const current = await f.repo.claimDue(30000);
          assert.ok(current);
          assert.equal(current.reminderId, recurring.id);
          assert.ok(Date.now() - Date.parse(current.dueAt) < 120000);
          const listed = (await f.repo.list(actor, 'reminder', randomUUID())).records.find(
            (x) => x.id === recurring.id,
          )!;
          assert.ok(Date.parse(listed.nextDueAt!) > Date.now());
          assert.equal(
            (
              await db.admin.query(
                `SELECT count(*)::int n FROM public."ramesh-reminder-occurrences" WHERE reminder_id=$1`,
                [recurring.id],
              )
            ).rows[0].n,
            1,
          );
        },
      );
    } finally {
      await db.close();
    }
  },
);
