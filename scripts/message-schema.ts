/** Additive, checksum-verified migrations for bot tables; never runs Prisma against Supabase. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';

export const MESSAGE_SCHEMA_VERSION = '202610010001';

/** dotenv expands \n itself; normalize an already-escaped CA before quoting it again. */
export function messageRuntimeEnv(url: string, ca = ''): string {
  return `MESSAGE_DATABASE_URL=${JSON.stringify(url)}\nMESSAGE_DB_SSL_CA=${JSON.stringify(ca.replaceAll('\\n', '\n'))}\nMESSAGE_ACCOUNT_ID=primary\nMESSAGE_QUEUE_POLL_MS=5000\n`;
}

export async function applyMessageSchema(db: PoolClient, password: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(password)) throw new Error('INVALID_RUNTIME_PASSWORD');
  const role = (
    await db.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,
    EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships
    FROM pg_roles r WHERE rolname='ramesh_worker'`)
  ).rows[0];
  if (!role)
    await db.query(`CREATE ROLE ramesh_worker LOGIN PASSWORD '${password}'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  else if (Object.values(role).some((value) => value !== false))
    throw new Error('EXISTING_RUNTIME_ROLE_UNSAFE');
  const sql = await readFile(
    new URL('../supabase/migrations/202610010001_message_queue.sql', import.meta.url),
    'utf8',
  );
  const checksum = createHash('sha256').update(sql).digest('hex');
  const exists = (
    await db.query(`SELECT to_regclass('public."ramesh-schema-migrations"') AS table_name`)
  ).rows[0].table_name;
  if (exists) {
    const row = (
      await db.query(`SELECT checksum FROM public."ramesh-schema-migrations" WHERE version=$1`, [
        MESSAGE_SCHEMA_VERSION,
      ])
    ).rows[0];
    if (row?.checksum !== checksum) throw new Error('MESSAGE_MIGRATION_CHECKSUM_MISMATCH');
    return;
  }
  await db.query(sql);
  await db.query(
    `INSERT INTO public."ramesh-schema-migrations" (version,checksum) VALUES ($1,$2)`,
    [MESSAGE_SCHEMA_VERSION, checksum],
  );
}
