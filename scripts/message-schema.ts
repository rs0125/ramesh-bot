/** Ordered, checksum-verified migrations for bot tables; never runs Prisma against Supabase. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';

export const MESSAGE_SCHEMA_VERSION = '202610050001';
const migrations = [
  '202610010001_message_queue.sql',
  '202610010002_split_queues.sql',
  '202610010003_inbox.sql',
  '202610010004_agent_reads.sql',
  '202610020005_media_and_batches.sql',
  '202610020006_usage_ledger.sql',
  '202610030004_per_chat_queue.sql',
  '202610030005_agent_checkpoints.sql',
  '202610030006_outbound_automation.sql',
  '202610030007_personal_scheduling.sql',
  '202610030008_personal_context.sql',
  '202610030009_write_journal.sql',
  '202610040001_write_delivery_lookup.sql',
  '202610040002_reminder_source_quote.sql',
  '202610040003_investigation_stop.sql',
  '202610040004_reminder_replies.sql',
  '202610050001_conversation_context.sql',
];

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
  for (const name of migrations) {
    const version = name.split('_')[0];
    const sql = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const exists = (
      await db.query(`SELECT to_regclass('public."ramesh-schema-migrations"') AS name`)
    ).rows[0].name;
    const row = exists
      ? (
          await db.query(
            `SELECT checksum FROM public."ramesh-schema-migrations" WHERE version=$1`,
            [version],
          )
        ).rows[0]
      : undefined;
    if (row) {
      if (row.checksum !== checksum) throw new Error('MESSAGE_MIGRATION_CHECKSUM_MISMATCH');
      continue;
    }
    // An existing unversioned base schema must never be adopted or overwritten.
    if (exists && version === '202610010001')
      throw new Error('MESSAGE_MIGRATION_CHECKSUM_MISMATCH');
    await db.query(sql);
    await db.query(
      `INSERT INTO public."ramesh-schema-migrations" (version,checksum) VALUES ($1,$2)`,
      [version, checksum],
    );
  }
}
