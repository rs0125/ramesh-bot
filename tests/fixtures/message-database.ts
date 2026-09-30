/** Real PostgreSQL tests are restricted to an explicitly named local test database. */
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { applyMessageSchema } from '../../scripts/message-schema.js';

export const postgresTestsEnabled = !!process.env.TEST_MESSAGE_DATABASE_URL;

export async function temporaryMessageDatabase() {
  const url = new URL(process.env.TEST_MESSAGE_DATABASE_URL ?? '');
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/ramesh_queue_test'
  )
    throw new Error(
      'Queue tests require the local ramesh_queue_test database; remote databases are refused',
    );
  const control = new Pool({ connectionString: url.toString(), ssl: false, max: 1 });
  const name = `ramesh_test_${randomBytes(8).toString('hex')}`;
  await control.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const admin = new Pool({ connectionString: url.toString(), ssl: false, max: 2 });
  const password = 'ramesh_queue_tests_password_1234567890';
  const db = await admin.connect();
  try {
    await db.query('BEGIN');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!(await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount)
        await db.query(`CREATE ROLE ${role} NOLOGIN`);
      await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${role}`);
    }
    await db.query('CREATE TABLE public.unrelated_crm_guard (id integer)');
    await applyMessageSchema(db, password);
    await db.query('COMMIT');
  } finally {
    db.release();
  }
  url.username = 'ramesh_worker';
  url.password = password;
  const runtime = new Pool({ connectionString: url.toString(), ssl: false, max: 2 });
  return {
    admin,
    runtime,
    url: url.toString(),
    async close() {
      await runtime.end();
      await admin.end();
      await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await control.end();
    },
  };
}
