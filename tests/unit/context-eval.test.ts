import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { readonlyRoster } from '../../evals/lib/readonly-roster.js';

test('live context eval refuses database writes and wraps the only roster SELECT in a read-only transaction', async () => {
  const calls: string[] = [];
  const pool = {
    async connect() {
      return {
        async query(sql: string) {
          calls.push(sql);
          return { rows: [], rowCount: 0 };
        },
        release() {
          calls.push('release');
        },
      };
    },
  } as unknown as Pool;
  const guarded = readonlyRoster(pool);
  await assert.rejects(
    guarded.query('UPDATE public."VerifiedNumber" SET is_active=false', []),
    /EVAL_DATABASE_WRITE_REFUSED/,
  );
  assert.deepEqual(calls, []);
  const select =
    'SELECT id, phone_number, email, is_active FROM public."VerifiedNumber" WHERE id=$1 LIMIT 2';
  await guarded.query(select, [1]);
  assert.deepEqual(calls, ['BEGIN READ ONLY', select, 'ROLLBACK', 'release']);
  await assert.rejects(
    guarded.query(`${select};DELETE FROM records`, [1]),
    /EVAL_DATABASE_WRITE_REFUSED/,
  );
});
