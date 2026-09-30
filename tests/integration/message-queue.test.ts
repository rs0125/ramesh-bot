/** Real SQL concurrency, lease fencing, recovery, encrypted payloads, and access boundaries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { setTimeout as sleep } from 'node:timers/promises';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import type { GreetingCandidate } from '../../src/modules/greetings/greeting.types.js';
import type { WhatsAppSession } from '../../src/infrastructure/whatsapp/baileys-session.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { BaileysClient } from '../../src/infrastructure/whatsapp/baileys-client.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { applyMessageSchema } from '../../scripts/message-schema.js';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';

const candidate = (id: string = randomUUID()): GreetingCandidate => ({
  chatId: '20000000000@s.whatsapp.net',
  messageId: id,
  sentAtMs: Date.now(),
  fromMe: false,
  isGroup: false,
  mentionsBot: false,
});
const incoming = (id: string): WAMessage => ({
  key: { id, remoteJid: '20000000000@s.whatsapp.net' },
  message: { conversation: 'synthetic queue test' },
  messageTimestamp: Math.floor(Date.now() / 1000),
});
const fakeSession = (reply: WhatsAppSession['reply']): WhatsAppSession => ({
  botJids: ['10000000000@s.whatsapp.net'],
  on: () => () => {},
  async saveCredentials() {},
  async close() {},
  reply,
});
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(10);
  }
  assert.fail('Condition did not become true');
}

test(
  'PostgreSQL queue invariants and durable consumption',
  { skip: !postgresTestsEnabled },
  async (t) => {
    const database = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url');
    const queue = (repo: MessageQueueRepository, waitBeforeReply = async () => true) =>
      new DurableMessages(repo, {
        encryptionKey: key,
        maxAgeMs: 300000,
        capacity: 100,
        leaseMs: 45000,
        pollMs: 10,
        waitBeforeReply,
      });
    const states = async (account: string) =>
      (
        await database.admin.query(
          `SELECT m.id,m.state,m.payload_encrypted,j.state AS job_state
    FROM public."ramesh-messages" m LEFT JOIN public."ramesh-message-jobs" j ON j.message_id=m.id WHERE m.account_id=$1 ORDER BY m.created_at`,
          [account],
        )
      ).rows;
    try {
      await t.test('migration is repeatable; runtime and API access are restricted', async () => {
        const client = await database.admin.connect();
        try {
          await client.query('BEGIN');
          await applyMessageSchema(client, 'ramesh_queue_tests_password_1234567890');
          await client.query('COMMIT');
        } finally {
          client.release();
        }
        await new MessageQueueRepository(database.runtime, 'permissions').health();
        await assert.rejects(
          database.runtime.query('SELECT * FROM public.unrelated_crm_guard'),
          /permission denied/,
        );
        await assert.rejects(
          database.runtime.query('DELETE FROM public."ramesh-schema-migrations"'),
          /permission denied/,
        );
        await assert.rejects(
          database.runtime.query('UPDATE public."ramesh-message-events" SET state=state'),
          /permission denied/,
        );
        const rights = (
          await database.admin.query(`SELECT c.relname,c.relrowsecurity,
        has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anon,
        has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS authenticated,
        has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS service
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'ramesh-%'`)
        ).rows;
        assert.equal(rights.length, 4);
        for (const row of rights) {
          assert.equal(row.relrowsecurity, true);
          assert.equal(row.anon, false);
          assert.equal(row.authenticated, false);
          assert.equal(row.service, false);
        }
      });

      await t.test('concurrent duplicates and capacity checks are atomic', async () => {
        const repo = new MessageQueueRepository(database.runtime, 'admission');
        const message = candidate();
        const results = await Promise.all(
          Array.from({ length: 5 }, () => repo.enqueue(randomUUID(), message, 'opaque', 300000, 1)),
        );
        assert.equal(results.filter((r) => r === 'queued').length, 1);
        assert.equal(results.filter((r) => r === 'duplicate').length, 4);
        assert.equal(await repo.enqueue(randomUUID(), candidate(), 'opaque', 300000, 1), 'full');
        assert.equal((await states('admission')).length, 1);
        // If job insertion fails, the message and its transition event roll back too.
        await database.admin.query(
          'REVOKE INSERT ON public."ramesh-message-jobs" FROM ramesh_worker',
        );
        try {
          await assert.rejects(
            new MessageQueueRepository(database.runtime, 'rollback').enqueue(
              randomUUID(),
              candidate(),
              'opaque',
              300000,
              10,
            ),
          );
        } finally {
          await database.admin.query(
            'GRANT INSERT ON public."ramesh-message-jobs" TO ramesh_worker',
          );
        }
        assert.equal((await states('rollback')).length, 0);
      });

      await t.test('leases exclude competing consumers and fence stale owners', async () => {
        const repo = new MessageQueueRepository(database.runtime, 'leases');
        const message = candidate();
        await repo.enqueue(randomUUID(), message, 'opaque', 300000, 10);
        const claims = await Promise.all([repo.claim(45000), repo.claim(45000)]);
        assert.equal(claims.filter(Boolean).length, 1);
        const old = claims.find(Boolean)!;
        await database.admin.query(
          `UPDATE public."ramesh-message-jobs" SET lease_until=clock_timestamp()-interval '1 second' WHERE message_id=$1`,
          [old.id],
        );
        const recovered = await repo.claim(45000);
        assert.ok(recovered);
        assert.notEqual(recovered.token, old.token);
        assert.equal(await repo.beginSend(old), false);
        await repo.releaseUnsent(old);
        assert.equal(await repo.beginSend(recovered), true);
        assert.equal(await repo.complete(old, 'SENT'), false);
        assert.equal(await repo.complete(recovered, 'SENT'), true);
        assert.deepEqual(
          (await states('leases')).map((r) => [r.state, r.job_state, r.payload_encrypted]),
          [['SENT', 'DONE', null]],
        );
        assert.equal(
          await new MessageQueueRepository(database.runtime, 'leases').enqueue(
            randomUUID(),
            message,
            'opaque',
            300000,
            10,
          ),
          'duplicate',
        );
        const history = (
          await database.admin.query(
            `SELECT state FROM public."ramesh-message-events" WHERE message_id=$1 ORDER BY occurred_at`,
            [old.id],
          )
        ).rows.map((r) => r.state);
        assert.deepEqual(history, [
          'QUEUED',
          'PROCESSING',
          'QUEUED',
          'PROCESSING',
          'SENDING',
          'SENT',
        ]);
      });

      await t.test('interrupted sends become uncertain and never re-enter the queue', async () => {
        const repo = new MessageQueueRepository(database.runtime, 'crash-after-send');
        await repo.enqueue(randomUUID(), candidate(), 'opaque', 300000, 10);
        const job = await repo.claim(45000);
        assert.ok(job);
        assert.equal(await repo.beginSend(job), true);
        await database.admin.query(
          `UPDATE public."ramesh-message-jobs" SET lease_until=clock_timestamp()-interval '1 second' WHERE message_id=$1`,
          [job.id],
        );
        assert.equal(
          await new MessageQueueRepository(database.runtime, 'crash-after-send').claim(45000),
          null,
        );
        assert.deepEqual(
          (await states('crash-after-send')).map((r) => [
            r.state,
            r.job_state,
            r.payload_encrypted,
          ]),
          [['UNCERTAIN', 'DEAD', null]],
        );
        assert.equal(await repo.complete(job, 'SENT'), false);
      });

      await t.test(
        'a fresh consumer resumes encrypted persisted work and quotes the original message',
        async () => {
          const repo = new MessageQueueRepository(database.runtime, 'restart');
          const message = incoming('restart-message');
          await queue(repo).enqueue(message, candidate('restart-message'));
          const stored = (await states('restart'))[0];
          assert.ok(stored.payload_encrypted.startsWith('v1.'));
          assert.ok(!stored.payload_encrypted.includes('synthetic queue test'));
          assert.equal(
            proto.WebMessageInfo.decode(
              authCipher(key).open('message', stored.id, stored.payload_encrypted) as Uint8Array,
            ).key?.id,
            'restart-message',
          );
          const controller = new AbortController();
          let sends = 0;
          await queue(new MessageQueueRepository(database.runtime, 'restart')).consume(
            fakeSession(async (original, text) => {
              sends++;
              assert.equal(original.key.id, 'restart-message');
              assert.equal(text, 'hello');
            }),
            controller.signal,
            (outcome) => {
              assert.equal(outcome, 'sent');
              controller.abort();
            },
          );
          assert.equal(sends, 1);
          assert.equal((await states('restart'))[0].state, 'SENT');
        },
      );

      await t.test(
        'disconnect during pacing releases unsent work for a later connection',
        async () => {
          const repo = new MessageQueueRepository(database.runtime, 'pause');
          const controller = new AbortController();
          let sends = 0;
          const paused = queue(repo, async () => {
            controller.abort();
            return false;
          });
          await paused.enqueue(incoming('pause-message'), candidate('pause-message'));
          await paused.consume(
            fakeSession(async () => {
              sends++;
            }),
            controller.signal,
            () => assert.fail('No send/error expected'),
          );
          assert.equal(sends, 0);
          assert.equal((await states('pause'))[0].state, 'QUEUED');
          const restarted = new AbortController();
          await queue(repo).consume(
            fakeSession(async () => {
              sends++;
            }),
            restarted.signal,
            () => restarted.abort(),
          );
          assert.equal(sends, 1);
          assert.equal((await states('pause'))[0].state, 'SENT');
        },
      );

      await t.test('send exceptions are recorded without automatic resends', async () => {
        const repo = new MessageQueueRepository(database.runtime, 'uncertain');
        const consumer = queue(repo);
        const controller = new AbortController();
        let sends = 0;
        await consumer.enqueue(incoming('uncertain-message'), candidate('uncertain-message'));
        await consumer.consume(
          fakeSession(async () => {
            sends++;
            throw new Error('transport timeout');
          }),
          controller.signal,
          (outcome) => {
            assert.equal(outcome, 'error');
            controller.abort();
          },
        );
        assert.equal(sends, 1);
        assert.equal((await states('uncertain'))[0].state, 'UNCERTAIN');
        assert.equal(await repo.claim(45000), null);
      });

      await t.test(
        'Baileys persists before connection and a replacement client drains the saved queue',
        async () => {
          const repo = new MessageQueueRepository(database.runtime, 'client-restart');
          const sent: string[] = [];
          const makeClient = () => {
            const events = new EventEmitter();
            const session = fakeSession(async (message) => {
              sent.push(message.key.id!);
            });
            session.on = (event, handler) => {
              events.on(event, handler);
              return () => {
                events.off(event, handler);
              };
            };
            const client = new BaileysClient({
              createSession: async () => session,
              logger: pino({ level: 'silent' }),
              onQr() {},
              durableMessages: queue(repo),
              handleMessage: async () => assert.fail('SQLite greeting path must not run'),
            });
            return { client, events };
          };
          const first = makeClient();
          await first.client.start();
          first.events.emit('messages.upsert', {
            type: 'notify',
            messages: [incoming('first'), incoming('second')],
          });
          // Stop immediately: admitted events must still be persisted, never sent on a closed session.
          await first.client.stop();
          assert.equal((await states('client-restart')).length, 2);
          assert.deepEqual(sent, []);
          const second = makeClient();
          await second.client.start();
          try {
            await sleep(20);
            assert.deepEqual(sent, []);
            second.events.emit('connection.update', { connection: 'open' });
            await until(async () =>
              (await states('client-restart')).every((row) => row.state === 'SENT'),
            );
            assert.deepEqual(sent, ['first', 'second']);
            assert.equal(second.client.getStatus().metrics.replied, 2);
          } finally {
            await second.client.stop();
          }
        },
      );

      await t.test(
        'stale messages, invalid payloads and exhausted leases stop without sending',
        async () => {
          const repo = new MessageQueueRepository(database.runtime, 'expired');
          const old = candidate();
          await repo.enqueue(
            randomUUID(),
            { ...old, sentAtMs: Date.now() - 400000 },
            'opaque',
            300000,
            10,
          );
          assert.equal(await repo.claim(45000), null);
          assert.equal((await states('expired'))[0].state, 'EXPIRED');
          const corrupt = new MessageQueueRepository(database.runtime, 'corrupt');
          await corrupt.enqueue(
            randomUUID(),
            candidate(),
            'not-an-authenticated-payload',
            300000,
            10,
          );
          const controller = new AbortController();
          await queue(corrupt).consume(
            fakeSession(async () => assert.fail('Corrupt payload must not send')),
            controller.signal,
            () => controller.abort(),
          );
          assert.equal((await states('corrupt'))[0].state, 'FAILED');
          const exhausted = new MessageQueueRepository(database.runtime, 'exhausted');
          await exhausted.enqueue(randomUUID(), candidate(), 'opaque', 300000, 10);
          const job = await exhausted.claim(45000);
          assert.ok(job);
          await database.admin.query(
            `UPDATE public."ramesh-message-jobs" SET attempts=max_attempts,lease_until=clock_timestamp()-interval '1 second' WHERE message_id=$1`,
            [job.id],
          );
          assert.equal(await exhausted.claim(45000), null);
          assert.equal((await states('exhausted'))[0].state, 'FAILED');
        },
      );

      await t.test(
        'expiry at the send boundary and legacy imports cannot produce stale replies',
        async () => {
          const repo = new MessageQueueRepository(database.runtime, 'boundary');
          const controller = new AbortController();
          let sends = 0;
          const consumer = queue(repo, async () => {
            await database.admin.query(
              `UPDATE public."ramesh-messages" SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id='boundary'`,
            );
            return true;
          });
          await consumer.enqueue(incoming('boundary'), candidate('boundary'));
          const consuming = consumer.consume(
            fakeSession(async () => {
              sends++;
            }),
            controller.signal,
            () => {},
          );
          try {
            await until(async () => (await states('boundary'))[0]?.state === 'EXPIRED');
          } finally {
            controller.abort();
            await consuming;
          }
          assert.equal(sends, 0);
          const legacy = new MessageQueueRepository(database.runtime, 'legacy');
          const row = {
            chatId: '20000000000@s.whatsapp.net',
            messageId: 'legacy',
            status: 'CLAIMED',
            createdAt: new Date(),
            repliedAt: null,
          };
          await legacy.importLegacy([row]);
          await legacy.importLegacy([row]);
          assert.equal((await states('legacy')).length, 1);
          assert.equal((await states('legacy'))[0].state, 'UNCERTAIN');
          assert.equal((await states('legacy'))[0].job_state, null);
          assert.equal(await legacy.claim(45000), null);
        },
      );
    } finally {
      await database.close();
    }
  },
);
