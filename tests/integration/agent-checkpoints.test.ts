/** Synthetic local SQL only: no model, business data or WhatsApp traffic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import {
  AgentCheckpointRepository,
  CHECKPOINT_MAX_BYTES,
  CHECKPOINT_MAX_STEPS,
} from '../../src/infrastructure/database/agent-checkpoint.repository.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { PlaygroundRepository } from '../../src/infrastructure/database/playground.repository.js';
import {
  CheckpointError,
  type AgentCheckpointBegin,
} from '../../src/modules/assistant/checkpoint.types.js';
import { applyPlaygroundSchema } from '../../scripts/playground-schema.js';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';

const request = {
  model: 'fixture-model',
  input: [{ role: 'user', content: 'a synthetic request' }],
};
const response = {
  status: 'completed',
  output: [
    { type: 'reasoning', encrypted_content: 'synthetic-provider-reasoning' },
    {
      type: 'function_call',
      name: 'synthetic_read',
      call_id: 'synthetic-call',
      arguments: '{"query":"example"}',
    },
  ],
  usage: { input_tokens: 4, output_tokens: 5 },
};

test(
  'durable model checkpoints recover only for the current queue owner',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async (t) => {
    const database = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url');
    let capturePool: Pool | undefined;
    const prepare = async () => {
      const accountId = randomUUID();
      const queue = new MessageQueueRepository(database.runtime, accountId);
      const id = randomUUID();
      await queue.enqueue(
        id,
        {
          chatId: '20000000000@s.whatsapp.net',
          senderId: '20000000000@s.whatsapp.net',
          messageId: id,
          sentAtMs: Date.now(),
          fromMe: false,
          isGroup: false,
          mentionsBot: false,
        },
        'synthetic-encrypted-payload',
        300000,
        20,
      );
      const job = await queue.claimInbound(60000);
      assert.ok(job);
      const options = { namespace: 'production' as const, accountId, encryptionKey: key };
      const store = new AgentCheckpointRepository(database.runtime, options);
      const startedAtMs = Date.now();
      const input: AgentCheckpointBegin = {
        jobId: job.id,
        leaseToken: job.token,
        binding: { prompt: 'fixture-v1', employee: 23 },
        requestTimeMs: startedAtMs - 100,
        startedAtMs,
        deadlineAtMs: startedAtMs + 120000,
      };
      const session = await store.begin(input);
      return { accountId, queue, job, store, input, session, options };
    };
    try {
      await t.test(
        'checkpoint transactions wait for the queue lock before locking message rows',
        async () => {
          const f = await prepare();
          await f.session.save(0, request, response);
          const writer = await database.admin.connect();
          let reading: Promise<unknown> | undefined;
          try {
            await writer.query('BEGIN');
            await writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
              `ramesh:queue:${f.accountId}`,
            ]);
            await writer.query('SELECT id FROM public."ramesh-messages" WHERE id=$1 FOR UPDATE', [
              f.job.id,
            ]);
            reading = f.session.read(0, request);
            // Observe the actual blocked PostgreSQL query, rather than relying on task scheduling.
            let blocked = false;
            const until = Date.now() + 1000;
            do {
              blocked = !!(
                await database.admin.query(
                  `SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
               AND usename='ramesh_worker' AND wait_event='advisory'`,
                )
              ).rowCount;
              if (!blocked) await delay(10);
            } while (!blocked && Date.now() < until);
            assert.equal(blocked, true);
            // A queue owner that already holds the message row can still reach its job row.
            await writer.query(
              'UPDATE public."ramesh-inbound-queue" SET lease_until=clock_timestamp()+interval \'60 seconds\' WHERE message_id=$1',
              [f.job.id],
            );
            await writer.query('COMMIT');
            assert.deepEqual(await reading, response);
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
            await reading?.catch(() => undefined);
          }
        },
      );
      await t.test(
        'a reconstructed process reuses complete provider continuation and original clocks',
        async () => {
          const f = await prepare();
          await f.session.save(0, request, response);
          await f.session.save(1, { next: true }, { text: 'synthetic final reply' });
          const resumed = await new AgentCheckpointRepository(database.runtime, f.options).begin({
            ...f.input,
            requestTimeMs: f.input.requestTimeMs + 1000,
            startedAtMs: f.input.startedAtMs! + 1000,
            deadlineAtMs: f.input.deadlineAtMs + 1000,
          });
          assert.deepEqual(resumed.metadata, f.session.metadata);
          const cached = await resumed.read<typeof response>(0, {
            input: request.input,
            model: request.model,
          });
          assert.deepEqual(cached, response);
          cached!.output.length = 0;
          assert.deepEqual(await resumed.read(0, request), response);
          assert.deepEqual(await resumed.read(1, { next: true }), {
            text: 'synthetic final reply',
          });
          const stored = (
            await database.admin.query(
              'SELECT * FROM public."ramesh-agent-checkpoints" WHERE message_id=$1',
              [f.job.id],
            )
          ).rows[0];
          assert.match(stored.payload_encrypted, /^v1\./);
          assert.ok(!JSON.stringify(stored).includes('synthetic-provider-reasoning'));
          assert.ok(!JSON.stringify(stored).includes('a synthetic request'));
        },
      );

      await t.test(
        'changed requests discard their suffix; changed binding keeps budgets and the original deadline',
        async () => {
          const f = await prepare();
          await f.session.save(0, request, response);
          await f.session.save(1, { step: 1 }, { text: 'old' });
          assert.equal(await f.session.consume('tool', 70), true);
          await f.session.policy('source:retry', () => ({ failures: 2, cooldownUntil: 123 }));
          assert.equal(await f.session.read(0, { ...request, model: 'changed' }), undefined);
          await assert.rejects(f.session.read(1, { step: 1 }), CheckpointError);
          await f.session.save(0, request, response);
          assert.equal(await f.session.read(1, { step: 1 }), undefined);
          const changed = await f.store.begin({
            ...f.input,
            binding: { prompt: 'fixture-v2', employee: 23 },
          });
          assert.equal(await changed.read(0, request), undefined);
          assert.equal(await changed.consume('tool', 3), false);
          assert.equal(await changed.consume('tool', 2), true);
          assert.deepEqual(await changed.policy('source:retry'), {
            failures: 2,
            cooldownUntil: 123,
          });
          assert.deepEqual(changed.metadata, f.session.metadata);
          await assert.rejects(f.session.read(0, request), CheckpointError);
        },
      );

      await t.test(
        'lease theft fences every operation; the new lease can still recover',
        async () => {
          const f = await prepare();
          await f.session.save(0, request, response);
          const token = randomUUID();
          await database.admin.query(
            'UPDATE public."ramesh-inbound-queue" SET lease_token=$2 WHERE message_id=$1',
            [f.job.id, token],
          );
          for (const operation of [
            () => f.session.read(0, request),
            () => f.session.save(1, request, response),
            () => f.session.consume('tool', 1),
            () => f.session.policy('retry', () => 1),
            () => f.store.begin(f.input),
          ])
            await assert.rejects(operation(), CheckpointError);
          const resumed = await f.store.begin({ ...f.input, leaseToken: token });
          assert.deepEqual(await resumed.read(0, request), response);
          await database.admin.query(
            'UPDATE public."ramesh-inbound-queue" SET lease_until=clock_timestamp()-interval \'1 second\' WHERE message_id=$1',
            [f.job.id],
          );
          await assert.rejects(resumed.read(0, request), CheckpointError);
        },
      );

      await t.test(
        'account scope, RLS and authenticated ciphertext prevent cross-run replay',
        async () => {
          const first = await prepare(),
            second = await prepare();
          await first.session.save(0, request, response);
          await assert.rejects(
            new AgentCheckpointRepository(database.runtime, {
              ...first.options,
              accountId: second.accountId,
            }).begin(first.input),
            CheckpointError,
          );
          assert.equal(
            (await database.runtime.query('SELECT * FROM public."ramesh-agent-checkpoints"'))
              .rowCount,
            0,
          );
          const privileges = (
            await database.admin.query(
              `SELECT has_table_privilege(role,'public."ramesh-agent-checkpoints"','SELECT,INSERT,UPDATE,DELETE') AS granted FROM unnest(ARRAY['anon','authenticated','service_role']) role`,
            )
          ).rows;
          assert.ok(privileges.every((row) => !row.granted));
          await database.admin.query(
            'UPDATE public."ramesh-agent-checkpoints" SET payload_encrypted=(SELECT payload_encrypted FROM public."ramesh-agent-checkpoints" WHERE message_id=$1) WHERE message_id=$2',
            [first.job.id, second.job.id],
          );
          await assert.rejects(second.session.read(0, request), CheckpointError);
          await assert.rejects(
            new AgentCheckpointRepository(database.runtime, {
              ...first.options,
              encryptionKey: randomBytes(32).toString('base64url'),
            }).begin(first.input),
            CheckpointError,
          );
        },
      );

      await t.test(
        'byte, sequence and policy bounds reject without damaging earlier progress',
        async () => {
          const f = await prepare();
          await f.session.save(0, request, response);
          await assert.rejects(
            f.session.save(1, request, 'x'.repeat(CHECKPOINT_MAX_BYTES)),
            CheckpointError,
          );
          await assert.rejects(
            f.session.save(CHECKPOINT_MAX_STEPS, request, response),
            CheckpointError,
          );
          await assert.rejects(f.session.save(3, request, response), CheckpointError);
          await assert.rejects(
            f.session.policy('__proto__', () => ({ bad: true })),
            CheckpointError,
          );
          await assert.rejects(
            f.session.policy('large', () => 'x'.repeat(16384)),
            CheckpointError,
          );
          assert.deepEqual(await f.session.read(0, request), response);
          assert.equal(await f.session.consume('bytes', 600000), true);
          assert.equal(await f.session.consume('bytes', 1), false);
          const competing = await Promise.all([
            f.session.consume('web', 3),
            f.session.consume('web', 3),
          ]);
          assert.deepEqual(competing.sort(), [false, true]);
          await assert.rejects(f.session.consume('tool', -1), CheckpointError);
        },
      );

      await t.test(
        'successful handoff and terminal failure erase payloads atomically',
        async () => {
          const f = await prepare();
          await f.session.save(0, request, response);
          assert.equal(await f.queue.handoff(f.job, 'synthetic-output'), true);
          assert.equal(
            (
              await database.admin.query(
                'SELECT 1 FROM public."ramesh-agent-checkpoints" WHERE message_id=$1',
                [f.job.id],
              )
            ).rowCount,
            0,
          );
          await assert.rejects(f.session.read(0, request), CheckpointError);
          const failed = await prepare();
          assert.equal(
            await failed.queue.complete(failed.job, 'FAILED', 'synthetic_failure'),
            true,
          );
          assert.equal(
            (
              await database.admin.query(
                'SELECT 1 FROM public."ramesh-agent-checkpoints" WHERE message_id=$1',
                [failed.job.id],
              )
            ).rowCount,
            0,
          );
        },
      );

      await t.test('expired retention is erased by scoped maintenance', async () => {
        const f = await prepare();
        await database.admin.query(
          'UPDATE public."ramesh-agent-checkpoints" SET expires_at=clock_timestamp()-interval \'1 second\' WHERE message_id=$1',
          [f.job.id],
        );
        await assert.rejects(f.session.read(0, request), CheckpointError);
        await f.store.clean();
        assert.equal(
          (
            await database.admin.query(
              'SELECT 1 FROM public."ramesh-agent-checkpoints" WHERE message_id=$1',
              [f.job.id],
            )
          ).rowCount,
          0,
        );
      });

      await t.test(
        'capture role, namespace and employee isolate recovery from production',
        async () => {
          await database.admin.query(
            'CREATE TABLE public."VerifiedNumber" (id integer PRIMARY KEY,phone_number text,email text,is_active boolean)',
          );
          const password = 'ramesh_playground_tests_password_1234567890';
          const admin = await database.admin.connect();
          try {
            await admin.query('BEGIN');
            await applyPlaygroundSchema(admin, password);
            await admin.query('COMMIT');
          } finally {
            admin.release();
          }
          const url = new URL(database.url);
          url.username = 'ramesh_playground';
          url.password = password;
          capturePool = new Pool({ connectionString: url.href, ssl: false, max: 2 });
          const namespace = randomUUID(),
            id = randomUUID();
          const queue = new PlaygroundRepository(capturePool, namespace, 23, key);
          await queue.enqueue({
            id,
            conversation: 'synthetic',
            sender: 'me',
            group: false,
            text: 'synthetic question',
          });
          const job = await queue.claim(id, 60000);
          assert.ok(job);
          const store = new AgentCheckpointRepository(capturePool, {
            namespace: 'capture',
            accountId: namespace,
            employeeId: 23,
            encryptionKey: key,
          });
          const now = Date.now();
          const input = {
            jobId: job.id,
            leaseToken: job.token,
            binding: 'synthetic',
            requestTimeMs: now,
            startedAtMs: now,
            deadlineAtMs: now + 60000,
          };
          const session = await store.begin(input);
          await session.save(0, request, response);
          assert.deepEqual(await session.read(0, request), response);
          await assert.rejects(
            new AgentCheckpointRepository(capturePool, {
              namespace: 'capture',
              accountId: namespace,
              employeeId: 24,
              encryptionKey: key,
            }).begin(input),
            CheckpointError,
          );
          await assert.rejects(
            new AgentCheckpointRepository(capturePool, {
              namespace: 'capture',
              accountId: randomUUID(),
              employeeId: 23,
              encryptionKey: key,
            }).begin(input),
            CheckpointError,
          );
          await assert.rejects(
            database.runtime.query('SELECT * FROM public."ramesh-test-agent-checkpoints"'),
            /permission denied/,
          );
          await assert.rejects(
            capturePool.query('SELECT * FROM public."ramesh-agent-checkpoints"'),
            /permission denied/,
          );
          assert.equal(
            (await capturePool.query('SELECT * FROM public."ramesh-test-agent-checkpoints"'))
              .rowCount,
            0,
          );
          await queue.finalize(job, {
            text: 'synthetic answer',
            trace: {
              stages: [],
              model: 'fixture',
              promptVersion: 'fixture',
              outcome: 'completed',
              durationMs: 1,
              runId: job.id,
            },
          });
          assert.equal(
            (
              await database.admin.query(
                'SELECT 1 FROM public."ramesh-test-agent-checkpoints" WHERE message_id=$1',
                [job.id],
              )
            ).rowCount,
            0,
          );
        },
      );
    } finally {
      if (capturePool) await capturePool.end();
      await database.close();
    }
  },
);
