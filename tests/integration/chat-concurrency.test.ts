/** Real queue arbitration over a disposable local database, using synthetic records only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  MessageQueueRepository,
  type MessageJob,
} from '../../src/infrastructure/database/message-queue.repository.js';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';
import type { GreetingCandidate } from '../../src/modules/greetings/greeting.types.js';

const candidate = (chatId: string, senderId = chatId): GreetingCandidate => ({
  chatId,
  senderId,
  messageId: randomUUID(),
  sentAtMs: Date.now(),
  fromMe: false,
  isGroup: chatId.endsWith('@g.us'),
  mentionsBot: true,
  text: 'Synthetic queue input',
});

test(
  'per-chat ordering and cross-process concurrency',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async (t) => {
    const db = await temporaryMessageDatabase();
    const enqueue = async (repo: MessageQueueRepository, chat: string, sender?: string) => {
      const id = randomUUID();
      assert.equal(
        await repo.enqueue(id, candidate(chat, sender), 'opaque', 300000, 100, {
          content: 'opaque inbox',
          replyEligible: true,
        }),
        'queued',
      );
      return id;
    };
    const finish = async (repo: MessageQueueRepository, job: MessageJob) => {
      if (job.direction === 'inbound')
        assert.equal(await repo.handoff(job, 'opaque response'), true);
      const delivery = job.direction === 'outbound' ? job : await repo.claimOutbound(30000);
      assert.ok(delivery);
      assert.equal(delivery.id, job.id);
      assert.equal(await repo.beginSend(delivery), true);
      assert.equal(await repo.complete(delivery, 'SENT'), true);
    };
    try {
      await t.test(
        'different chats claim together, with a shared three-job cap across repositories',
        async () => {
          const a = new MessageQueueRepository(db.runtime, 'parallel');
          const b = new MessageQueueRepository(db.runtime, 'parallel');
          const ids: string[] = [];
          for (let i = 0; i < 5; i++) ids.push(await enqueue(a, `chat-${i}@s.whatsapp.net`));
          const claims = await Promise.all(
            Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).claimNext(30000)),
          );
          const claimed = claims.filter((x): x is MessageJob => !!x);
          assert.equal(claimed.length, 3);
          assert.deepEqual(new Set(claimed.map((x) => x.id)), new Set(ids.slice(0, 3)));
          await finish(a, claimed.find((x) => x.id === ids[0])!);
          assert.equal((await b.claimNext(30000))!.id, ids[3]);
          assert.equal(await a.claimNext(30000), null);
        },
      );

      await t.test(
        'same-chat turns wait through debounce, retry, handoff, delivery and operator messages',
        async () => {
          const repo = new MessageQueueRepository(db.runtime, 'ordered');
          const first = await enqueue(repo, 'chat@s.whatsapp.net');
          const second = await enqueue(repo, 'chat@s.whatsapp.net');
          const admin = randomUUID();
          assert.equal(
            await repo.enqueueAdmin(
              admin,
              'chat@s.whatsapp.net',
              'opaque',
              'opaque',
              100,
              'a'.repeat(64),
            ),
            'queued',
          );
          const fourth = await enqueue(repo, 'chat@s.whatsapp.net');
          const independent = await enqueue(repo, 'elsewhere@s.whatsapp.net');
          await db.admin.query(
            `UPDATE public."ramesh-inbound-queue" SET available_at=clock_timestamp()+interval '1 minute' WHERE message_id=$1`,
            [first],
          );
          const other = await repo.claimNext(30000);
          assert.equal(other!.id, independent, 'a delayed head blocks only its own conversation');
          assert.equal(await repo.claimNext(30000), null);
          await db.admin.query(
            `UPDATE public."ramesh-inbound-queue" SET available_at=clock_timestamp() WHERE message_id=$1`,
            [first],
          );
          let head = await repo.claimNext(30000);
          assert.equal(head!.id, first);
          assert.equal(await repo.claimNext(30000), null);
          await repo.releaseUnsent(head!);
          assert.equal(
            await repo.claimNext(30000),
            null,
            'retry backoff must not allow overtaking',
          );
          await db.admin.query(
            `UPDATE public."ramesh-inbound-queue" SET available_at=clock_timestamp() WHERE message_id=$1`,
            [first],
          );
          head = await repo.claimNext(30000);
          await repo.handoff(head!, 'reply');
          assert.equal(await repo.claimInbound(30000), null, 'ready outbound keeps its place');
          await finish(repo, (await repo.claimNext(30000))!);
          const next = await repo.claimNext(30000);
          assert.equal(next!.id, second);
          await finish(repo, next!);
          const operator = await repo.claimNext(30000);
          assert.equal(operator!.id, admin);
          assert.equal(operator!.origin, 'admin');
          assert.equal(await repo.claimInbound(30000), null);
          await finish(repo, operator!);
          assert.equal((await repo.claimNext(30000))!.id, fourth);
        },
      );

      await t.test('debouncing never merges across another sender or operator turn', async () => {
        const policy = { textMs: 10000, burstMs: 15000, maxMs: 20000 };
        const repo = new MessageQueueRepository(db.runtime, 'batch-order', policy);
        const first = await enqueue(repo, 'group@g.us', 'alice@lid');
        const child = await enqueue(repo, 'group@g.us', 'alice@lid');
        const second = await enqueue(repo, 'group@g.us', 'bob@lid');
        const third = await enqueue(repo, 'group@g.us', 'alice@lid');
        const admin = randomUUID();
        await repo.enqueueAdmin(admin, 'group@g.us', 'opaque', 'opaque', 100, 'b'.repeat(64));
        const afterAdmin = await enqueue(repo, 'group@g.us', 'alice@lid');
        const rows = (
          await db.admin.query(
            `SELECT message_id,batch_parent FROM public."ramesh-inbound-queue" WHERE account_id=$1`,
            [repo.accountId],
          )
        ).rows;
        assert.equal(rows.find((x) => x.message_id === child).batch_parent, first);
        for (const id of [first, second, third, afterAdmin])
          assert.equal(rows.find((x) => x.message_id === id).batch_parent, null);
        await db.admin.query(
          `UPDATE public."ramesh-inbound-queue" SET available_at=clock_timestamp() WHERE account_id=$1`,
          [repo.accountId],
        );
        const head = await repo.claimNext(30000);
        assert.equal(head!.id, first);
        assert.deepEqual(
          head!.members!.map((x) => x.id),
          [child],
        );
        await finish(repo, head!);
        assert.equal((await repo.claimNext(30000))!.id, second);
      });

      await t.test(
        'expired leases recover with new tokens and reject late renewal or completion',
        async () => {
          const repo = new MessageQueueRepository(db.runtime, 'fence');
          const id = await enqueue(repo, 'chat@s.whatsapp.net');
          const old = (await repo.claimNext(30000))!;
          assert.equal(await repo.renewLease(old, 30000), true);
          await db.admin.query(
            `UPDATE public."ramesh-inbound-queue" SET lease_until=clock_timestamp()-interval '1 second' WHERE message_id=$1`,
            [id],
          );
          assert.equal(await repo.renewLease(old, 30000), false);
          const next = (await new MessageQueueRepository(db.runtime, 'fence').claimNext(30000))!;
          assert.equal(next.id, id);
          assert.notEqual(next.token, old.token);
          assert.equal(await repo.handoff(old, 'stale response'), false);
          assert.equal(await repo.complete(old, 'FAILED'), false);
          assert.equal(await repo.renewLease(old, 30000), false);
          assert.equal(await repo.renewLease(next, 30000), true);
          await finish(repo, next);
        },
      );

      await t.test(
        'delivery stays serial across chats while another chat can prepare',
        async () => {
          const repo = new MessageQueueRepository(db.runtime, 'paced-delivery');
          await enqueue(repo, 'a@s.whatsapp.net');
          await enqueue(repo, 'b@s.whatsapp.net');
          const first = (await repo.claimInbound(30000))!;
          const second = (await repo.claimInbound(30000))!;
          await repo.handoff(first, 'reply a');
          await repo.handoff(second, 'reply b');
          const sending = (await repo.claimOutbound(30000))!;
          assert.equal(sending.id, first.id);
          assert.equal(await repo.claimOutbound(30000), null);
          const third = await enqueue(repo, 'c@s.whatsapp.net');
          assert.equal((await repo.claimNext(30000))!.id, third);
          await finish(repo, sending);
          assert.equal((await repo.claimOutbound(30000))!.id, second.id);
        },
      );

      await t.test('account separation and explicit lower cap remain enforced', async () => {
        const limited = new MessageQueueRepository(db.runtime, 'limited', undefined, 1);
        const other = new MessageQueueRepository(db.runtime, 'other', undefined, 1);
        await enqueue(limited, 'first@s.whatsapp.net');
        await enqueue(limited, 'second@s.whatsapp.net');
        await enqueue(other, 'first@s.whatsapp.net');
        assert.ok(await limited.claimNext(30000));
        assert.equal(await limited.claimNext(30000), null);
        assert.ok(await other.claimNext(30000));
      });
    } finally {
      await db.close();
    }
  },
);
