/** Explicit operator provisioning, rolled back unless --apply is supplied. Never prints connection data or roster records. */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { messagePoolOptions } from '../src/infrastructure/database/message-pool.js';
import { grantIdentityRosterRead } from './identity-roster.js';

async function main() {
  const { values } = parseArgs({
    options: { 'env-file': { type: 'string' }, apply: { type: 'boolean', default: false } },
  });
  if (!values['env-file']) throw new Error('EXPLICIT_ADMIN_ENV_FILE_REQUIRED');
  const source = parse(await readFile(values['env-file']));
  const pool = new Pool({
    ...messagePoolOptions(
      source.MESSAGE_ADMIN_DATABASE_URL ?? source.DATABASE_URL ?? '',
      source.MESSAGE_DB_SSL_CA ?? source.PG_SSL_CA,
    ),
    max: 1,
  });
  pool.on('error', () => {});
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='2000ms'");
    await grantIdentityRosterRead(db);
    await db.query(values.apply ? 'COMMIT' : 'ROLLBACK');
    console.log(
      JSON.stringify({
        checked: true,
        applied: values.apply,
        role: 'ramesh_worker',
        table: 'VerifiedNumber',
        columns: ['id', 'phone_number', 'email', 'is_active'],
      }),
    );
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release(true);
    await pool.end();
  }
}
main().catch(() => {
  console.error('IDENTITY_ROSTER_SETUP_FAILED');
  process.exitCode = 1;
});
