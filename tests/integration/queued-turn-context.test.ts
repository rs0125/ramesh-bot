/** Real local queue + encrypted history; synthetic replies, no model or external calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { temporaryMessageDatabase, postgresTestsEnabled } from '../fixtures/message-database.js';
import { InboxRepository } from '../../src/infrastructure/database/inbox.repository.js';
import {
  MessageQueueRepository,
  type MessageJob,
} from '../../src/infrastructure/database/message-queue.repository.js';
import { ChatContextRepository } from '../../src/infrastructure/database/chat-context.repository.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { ChatContext, contextScope } from '../../src/modules/assistant/chat-context.js';
import {
  queuedReplyContent,
  PRIVATE_HISTORY_REPLY,
} from '../../src/modules/assistant/conversation-memory.js';
import { encodeReply } from '../../src/modules/messaging/reply-payload.js';
import { contextDeliveryBundle } from '../../src/modules/messaging/delivery-evidence.js';
import { businessRecall } from '../../src/modules/assistant/business-recall.js';
import type { BusinessWriteRun } from '../../src/modules/writes/write-tools.js';
import type { GreetingCandidate } from '../../src/modules/greetings/greeting.types.js';

test(
  'queued turns see completed predecessors without rewriting arrival history',
  { skip: !postgresTestsEnabled, timeout: 60000 },
  async (t) => {
    const db = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url'),
      cipher = authCipher(key);
    const chatId = '20000000000@s.whatsapp.net';
    const base = Date.now() - 120000;
    try {
      const setup = () => {
        const account = randomUUID();
        const queue = new MessageQueueRepository(db.runtime, account);
        const inbox = new InboxRepository(db.runtime, account, key);
        const store = new ChatContextRepository(db.runtime, account, key);
        let scope = contextScope(account, chatId, { employeeId: 23, phoneE164: '+20000000000' });
        const createContext = () =>
          new ChatContext({
            store,
            source: inbox,
            resolve: async () => scope,
            model: {
              async complete() {
                throw new Error('No summarization needed in this fixture');
              },
            },
          });
        const add = async (
          text: string,
          offset: number,
          options: { kind?: 'text' | 'audio'; chat?: string; otherAccount?: string } = {},
        ) => {
          const id = randomUUID();
          const candidate: GreetingCandidate = {
            chatId: options.chat ?? chatId,
            senderId: options.chat ?? chatId,
            messageId: id,
            sentAtMs: base + offset,
            text,
            kind: options.kind ?? 'text',
            fromMe: false,
            isGroup: false,
            mentionsBot: false,
          };
          const target = options.otherAccount
            ? new MessageQueueRepository(db.runtime, options.otherAccount)
            : queue;
          await target.enqueue(id, candidate, 'synthetic-payload', 300000, 100, {
            content: cipher.seal('inbox', id, {
              text,
              senderId: candidate.chatId,
              senderName: 'Synthetic user',
              chatName: null,
              kind: candidate.kind,
              ...(options.kind === 'audio' ? { voiceTranscript: { version: 1 } } : {}),
            }),
            replyEligible: true,
          });
          await db.admin.query('UPDATE public."ramesh-messages" SET created_at=$2 WHERE id=$1', [
            id,
            new Date(base + offset),
          ]);
          return { id, candidate };
        };
        const send = async (job: MessageJob, reply: string, offset: number, evidence?: unknown) => {
          assert.equal(
            await queue.handoff(
              job,
              cipher.seal('outbound-reply', job.id, encodeReply(reply, evidence !== undefined)),
              new Date(),
              evidence === undefined
                ? undefined
                : cipher.seal('business-delivery', job.id, evidence),
            ),
            true,
          );
          const out = await queue.claimOutbound(60000);
          assert.equal(out?.id, job.id);
          assert.equal(await queue.beginSend(out!), true);
          assert.equal(await queue.complete(out!, 'SENT'), true);
          await db.admin.query('UPDATE public."ramesh-messages" SET finished_at=$2 WHERE id=$1', [
            job.id,
            new Date(base + offset),
          ]);
        };
        const prepare = (
          context: ChatContext,
          item: Awaited<ReturnType<typeof add>>,
          job: MessageJob,
        ) =>
          context.prepare(
            item.candidate,
            {
              runId: job.id,
              key: { remoteJid: chatId },
              checkpointLease: { leaseToken: job.token },
            },
            AbortSignal.timeout(10000),
          );
        return {
          account,
          queue,
          inbox,
          store,
          add,
          send,
          prepare,
          createContext,
          scope: () => scope,
          reassign: () => {
            scope = contextScope(account, chatId, { employeeId: 24, phoneE164: '+20000000000' });
          },
        };
      };

      for (const kind of ['text', 'audio'] as const)
        await t.test(
          kind + ': latest completed state survives restart and subsequent queued input',
          async () => {
            const f = setup();
            const first = await f.add('Save the supplied brief for Example Storage.', 0, { kind });
            const firstJob = (await f.queue.claimInbound(60000))!;
            await f.prepare(f.createContext(), first, firstJob);
            const next = await f.add('Yes, save it.', 1000);
            const third = await f.add('Now undo that.', 2000);
            assert.equal(
              await f.queue.claimInbound(60000),
              null,
              'preceding turn still owns the chat',
            );
            await f.send(firstJob, 'Saved the Example Storage requirement.', 3000);
            const nextJob = (await f.queue.claimInbound(60000))!;
            assert.equal(nextJob.id, next.id);
            const anchor = await f.inbox.anchor(next.candidate);
            const before = await f.inbox.page(
              next.candidate,
              new Date(base - 1).toISOString(),
              anchor.before,
              new Date(base - 1).toISOString(),
            );
            assert.ok(
              before.entries.every((entry) => entry.role === 'user'),
              'arrival history does not pretend the receipt was already seen',
            );
            const current = await f.prepare(f.createContext(), next, nextJob);
            const receipt = current!.history.find((entry) => entry.queuedReply);
            assert.equal(receipt?.content, 'Saved the Example Storage requirement.');
            assert.equal(receipt?.businessRequest, first.candidate.text);
            assert.deepEqual(receipt?.queuedReply, {
              currentMessageReceivedAt: new Date(base + 1000).toISOString(),
              replySentAt: new Date(base + 3000).toISOString(),
            });
            assert.match(
              queuedReplyContent(receipt!),
              /not evidence that the user saw or confirmed/,
            );
            assert.ok(
              !JSON.stringify(current).includes(third.candidate.text!),
              'newer user input is not pulled into an earlier turn',
            );
            const restart = await f.prepare(f.createContext(), next, nextJob);
            assert.deepEqual(
              restart?.history,
              current?.history,
              'retry/restart builds stable model context',
            );
            const snapshot = await f.store.load(f.scope(), {
              jobId: nextJob.id,
              leaseToken: nextJob.token,
              chatId,
            });
            assert.ok(
              snapshot!.state.cursor < anchor.before,
              'late replies do not advance the arrival cursor',
            );
            assert.equal(snapshot!.state.businessReplies?.length ?? 0, 0);
            const fallback = await f.inbox.context(next.candidate);
            assert.deepEqual(
              fallback.find((entry) => entry.queuedReply)?.queuedReply,
              receipt?.queuedReply,
            );
            await f.send(nextJob, 'That requirement was already saved.', 4000);
            const thirdJob = (await f.queue.claimInbound(60000))!;
            assert.equal(thirdJob.id, third.id);
            const after = await f.prepare(f.createContext(), third, thirdJob);
            assert.ok(
              after!.history.some((entry) => entry.content === next.candidate.text),
              'intervening input is not skipped by a late reply',
            );
            assert.deepEqual(
              after!.history.filter((entry) => entry.queuedReply).map((entry) => entry.content),
              ['Saved the Example Storage requirement.', 'That requirement was already saved.'],
            );
            await f.send(thirdJob, 'Undid the Example Storage requirement.', 5000);
            const later = await f.add('What happened?', 6000);
            const laterJob = (await f.queue.claimInbound(60000))!;
            const settled = await f.prepare(f.createContext(), later, laterJob);
            assert.ok(
              settled!.history.every((entry) => !entry.queuedReply),
              'timing labels are relative to this input, not permanently attached to history',
            );
            assert.equal(
              settled!.history.filter(
                (entry) => entry.content === 'Undid the Example Storage requirement.',
              ).length,
              1,
            );
            await f.send(laterJob, 'It was undone.', 7000);
          },
        );

      await t.test(
        'late protected action status survives the real outbox and context owner envelope',
        async () => {
          const f = setup();
          const first = await f.add('Create the Example Storage requirement.', 0);
          const firstJob = (await f.queue.claimInbound(60000))!;
          assert.equal(await f.queue.beginAgentRun(firstJob), true);
          const prepared = await f.prepare(f.createContext(), first, firstJob);
          const next = await f.add('Yes, create it.', 1000);
          const at = new Date(base + 2500).toISOString();
          const operationId = randomUUID();
          const write = {
            kind: 'write_bundle',
            version: 1,
            write: {
              kind: 'business_write',
              version: 1,
              employeeId: 23,
              phoneE164: '+20000000000',
              chatId,
              runId: first.id,
              operations: [{ id: operationId, version: 2 }],
              tools: ['create_example_record'],
              expiresAt: new Date(base + 300000).toISOString(),
              history: {
                at,
                activity: [
                  {
                    tool: 'create_example_record',
                    at,
                    status: 'committed',
                    phase: 'commit',
                    operationId,
                  },
                ],
              },
            },
          };
          await f.send(
            firstJob,
            'Saved the Example Storage requirement.',
            3000,
            contextDeliveryBundle(prepared!.delivery!, write),
          );
          const nextJob = (await f.queue.claimInbound(60000))!;
          const current = await f.prepare(f.createContext(), next, nextJob);
          const late = current!.history.find((entry) => entry.queuedReply)!;
          assert.equal(late.content, PRIVATE_HISTORY_REPLY);
          assert.equal(late.protectedReply!.text, 'Saved the Example Storage requirement.');
          assert.equal(late.businessRequest, first.candidate.text);
          const writes = {
            canRecall: () => true,
            rememberHistoricalReply() {},
          } as unknown as BusinessWriteRun;
          const projected = businessRecall(
            current!.history,
            undefined,
            Date.now(),
            undefined,
            writes,
          );
          const update = projected.messages.find((entry) => entry.role === 'assistant')!;
          assert.match(update.content, /Saved the Example Storage requirement/);
          assert.ok(update.content.includes(operationId));
          assert.match(update.content, /committed/);
          assert.doesNotMatch(
            JSON.stringify(businessRecall(current!.history, undefined).messages),
            /Saved the Example Storage requirement|committed/,
          );
          const snapshot = await f.store.load(f.scope(), {
            jobId: nextJob.id,
            leaseToken: nextJob.token,
            chatId,
          });
          assert.equal(
            snapshot!.state.businessReplies?.length ?? 0,
            0,
            'late status must not enter arrival-time durable memory',
          );
          await f.send(nextJob, 'That requirement is already saved.', 4000);
        },
      );

      await t.test(
        'late updates obey account, chat, delivery and forget/owner boundaries',
        async () => {
          const f = setup();
          const prior = await f.add('Earlier private request', 0);
          const firstJob = (await f.queue.claimInbound(60000))!;
          await f.prepare(f.createContext(), prior, firstJob);
          const current = await f.add('Continue', 1000);
          const newer = await f.add('NEWER_INPUT', 2000);
          const otherChat = await f.add('OTHER_CHAT', 0, { chat: '20000000001@s.whatsapp.net' });
          const otherAccount = await f.add('OTHER_ACCOUNT', 0, { otherAccount: randomUUID() });
          for (const item of [newer, otherChat, otherAccount])
            await db.admin.query(
              'UPDATE public."ramesh-messages" SET state=\'SENT\',reply_encrypted=$2,finished_at=$3 WHERE id=$1',
              [
                item.id,
                cipher.seal('outbound-reply', item.id, encodeReply(item.candidate.text!, false)),
                new Date(base + 3000),
              ],
            );
          const floor = new Date(base - 1).toISOString();
          assert.deepEqual(
            await f.inbox.queuedReplies(current.candidate, floor),
            [],
            'pending output is not a delivered reply',
          );
          await f.send(firstJob, 'PRIOR_REPLY', 3000);
          const job = (await f.queue.claimInbound(60000))!;
          assert.equal(job.id, current.id);
          assert.deepEqual(
            (await f.inbox.queuedReplies(current.candidate, floor)).map((e) => e.content),
            ['PRIOR_REPLY'],
          );
          assert.deepEqual(
            await f.inbox.queuedReplies(
              current.candidate,
              (await f.inbox.anchor(current.candidate)).before,
            ),
            [],
            'forget boundary excludes earlier source turns',
          );
          f.reassign();
          const reassigned = await f.prepare(f.createContext(), current, job);
          assert.ok(
            !JSON.stringify(reassigned).includes('PRIOR_REPLY'),
            'fresh owner epoch cannot resurrect a late reply',
          );
          await db.admin.query(
            'UPDATE public."ramesh-messages" SET state=\'UNCERTAIN\' WHERE id=$1',
            [prior.id],
          );
          assert.deepEqual(
            await f.inbox.queuedReplies(current.candidate, floor),
            [],
            'uncertain sends are not described as delivered',
          );
          assert.ok(
            !(await f.inbox.context(current.candidate)).some((e) => e.content === 'PRIOR_REPLY'),
          );
        },
      );
    } finally {
      await db.close();
    }
  },
);
