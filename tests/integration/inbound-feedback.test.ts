/** Real local PostgreSQL fencing; progress feedback never reaches WhatsApp. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';

test(
  'progress acknowledgement is fenced and attempted once across concurrent claims and restart',
  {
    skip: !postgresTestsEnabled,
  },
  async () => {
    const db = await temporaryMessageDatabase();
    try {
      const repo = new MessageQueueRepository(db.runtime, 'feedback');
      await repo.health();
      const id = randomUUID();
      assert.equal(
        await repo.enqueue(
          id,
          {
            chatId: '919000000001@s.whatsapp.net',
            messageId: 'request',
            sentAtMs: Date.now(),
            fromMe: false,
            isGroup: false,
            mentionsBot: false,
          },
          'opaque-encrypted-test-payload',
          300000,
          10,
        ),
        'queued',
      );
      const job = (await repo.claimInbound(30000))!;
      assert.ok(job);
      assert.equal(
        await new MessageQueueRepository(db.runtime, 'another-account').claimAcknowledgement(job),
        false,
      );
      assert.equal(await repo.claimAcknowledgement({ ...job, token: randomUUID() }), false);
      assert.equal(await repo.claimAcknowledgement({ ...job, direction: 'outbound' }), false);
      assert.deepEqual(
        (
          await Promise.all([repo.claimAcknowledgement(job), repo.claimAcknowledgement(job)])
        ).sort(),
        [false, true],
      );
      await repo.releaseUnsent(job, true);
      const restarted = new MessageQueueRepository(db.runtime, 'feedback');
      const recovered = (await restarted.claimInbound(30000))!;
      assert.ok(recovered);
      assert.notEqual(recovered.token, job.token);
      assert.equal(await restarted.claimAcknowledgement(recovered), false);
      assert.equal(await repo.claimAcknowledgement(job), false);
    } finally {
      await db.close();
    }
  },
);
