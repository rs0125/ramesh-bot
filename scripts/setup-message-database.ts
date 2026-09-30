/** Provision only ramesh-owned state. Admin credentials are read from an explicit local env file. */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { messagePoolOptions } from '../src/infrastructure/database/message-pool.js';
import { applyMessageSchema, messageRuntimeEnv } from './message-schema.js';

async function main() {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      'output-file': { type: 'string', default: '.local/message-database.env' },
      apply: { type: 'boolean', default: false },
    },
  });
  if (!values['env-file']) throw new Error('EXPLICIT_ADMIN_ENV_FILE_REQUIRED');
  const source = parse(await readFile(resolve(values['env-file'])));
  const adminUrl = new URL(source.MESSAGE_ADMIN_DATABASE_URL ?? source.DATABASE_URL ?? '');
  const ca = source.MESSAGE_DB_SSL_CA ?? source.PG_SSL_CA;
  const output = resolve(values['output-file']!);
  if (output === resolve(values['env-file'])) throw new Error('SEPARATE_OUTPUT_FILE_REQUIRED');
  let runtime: Record<string, string> = {};
  try {
    runtime = parse(await readFile(output));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const password = runtime.MESSAGE_DATABASE_URL
    ? decodeURIComponent(new URL(runtime.MESSAGE_DATABASE_URL).password)
    : randomBytes(32).toString('base64url');
  const url = new URL(adminUrl);
  const project = decodeURIComponent(url.username).split('.')[1];
  url.username = project ? `ramesh_worker.${project}` : 'ramesh_worker';
  url.password = password;
  url.search = '';
  if (
    runtime.MESSAGE_DATABASE_URL &&
    new URL(runtime.MESSAGE_DATABASE_URL).toString() !== url.toString()
  )
    throw new Error('EXISTING_RUNTIME_DESTINATION_DIFFERS');
  const pool = new Pool({ ...messagePoolOptions(adminUrl.toString(), ca), max: 1 });
  pool.on('error', () => {});
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='2000ms'");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('ramesh:migrations',0))");
    const roleExists = (await db.query("SELECT 1 FROM pg_roles WHERE rolname='ramesh_worker'"))
      .rowCount;
    if (roleExists && !runtime.MESSAGE_DATABASE_URL)
      throw new Error('EXISTING_ROLE_REQUIRES_ITS_RUNTIME_FILE');
    // Keep a recovery copy before committing a new login, without overwriting secrets.
    if (values.apply && !runtime.MESSAGE_DATABASE_URL) {
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, messageRuntimeEnv(url.toString(), ca), { mode: 0o600, flag: 'wx' });
    }
    await applyMessageSchema(db, password);
    await db.query(values.apply ? 'COMMIT' : 'ROLLBACK');
    console.log(
      JSON.stringify({
        applied: values.apply,
        checked: true,
        tables: [
          'ramesh-messages',
          'ramesh-message-jobs',
          'ramesh-message-events',
          'ramesh-schema-migrations',
        ],
        runtimeRole: 'ramesh_worker',
        ...(values.apply ? { runtimeEnvFile: output } : {}),
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

main().catch((error) => {
  // Do not print URLs, SQL, connection credentials, or raw database error details.
  console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'MESSAGE_DATABASE_SETUP_FAILED');
  process.exitCode = 1;
});
