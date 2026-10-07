/** Synthetic local PostgreSQL only; remote databases are refused by the fixture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { temporaryMessageDatabase, postgresTestsEnabled } from '../fixtures/message-database.js';
import { ChatContextRepository } from '../../src/infrastructure/database/chat-context.repository.js';
import { InboxRepository } from '../../src/infrastructure/database/inbox.repository.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { contextScope, type ContextState } from '../../src/modules/assistant/chat-context.js';
import { toolDelivery } from '../../src/modules/assistant/tool-evidence.js';

test(
  'context SQL isolates accounts, enforces leases/CAS and orders inbox events without future replies',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async () => {
    const db = await temporaryMessageDatabase();
    try {
      const key = randomBytes(32).toString('base64url'),
        account = randomUUID();
      const cipher = authCipher(key),
        queue = new MessageQueueRepository(db.runtime, account);
      const message = {
        chatId: '20000000000@s.whatsapp.net',
        senderId: '20000000000@s.whatsapp.net',
        messageId: randomUUID(),
        sentAtMs: Date.now(),
        fromMe: false,
        isGroup: false,
        mentionsBot: false,
        text: 'Test input',
      };
      const enqueue = async (candidate: typeof message) => {
        const id = randomUUID();
        await queue.enqueue(id, candidate, 'synthetic-payload', 300000, 20, {
          content: cipher.seal('inbox', id, {
            text: candidate.text,
            senderId: candidate.senderId,
            senderName: 'Fixture',
            chatName: null,
            kind: 'text',
          }),
          replyEligible: true,
        });
        return id;
      };
      const first = await enqueue(message);
      const job = await queue.claimInbound(60000);
      assert.ok(job);
      const lease = { jobId: job.id, leaseToken: job.token, chatId: message.chatId };
      const scope = contextScope(account, message.chatId, {
        employeeId: 23,
        phoneE164: '+20000000000',
      });
      const store = new ChatContextRepository(db.runtime, account, key);
      await store.health();
      const inbox = new InboxRepository(db.runtime, account, key);
      const start = await inbox.anchor(message);
      const state: ContextState = {
        version: 1,
        cursor: start.start,
        floor: start.start,
        summaryAt: Date.now(),
        summary: { notes: [] },
        pins: [
          { key: 'goal', text: 'Private fixture pin', source: message.messageId, at: Date.now() },
        ],
        selections: [],
        businessReplies: [
          {
            source: start.start,
            expiresAt: Date.now() + 30 * 86400000,
            text: 'Private fixture RFQ: 30,000 sq ft, market rate.',
            receipt: toolDelivery(23, [], Date.now(), {
              historicalOnly: true,
              activity: [
                {
                  tool: 'read_crm_lead',
                  arguments: { id: '00000000-0000-4000-8000-000000000101' },
                  at: new Date().toISOString(),
                  status: 'failed',
                  code: 'UNAVAILABLE',
                },
              ],
            }),
          },
          {
            source: start.start + '-personal',
            expiresAt: Date.now() + 30 * 86400000,
            text: 'Private fixture task was saved.',
            receipt: {
              kind: 'personal',
              version: 1,
              employeeId: 23,
              phoneE164: '+20000000000',
              runId: 'personal-history',
              history: {
                at: new Date().toISOString(),
                activity: [
                  {
                    tool: 'personal_apply',
                    at: new Date().toISOString(),
                    status: 'committed',
                    phase: 'commit',
                    arguments: { text: 'Private fixture task' },
                  },
                ],
              },
            },
          },
          {
            source: start.start + '-write',
            expiresAt: Date.now() + 30 * 86400000,
            text: 'Private fixture write is uncertain.',
            receipt: {
              kind: 'write_bundle',
              version: 1,
              write: {
                kind: 'business_write',
                version: 1,
                employeeId: 23,
                phoneE164: '+20000000000',
                chatId: message.chatId,
                runId: 'write-history',
                tools: ['create_example'],
                operations: [{ id: randomUUID(), version: 3 }],
                expiresAt: new Date(Date.now() + 300000).toISOString(),
                history: {
                  at: new Date().toISOString(),
                  activity: [
                    {
                      tool: 'create_example',
                      at: new Date().toISOString(),
                      status: 'uncertain',
                      phase: 'commit',
                      arguments: { name: 'Private fixture write' },
                    },
                  ],
                },
              },
            },
          },
        ],
        command: null,
      };
      await assert.rejects(store.save(scope, 0, state));
      assert.equal(await store.save(scope, 0, state, lease), true);
      assert.equal(await store.save(scope, 0, state, lease), false);
      const restarted = new ChatContextRepository(db.runtime, account, key);
      assert.deepEqual((await restarted.load(scope, lease))!.state, state);
      const race = await Promise.all([
        store.save(scope, 1, state, lease),
        restarted.save(scope, 1, state, lease),
      ]);
      assert.deepEqual(race.sort(), [false, true]);
      assert.equal(
        (await db.runtime.query('SELECT * FROM public."ramesh-conversation-context"')).rowCount,
        0,
        'RLS requires transaction-local account binding',
      );
      const raw = (await db.admin.query('SELECT * FROM public."ramesh-conversation-context"')).rows;
      assert.ok(!JSON.stringify(raw).includes('Private fixture pin'));
      assert.ok(!JSON.stringify(raw).includes('Private fixture RFQ'));
      assert.ok(!JSON.stringify(raw).includes('read_crm_lead'));
      assert.ok(!JSON.stringify(raw).includes('Private fixture task'));
      assert.ok(!JSON.stringify(raw).includes('Private fixture write'));
      const reassigned = contextScope(account, message.chatId, {
        employeeId: 24,
        phoneE164: '+20000000000',
      });
      assert.equal(await store.load(reassigned, lease), null);
      assert.equal(await store.save(reassigned, 0, { ...state, pins: [] }, lease), true);
      assert.equal(await store.load(scope, lease), null);
      assert.equal(
        await store.save(scope, 2, state, lease),
        false,
        'old owner cannot save a stale revision over the new owner',
      );
      assert.equal(await store.save(scope, 0, { ...state, pins: [] }, lease), true);
      assert.deepEqual(
        (await store.load(scope, lease))!.state.pins,
        [],
        'returning owner starts a new epoch, never reusing another owner’s intervening history',
      );
      await assert.rejects(
        new ChatContextRepository(db.runtime, 'other-account', key).load(scope, lease),
      );
      const next = { ...message, messageId: randomUUID(), text: 'Next input' };
      const second = await enqueue(next);
      await db.admin.query(
        `UPDATE public."ramesh-messages" SET created_at='2026-10-05T10:00:00.000001Z' WHERE id=$1`,
        [first],
      );
      await db.admin.query(
        `UPDATE public."ramesh-messages" SET created_at='2026-10-05T10:00:00.000002Z' WHERE id=$1`,
        [second],
      );
      const before = (await inbox.anchor(next)).before;
      const page = await inbox.page(next, '2026-10-05T10:00:00.000000Z', before);
      assert.equal(page.entries.length, 1);
      assert.equal(page.entries[0]!.content, 'Test input');
      assert.match(page.entries[0]!.id, /000001Z/);
      await db.admin.query(
        `UPDATE public."ramesh-inbound-queue" SET lease_until=clock_timestamp()-interval '1 second' WHERE message_id=$1`,
        [job.id],
      );
      await assert.rejects(store.save(scope, 2, state, lease));
      await assert.rejects(store.load(scope, lease));
      // Late replies remain visible across a summary cursor, but cannot cross an owner/forget boundary.
      await db.admin.query(
        `UPDATE public."ramesh-messages" SET state='SENT',reply_encrypted=$2,reply_kind='conversation',finished_at='2026-10-05T10:00:00.000003Z' WHERE id=$1`,
        [
          first,
          cipher.seal('outbound-reply', first, 'Previous owner private conversational reply'),
        ],
      );
      const thirdMessage = {
        ...message,
        messageId: randomUUID(),
        text: 'After reassignment or forget',
      };
      const third = await enqueue(thirdMessage);
      await db.admin.query(
        `UPDATE public."ramesh-messages" SET created_at='2026-10-05T10:00:00.000004Z' WHERE id=$1`,
        [third],
      );
      const thirdAnchor = await inbox.anchor(thirdMessage);
      const late = await inbox.page(
        thirdMessage,
        before,
        thirdAnchor.before,
        '2026-10-05T10:00:00.000000Z',
      );
      assert.equal(late.entries.length, 1);
      assert.equal(late.entries[0]!.role, 'assistant');
      const rebound = await inbox.page(thirdMessage, before, thirdAnchor.before, before);
      assert.deepEqual(
        rebound.entries,
        [],
        'late replies belonging to the previous context epoch cannot be resurrected',
      );
    } finally {
      await db.close();
    }
  },
);
