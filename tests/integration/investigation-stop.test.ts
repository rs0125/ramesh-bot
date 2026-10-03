/** Durable STOP boundaries over disposable local PostgreSQL and synthetic messages only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'pg';
import { proto } from '@whiskeysockets/baileys';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import {
  MessageQueueRepository,
  type MessageJob,
} from '../../src/infrastructure/database/message-queue.repository.js';
import { PersonalRepository } from '../../src/infrastructure/database/personal.repository.js';
import { WriteRepository } from '../../src/infrastructure/database/write.repository.js';
import type { GreetingCandidate } from '../../src/modules/greetings/greeting.types.js';
import { renderInvestigationStop } from '../../src/modules/messaging/investigation-stop.js';
import type { WriteCommandContext, WriteOperation } from '../../src/modules/writes/write.types.js';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';

const actor = {
  employeeId: 23,
  phoneE164: '+919000000023',
  chatId: '919000000023@s.whatsapp.net',
};
const candidate = (
  chatId = actor.chatId,
  senderId = chatId,
  text = 'Synthetic research',
): GreetingCandidate => ({
  chatId,
  senderId,
  text,
  messageId: randomUUID(),
  sentAtMs: Date.now(),
  fromMe: false,
  forwarded: false,
  kind: 'text',
  isGroup: chatId.endsWith('@g.us'),
  mentionsBot: true,
});
const proposal = () => ({
  toolName: 'create_synthetic_point',
  toolSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, operation_id: { type: 'string' } },
    required: ['name', 'operation_id'],
    additionalProperties: false,
  },
  arguments: { name: 'Synthetic point' },
  idempotencyArgument: 'operation_id',
  summary: 'Create a synthetic point',
  source: { kind: 'text' as const, input: '12.1,77.2' },
});
const hasCode = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === expected;

test(
  'durable STOP preserves outcomes and fences unfinished owner work',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async (t) => {
    const db = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url'),
      cipher = authCipher(key);
    const fixture = (debounce?: { textMs: number; burstMs: number; maxMs: number }) => {
      const account = randomUUID();
      return {
        account,
        queue: new MessageQueueRepository(db.runtime, account, debounce),
        personal: new PersonalRepository(db.runtime, account, key),
        writes: new WriteRepository(db.runtime, account, key),
      };
    };
    type Fixture = ReturnType<typeof fixture>;
    function sealed(id: string, input: GreetingCandidate) {
      const message = {
        key: {
          id: input.messageId,
          remoteJid: input.chatId,
          fromMe: false,
          ...(input.isGroup ? { participant: input.senderId } : {}),
        },
        messageTimestamp: Math.floor(input.sentAtMs / 1000),
        message: { conversation: input.text },
      };
      return {
        payload: cipher.seal(
          'message',
          id,
          Buffer.from(proto.WebMessageInfo.encode(message).finish()),
        ),
        content: cipher.seal('inbox', id, {
          text: input.text,
          senderId: input.senderId,
          senderName: 'Synthetic',
          chatName: null,
          kind: 'text',
        }),
      };
    }
    async function enqueue(f: Fixture, input = candidate()) {
      const id = randomUUID(),
        encrypted = sealed(id, input);
      assert.equal(
        await f.queue.enqueue(id, input, encrypted.payload, 300000, 100, {
          content: encrypted.content,
          replyEligible: true,
        }),
        'queued',
      );
      return id;
    }
    async function command(f: Fixture, text = 'Create a synthetic point') {
      const id = await enqueue(f, candidate(actor.chatId, actor.chatId, text));
      const job = await f.queue.claimInbound(120000);
      assert.ok(job);
      assert.equal(job.id, id);
      assert.equal(await f.queue.beginAgentRun(job), true);
      const ctx: WriteCommandContext = {
        ...actor,
        runId: id,
        sourceMessageId: id,
        leaseToken: job.token,
        requestTimeMs: Date.now(),
      };
      return { job, ctx };
    }
    async function stop(
      f: Fixture,
      input = candidate(actor.chatId, actor.chatId, 'STOP'),
      id = randomUUID(),
      capacity = 100,
    ) {
      const encrypted = sealed(id, input);
      let rendered = 0;
      const result = await f.queue.stopInvestigations(
        id,
        input,
        encrypted.payload,
        encrypted.content,
        300000,
        (outcome) => {
          rendered++;
          return cipher.seal('outbound-reply', id, renderInvestigationStop(outcome));
        },
        capacity,
      );
      return { id, input, result, rendered };
    }
    async function message(id: string) {
      return (await db.admin.query('SELECT * FROM public."ramesh-messages" WHERE id=$1', [id]))
        .rows[0]!;
    }
    async function cancelled(id: string) {
      const row = await message(id);
      assert.equal(row.state, 'EXPIRED');
      assert.equal(row.reason, 'user_stopped');
      assert.equal(row.payload_encrypted, null);
      for (const table of ['ramesh-inbound-queue', 'ramesh-outbound-queue']) {
        const rows = (
          await db.admin.query(`SELECT * FROM public."${table}" WHERE message_id=$1`, [id])
        ).rows;
        for (const queue of rows) {
          assert.ok(['DONE', 'DEAD'].includes(queue.state));
          assert.equal(queue.lease_token, null);
          assert.equal(queue.lease_until, null);
          if (table === 'ramesh-outbound-queue') assert.equal(queue.payload_encrypted, null);
        }
      }
    }
    async function deliverProposal(f: Fixture, job: MessageJob, op: WriteOperation) {
      const receipt = {
        kind: 'business_write',
        version: 1,
        ...actor,
        runId: job.id,
        operations: [{ id: op.operationId, version: op.version }],
        tools: [op.payload.toolName],
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
      assert.equal(
        await f.queue.handoff(
          job,
          cipher.seal('outbound-reply', job.id, {
            version: 1,
            kind: 'business',
            text: `Review synthetic point\nconfirm ${op.confirmationCode}`,
          }),
          new Date(),
          cipher.seal('business-delivery', job.id, {
            kind: 'write_bundle',
            version: 1,
            write: receipt,
          }),
          undefined,
          receipt,
        ),
        true,
      );
      const outgoing = (await f.queue.claimOutbound(120000))!;
      assert.equal(outgoing.id, job.id);
      assert.equal(await f.queue.beginSend(outgoing), true);
      assert.equal(await f.queue.complete(outgoing, 'SENT'), true);
    }
    try {
      await t.test(
        'active and queued research is cancelled, with one durable acknowledgement and no model job',
        async () => {
          const f = fixture(),
            active = await command(f),
            queued = await enqueue(f);
          const stopped = await stop(f);
          assert.deepEqual(
            new Set(stopped.result.cancelledRunIds),
            new Set([active.job.id, queued]),
          );
          assert.equal(stopped.result.duplicate, false);
          assert.equal(stopped.result.preservedOutcomes, 0);
          assert.equal(stopped.rendered, 1);
          await cancelled(active.job.id);
          await cancelled(queued);
          assert.equal(await f.queue.renewLease(active.job, 30000), false);
          assert.equal(await f.queue.handoff(active.job, 'late reply'), false);
          assert.equal(await f.queue.complete(active.job, 'FAILED'), false);
          await assert.rejects(
            f.personal.applyBatch(active.ctx, [{ kind: 'task_create', text: 'Late task' }]),
            hasCode('PERSONAL_LEASE_LOST'),
          );
          await assert.rejects(
            f.writes.propose(active.ctx, proposal()),
            hasCode('WRITE_LEASE_LOST'),
          );
          const ack = await message(stopped.id);
          assert.equal(ack.state, 'READY_TO_SEND');
          assert.equal(ack.origin, 'whatsapp');
          assert.equal(
            (
              await db.admin.query(
                'SELECT 1 FROM public."ramesh-inbound-queue" WHERE message_id=$1',
                [stopped.id],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await db.admin.query('SELECT 1 FROM public."ramesh-agent-runs" WHERE id=$1', [
                stopped.id,
              ])
            ).rowCount,
            0,
          );
          const outgoing = (await f.queue.claimOutbound(30000))!;
          assert.equal(outgoing.id, stopped.id);
          assert.equal(
            cipher.open('outbound-reply', stopped.id, outgoing.replyPayload!),
            renderInvestigationStop(stopped.result),
          );
          assert.equal(await f.queue.beginSend(outgoing), true);
          assert.equal(await f.queue.complete(outgoing, 'SENT'), true);
        },
      );

      await t.test(
        'STOP fences a leased unsent answer; duplicate admission after restart leaves later work intact',
        async () => {
          const f = fixture(),
            active = await command(f);
          assert.equal(await f.queue.handoff(active.job, 'old research answer'), true);
          const outgoing = (await f.queue.claimOutbound(30000))!;
          const first = await stop(f);
          assert.deepEqual(first.result.cancelledRunIds, [active.job.id]);
          await cancelled(active.job.id);
          assert.equal(await f.queue.beginSend(outgoing), false);
          assert.equal(await f.queue.renewLease(outgoing, 30000), false);
          assert.equal(await f.queue.complete(outgoing, 'SENT'), false);
          const later = await enqueue(f);
          const duplicate = await stop(
            { ...f, queue: new MessageQueueRepository(db.runtime, f.account) },
            first.input,
          );
          assert.equal(duplicate.result.duplicate, true);
          assert.equal(duplicate.rendered, 0);
          assert.equal((await message(later)).state, 'QUEUED');
          assert.equal(await message(duplicate.id), undefined);
          assert.equal(
            (
              await db.admin.query(
                'SELECT count(*)::int AS count FROM public."ramesh-outbound-queue" WHERE account_id=$1 AND state=\'READY\'',
                [f.account],
              )
            ).rows[0].count,
            1,
          );
        },
      );

      await t.test(
        'acknowledgement persistence failure rolls back cancellation and admission',
        async () => {
          const f = fixture(),
            active = await command(f);
          const input = candidate(actor.chatId, actor.chatId, 'STOP'),
            id = randomUUID();
          const encrypted = sealed(id, input);
          await assert.rejects(
            f.queue.stopInvestigations(
              id,
              input,
              encrypted.payload,
              encrypted.content,
              300000,
              () => {
                throw new Error('Synthetic render failure');
              },
            ),
            /Synthetic render failure/,
          );
          assert.equal(await message(id), undefined);
          assert.equal((await message(active.job.id)).state, 'PROCESSING');
          assert.equal(await f.queue.renewLease(active.job, 30000), true);
          const retried = await stop(f, input, id);
          assert.equal(retried.result.duplicate, false);
          assert.deepEqual(retried.result.cancelledRunIds, [active.job.id]);
          await cancelled(active.job.id);
        },
      );

      await t.test(
        'STOP cancels at capacity without reviving a suppressed acknowledgement on replay',
        async () => {
          const f = fixture(),
            active = await command(f);
          const otherChat = '919000000024@s.whatsapp.net';
          const blocker = await enqueue(f, candidate(otherChat, otherChat));
          const input = candidate(actor.chatId, actor.chatId, 'STOP');
          const stopped = await stop(f, input, randomUUID(), 1);
          assert.deepEqual(stopped.result.cancelledRunIds, [active.job.id]);
          assert.equal(stopped.result.replyQueued, false);
          assert.equal(stopped.rendered, 0);
          await cancelled(active.job.id);
          const source = await message(stopped.id);
          assert.equal(source.state, 'OBSERVED');
          assert.equal(source.stop_result.replyQueued, false);
          assert.equal(source.reply_encrypted, null);
          assert.equal((await message(blocker)).state, 'QUEUED');
          for (const table of ['ramesh-inbound-queue', 'ramesh-outbound-queue'])
            assert.equal(
              (
                await db.admin.query(`SELECT 1 FROM public."${table}" WHERE message_id=$1`, [
                  stopped.id,
                ])
              ).rowCount,
              0,
            );

          const claimed = (await f.queue.claimInbound(30000))!;
          assert.equal(claimed.id, blocker);
          assert.equal(
            await f.queue.complete(claimed, 'FAILED', 'synthetic capacity released'),
            true,
          );
          const replayed = await stop(
            { ...f, queue: new MessageQueueRepository(db.runtime, f.account) },
            input,
            randomUUID(),
            1,
          );
          assert.equal(replayed.result.duplicate, true);
          assert.equal(replayed.result.replyQueued, false);
          assert.equal(replayed.rendered, 0);
          assert.equal(await message(replayed.id), undefined);
          assert.equal((await message(stopped.id)).state, 'OBSERVED');
          assert.equal(
            (
              await db.admin.query(
                'SELECT 1 FROM public."ramesh-outbound-queue" WHERE account_id=$1',
                [f.account],
              )
            ).rowCount,
            0,
          );

          const freed = fixture(),
            investigation = await command(freed);
          const admitted = await stop(
            freed,
            candidate(actor.chatId, actor.chatId, 'STOP'),
            randomUUID(),
            1,
          );
          assert.deepEqual(admitted.result.cancelledRunIds, [investigation.job.id]);
          assert.equal(admitted.result.replyQueued, true);
          assert.equal(admitted.rendered, 1);
          await cancelled(investigation.job.id);
          assert.equal((await message(admitted.id)).state, 'READY_TO_SEND');
          assert.equal((await message(admitted.id)).stop_result.replyQueued, true);
          assert.equal((await freed.queue.claimOutbound(30000))!.id, admitted.id);
        },
      );

      await t.test(
        'group owner, chat and account isolation also preserve admin, automation and reminder jobs',
        async () => {
          const f = fixture(),
            otherAccount = fixture(),
            group = 'synthetic@g.us';
          const own = await enqueue(f, candidate(group, 'alice@lid'));
          const otherSender = await enqueue(f, candidate(group, 'bob@lid'));
          const otherChat = await enqueue(f, candidate('other@g.us', 'alice@lid'));
          const other = await enqueue(otherAccount, candidate(group, 'alice@lid'));
          const admin = randomUUID(),
            automation = randomUUID(),
            reminder = randomUUID();
          assert.equal(
            await f.queue.enqueueAdmin(
              admin,
              group,
              'operator text',
              'operator reply',
              100,
              'a'.repeat(64),
            ),
            'queued',
          );
          assert.equal(
            await f.queue.enqueueAutomation(
              automation,
              actor.chatId,
              'automation text',
              'automation reply',
              100,
              'b'.repeat(64),
              300,
            ),
            'queued',
          );
          const connection = await db.runtime.connect();
          try {
            await connection.query('BEGIN');
            assert.equal(
              await f.queue.enqueueReminder(
                connection,
                reminder,
                actor.chatId,
                'reminder text',
                'reminder reply',
                'proof',
                100,
                {
                  reminderId: randomUUID(),
                  occurrenceId: randomUUID(),
                  scheduleVersion: 1,
                  dispatchGeneration: 1,
                  ownerEmployeeId: actor.employeeId,
                  recipientPhoneE164: actor.phoneE164,
                  notAfterMs: Date.now() + 300000,
                },
              ),
              reminder,
            );
            await connection.query('COMMIT');
          } finally {
            connection.release();
          }
          const result = await stop(f, candidate(group, 'alice@lid', 'STOP'));
          assert.deepEqual(result.result.cancelledRunIds, [own]);
          await cancelled(own);
          await stop(f);
          for (const id of [otherSender, otherChat, other])
            assert.equal((await message(id)).state, 'QUEUED');
          for (const id of [admin, automation, reminder])
            assert.equal((await message(id)).state, 'READY_TO_SEND');
        },
      );

      await t.test(
        'debounced child messages terminate with their root and do not become fresh work',
        async () => {
          const f = fixture({ textMs: 10000, burstMs: 15000, maxMs: 20000 });
          const root = await enqueue(f),
            child = await enqueue(f);
          assert.equal(
            (
              await db.admin.query(
                'SELECT batch_parent FROM public."ramesh-inbound-queue" WHERE message_id=$1',
                [child],
              )
            ).rows[0].batch_parent,
            root,
          );
          const stopped = await stop(f);
          assert.deepEqual(stopped.result.cancelledRunIds, [root]);
          await cancelled(root);
          await cancelled(child);
          assert.equal(await f.queue.claimInbound(30000), null);
        },
      );

      await t.test(
        'a STOP from another DM or sender key cannot cancel the owner conversation',
        async () => {
          const f = fixture(),
            active = await command(f);
          const otherChat = '919000000024@s.whatsapp.net';
          const elsewhere = await stop(f, candidate(otherChat, otherChat, 'STOP'));
          const mismatched = await stop(f, candidate(actor.chatId, otherChat, 'STOP'));
          assert.deepEqual(elsewhere.result.cancelledRunIds, []);
          assert.deepEqual(mismatched.result.cancelledRunIds, []);
          assert.equal((await message(active.job.id)).state, 'PROCESSING');
          assert.equal(await f.queue.renewLease(active.job, 30000), true);
        },
      );

      for (const state of ['SENDING', 'UNCERTAIN'] as const) {
        await t.test(`${state} delivery is preserved and reported honestly`, async () => {
          const f = fixture(),
            active = await command(f);
          await f.queue.handoff(active.job, 'answer');
          const outbound = (await f.queue.claimOutbound(30000))!;
          assert.equal(await f.queue.beginSend(outbound), true);
          if (state === 'UNCERTAIN')
            assert.equal(
              await f.queue.complete(outbound, 'UNCERTAIN', 'synthetic uncertainty'),
              true,
            );
          const stopped = await stop(f);
          assert.deepEqual(stopped.result.cancelledRunIds, []);
          assert.equal(stopped.result.alreadySending, 1);
          assert.equal((await message(active.job.id)).state, state);
          if (state === 'SENDING') assert.equal(await f.queue.complete(outbound, 'SENT'), true);
        });
      }

      await t.test(
        'committed personal mutation retains its receipt and can finish confirmation',
        async () => {
          const f = fixture(),
            active = await command(f);
          const receipt = await f.personal.applyBatch(active.ctx, [
            { kind: 'task_create', text: 'Saved synthetic task' },
          ]);
          const stopped = await stop(f);
          assert.deepEqual(stopped.result.cancelledRunIds, []);
          assert.equal(stopped.result.preservedOutcomes, 1);
          assert.equal((await message(active.job.id)).state, 'PROCESSING');
          assert.equal(await f.queue.renewLease(active.job, 30000), true);
          assert.equal(
            await f.queue.handoff(
              active.job,
              'confirmed task',
              new Date(),
              'personal proof',
              receipt.commandId,
            ),
            true,
          );
          assert.equal(
            (
              await db.admin.query(
                'SELECT count(*)::int AS count FROM public."ramesh-tasks" WHERE account_id=$1',
                [f.account],
              )
            ).rows[0].count,
            1,
          );
        },
      );

      for (const state of ['DRAFT', 'PROPOSED', 'DISPATCHING', 'UNKNOWN'] as const) {
        await t.test(
          `business ${state} ${state === 'DRAFT' ? 'can stop before publication' : 'keeps its existing outcome'}`,
          async () => {
            const f = fixture();
            let active = await command(f),
              operation = await f.writes.propose(active.ctx, proposal());
            if (state !== 'DRAFT')
              operation = await f.writes.publish(
                active.ctx,
                operation.operationId,
                operation.version,
              );
            if (state === 'DISPATCHING' || state === 'UNKNOWN') {
              await deliverProposal(f, active.job, operation);
              active = await command(f, `confirm ${operation.confirmationCode}`);
              operation = await f.writes.approve(
                active.ctx,
                operation.operationId,
                operation.version,
                operation.confirmationCode,
              );
              const claim = (await f.writes.claim(
                active.ctx,
                operation.operationId,
                operation.version,
              ))!;
              operation = claim.operation;
              if (state === 'UNKNOWN')
                operation = await f.writes.finish(
                  active.ctx,
                  operation.operationId,
                  claim.dispatchToken,
                  {
                    operation_id: operation.operationId,
                    outcome: 'outcome_unknown',
                    code: 'SYNTHETIC',
                    message: 'Synthetic unknown outcome',
                  },
                );
            }
            assert.equal(operation.state, state);
            const stopped = await stop(f);
            if (state === 'DRAFT') {
              assert.deepEqual(stopped.result.cancelledRunIds, [active.job.id]);
              await assert.rejects(
                f.writes.publish(active.ctx, operation.operationId, operation.version),
                hasCode('WRITE_LEASE_LOST'),
              );
              await cancelled(active.job.id);
            } else {
              assert.deepEqual(stopped.result.cancelledRunIds, []);
              assert.equal(stopped.result.preservedOutcomes, 1);
              assert.equal((await message(active.job.id)).state, 'PROCESSING');
              assert.equal(await f.queue.renewLease(active.job, 30000), true);
              assert.equal(
                (await f.writes.receiptLookup(actor, operation.operationId))!.state,
                state,
              );
            }
          },
        );
      }

      await t.test(
        'a publication already holding the message lock commits before STOP rechecks effects',
        async () => {
          const f = fixture(),
            active = await command(f),
            draft = await f.writes.propose(active.ctx, proposal());
          let entered!: () => void, release!: () => void;
          const atCommit = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const continueCommit = new Promise<void>((resolve) => {
            release = resolve;
          });
          const gatedPool = new Proxy(db.runtime, {
            get(pool, property) {
              if (property === 'connect')
                return async () => {
                  const client = await pool.connect();
                  return new Proxy(client, {
                    get(target, key) {
                      if (key === 'query')
                        return async (...args: unknown[]) => {
                          if (args[0] === 'COMMIT') {
                            entered();
                            await continueCommit;
                          }
                          return Reflect.apply(target.query, target, args);
                        };
                      const value = Reflect.get(target, key);
                      return typeof value === 'function' ? value.bind(target) : value;
                    },
                  });
                };
              const value = Reflect.get(pool, property);
              return typeof value === 'function' ? value.bind(pool) : value;
            },
          }) as Pool;
          const publishing = new WriteRepository(gatedPool, f.account, key).publish(
            active.ctx,
            draft.operationId,
            draft.version,
          );
          await atCommit;
          const stopping = stop(f);
          try {
            const deadline = Date.now() + 700;
            let waiting = false;
            while (Date.now() < deadline) {
              waiting = !!(
                await db.admin.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='ramesh_worker' AND wait_event_type='Lock'",
                )
              ).rowCount;
              if (waiting) break;
              await sleep(10);
            }
            assert.equal(waiting, true, 'STOP waits for the live write transaction row locks');
          } finally {
            release();
          }
          const [published, stopped] = await Promise.all([publishing, stopping]);
          assert.equal(published.state, 'PROPOSED');
          assert.deepEqual(stopped.result.cancelledRunIds, []);
          assert.equal(stopped.result.preservedOutcomes, 1);
          assert.equal((await message(active.job.id)).state, 'PROCESSING');
        },
      );

      await t.test('STOP racing send admission has one coherent winner', async () => {
        const f = fixture(),
          active = await command(f);
        await f.queue.handoff(active.job, 'answer');
        const outbound = (await f.queue.claimOutbound(30000))!;
        const [stopped, sent] = await Promise.all([stop(f), f.queue.beginSend(outbound)]);
        if (sent) {
          assert.deepEqual(stopped.result.cancelledRunIds, []);
          assert.equal(stopped.result.alreadySending, 1);
          assert.equal((await message(active.job.id)).state, 'SENDING');
        } else {
          assert.deepEqual(stopped.result.cancelledRunIds, [active.job.id]);
          await cancelled(active.job.id);
        }
      });

      await t.test(
        'invalid and stale STOP commands cannot alter existing work or persist acknowledgements',
        async () => {
          const f = fixture(),
            id = await enqueue(f);
          for (const input of [
            { ...candidate(actor.chatId, actor.chatId, 'STOP'), forwarded: true },
            { ...candidate(actor.chatId, actor.chatId, 'STOP'), sentAtMs: Date.now() - 300001 },
            { ...candidate(actor.chatId, actor.chatId, 'STOP'), sentAtMs: Date.now() + 61000 },
            candidate(actor.chatId, actor.chatId, 'stop the reminder'),
          ])
            await assert.rejects(stop(f, input), /INVALID_STOP_COMMAND/);
          assert.equal((await message(id)).state, 'QUEUED');
          assert.equal(
            (
              await db.admin.query(
                'SELECT count(*)::int AS count FROM public."ramesh-messages" WHERE account_id=$1',
                [f.account],
              )
            ).rows[0].count,
            1,
          );
        },
      );
    } finally {
      await db.close();
    }
  },
);
