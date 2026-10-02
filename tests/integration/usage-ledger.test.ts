import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { temporaryMessageDatabase, postgresTestsEnabled } from '../fixtures/message-database.js';
import { applyMessageSchema } from '../../scripts/message-schema.js';
import { applyPlaygroundSchema } from '../../scripts/playground-schema.js';
import { UsageLedgerRepository } from '../../src/infrastructure/database/usage-ledger.repository.js';
import type { UsageReservation } from '../../src/modules/usage/usage.types.js';

test(
  'PostgreSQL reservations are atomic, persistent and scoped without provider calls',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async (t) => {
    const db = await temporaryMessageDatabase(async (connection, password) => {
      await applyMessageSchema(connection, password);
    });
    const input = (changes: Partial<UsageReservation> = {}): UsageReservation => ({
      id: randomUUID(),
      accountId: 'fixture-account',
      purpose: 'production',
      runId: randomUUID(),
      stage: 'worker',
      model: 'fixture-model',
      operation: 'responses',
      reservedMicros: 60,
      buckets: [{ key: 'org:day:fixture', limitMicros: 100 }],
      enforce: true,
      ...changes,
    });
    try {
      await t.test(
        'separate clients share one admission decision; replay preserves original request',
        async () => {
          const left = new UsageLedgerRepository(db.runtime, 'fixture-account', 'production');
          const right = new UsageLedgerRepository(db.runtime, 'fixture-account', 'production');
          const one = input(),
            two = input();
          const results = await Promise.allSettled([left.reserve(one), right.reserve(two)]);
          assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
          assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
          const winner = results[0]!.status === 'fulfilled' ? one : two;
          await right.reserve(winner);
          await left.settle(winner.id, { state: 'unknown', actualMicros: null, durationMs: 90000 });
          await right.settle(winner.id, {
            durationMs: 90000,
            actualMicros: null,
            state: 'unknown',
          });
          await assert.rejects(
            right.settle(winner.id, { durationMs: 90000, actualMicros: 0, state: 'settled' }),
            { code: 'USAGE_SETTLEMENT_CONFLICT' },
          );
          await assert.rejects(right.reserve(input()), { code: 'USAGE_BUDGET_EXCEEDED' });
          const summary = await new UsageLedgerRepository(
            db.runtime,
            'fixture-account',
            'production',
          ).summarize(winner.accountId, winner.purpose, winner.runId);
          assert.equal(summary.requestCount, 1);
          assert.equal(summary.unknownRequests, 1);
          assert.equal(summary.heldMicros, 60);
        },
      );

      await t.test(
        'actual overages and unpriced calls survive restart and block strict requests',
        async () => {
          const ledger = new UsageLedgerRepository(db.runtime, 'fixture-account', 'evaluation');
          const first = input({
            purpose: 'evaluation',
            buckets: [{ key: 'overage', limitMicros: 100 }],
          });
          await ledger.reserve(first);
          await ledger.settle(first.id, {
            state: 'settled',
            actualMicros: 110,
            inputTokens: 3,
            durationMs: 2,
          });
          await assert.rejects(ledger.reserve({ ...first, id: randomUUID(), reservedMicros: 0 }), {
            code: 'USAGE_BUDGET_EXCEEDED',
          });
          const unpriced = input({
            purpose: 'evaluation',
            reservedMicros: null,
            enforce: false,
            buckets: [{ key: 'unpriced', limitMicros: 100 }],
          });
          await ledger.reserve(unpriced);
          await assert.rejects(
            ledger.reserve({ ...unpriced, id: randomUUID(), reservedMicros: 1, enforce: true }),
            { code: 'USAGE_ACCOUNTING_UNKNOWN' },
          );
          await ledger.settle(unpriced.id, { state: 'settled', actualMicros: 10, durationMs: 1 });
          await ledger.reserve({ ...unpriced, id: randomUUID(), reservedMicros: 1, enforce: true });
        },
      );

      await t.test(
        'unscoped runtime reads see no rows; other service roles have no grant',
        async () => {
          assert.equal(
            (await db.runtime.query('SELECT * FROM public."ramesh-usage-requests"')).rowCount,
            0,
          );
          assert.equal(
            (await db.runtime.query('SELECT * FROM public."ramesh-usage-buckets"')).rowCount,
            0,
          );
          for (const role of ['anon', 'authenticated', 'service_role']) {
            const row = (
              await db.admin.query(
                `SELECT has_table_privilege($1,'public."ramesh-usage-requests"','SELECT') AS requests,
                    has_table_privilege($1,'public."ramesh-usage-buckets"','SELECT') AS buckets`,
                [role],
              )
            ).rows[0];
            assert.equal(row.requests, false);
            assert.equal(row.buckets, false);
          }
          await assert.rejects(
            db.runtime.query('DELETE FROM public."ramesh-usage-requests"'),
            /permission denied/,
          );
          await assert.rejects(
            db.runtime.query('UPDATE public."ramesh-usage-requests" SET reserved_micros=0'),
            /permission denied/,
          );
        },
      );

      await t.test('fixed scope and RLS isolate accounts and purposes', async () => {
        const ledger = new UsageLedgerRepository(db.runtime, 'another-account', 'production');
        const other = input({ accountId: 'another-account' });
        await ledger.reserve(other);
        await assert.rejects(ledger.reserve(input()), /USAGE_SCOPE_MISMATCH/);
        await assert.rejects(
          ledger.summarize('fixture-account', 'production', 'anything'),
          /USAGE_SCOPE_MISMATCH/,
        );
        const client = await db.runtime.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT set_config('ramesh.usage_account',$1,true),set_config('ramesh.usage_purpose',$2,true)`,
            ['another-account', 'production'],
          );
          const rows = (
            await client.query('SELECT account_id,purpose FROM public."ramesh-usage-requests"')
          ).rows;
          assert.equal(rows.length, 1);
          assert.deepEqual(rows[0], { account_id: 'another-account', purpose: 'production' });
          await client.query('COMMIT');
        } finally {
          client.release();
        }
      });
    } finally {
      await db.close();
    }
  },
);

test(
  'capture usage has dedicated tables and cannot read or charge production accounting',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async () => {
    const password = 'ramesh_playground_tests_password_1234567890';
    const database = await temporaryMessageDatabase(async (connection, runtimePassword) => {
      await applyMessageSchema(connection, runtimePassword);

      await connection.query(
        'CREATE TABLE public."VerifiedNumber" (id integer PRIMARY KEY,phone_number text,email text,is_active boolean)',
      );
      await applyPlaygroundSchema(connection, password);
    });
    const url = new URL(database.url);
    url.username = 'ramesh_playground';
    url.password = password;
    const capture = new Pool({ connectionString: url.toString(), ssl: false, max: 2 });
    try {
      const ledger = new UsageLedgerRepository(capture, 'fixture-account', 'playground', 'capture');
      const request: UsageReservation = {
        id: randomUUID(),
        accountId: 'fixture-account',
        purpose: 'playground',
        runId: 'capture-run',
        stage: 'worker',
        model: 'fixture-model',
        operation: 'responses',
        attempt: 1,
        reservedMicros: 60,
        buckets: [{ key: 'org:day:fixture', limitMicros: 100 }],
        enforce: true,
      };
      await ledger.reserve(request);
      await ledger.settle(request.id, { state: 'settled', actualMicros: 30, durationMs: 200 });
      const summary = await ledger.summarize(request.accountId, request.purpose, request.runId);
      assert.equal(summary.knownActualMicros, 30);
      assert.equal(summary.costComplete, true);
      assert.equal(
        (
          await database.admin.query(
            'SELECT attempt FROM public."ramesh-test-usage-requests" WHERE id=$1',
            [request.id],
          )
        ).rows[0].attempt,
        '1',
      );
      assert.equal(
        (await database.admin.query('SELECT * FROM public."ramesh-usage-requests"')).rowCount,
        0,
      );
      for (const suffix of ['requests', 'buckets']) {
        await assert.rejects(
          capture.query(`SELECT * FROM public."ramesh-usage-${suffix}"`),
          /permission denied/,
        );
        await assert.rejects(
          database.runtime.query(`SELECT * FROM public."ramesh-test-usage-${suffix}"`),
          /permission denied/,
        );
        assert.equal(
          (await capture.query(`SELECT * FROM public."ramesh-test-usage-${suffix}"`)).rowCount,
          0,
        );
      }
      assert.throws(
        () => new UsageLedgerRepository(capture, 'fixture-account', 'production', 'capture'),
        /USAGE_SCOPE_MISMATCH/,
      );
    } finally {
      await capture.end();
      await database.close();
    }
  },
);
