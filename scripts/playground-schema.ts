/** Independently provision the capture schema; never invoke the production message migrations. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';

export const PLAYGROUND_SCHEMA_VERSION = '202610020002';
export async function applyPlaygroundSchema(db: PoolClient, password: string) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw new Error('INVALID_PLAYGROUND_PASSWORD');
  const existing = (
    await db.query(
      `SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname='ramesh_playground'`,
    )
  ).rows[0];
  if (existing && Object.values(existing).some(Boolean))
    throw new Error('UNSAFE_EXISTING_PLAYGROUND_ROLE');
  if (!existing) {
    const sql = (
      await db.query(
        "SELECT format('CREATE ROLE ramesh_playground LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text) AS sql",
        [password],
      )
    ).rows[0].sql;
    await db.query(sql);
  }
  const membership = await db.query(
    `SELECT 1 FROM pg_auth_members WHERE member='ramesh_playground'::regrole`,
  );
  if (membership.rowCount) throw new Error('PLAYGROUND_ROLE_MUST_NOT_HAVE_MEMBERSHIPS');
  await db.query('GRANT USAGE ON SCHEMA public TO ramesh_playground');
  await db.query(
    'GRANT SELECT (id,phone_number,email,is_active) ON public."VerifiedNumber" TO ramesh_playground',
  );
  // The live roster has RLS enabled. Column grants alone do not make employees visible.
  // Preserve existing roles' policies and RLS settings; this policy grants no write access.
  if (
    !(
      await db.query(
        `SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='VerifiedNumber' AND policyname='ramesh_playground_identity_read'`,
      )
    ).rowCount
  )
    await db.query(
      'CREATE POLICY "ramesh_playground_identity_read" ON public."VerifiedNumber" FOR SELECT TO ramesh_playground USING (true)',
    );
  await db.query(`CREATE TABLE IF NOT EXISTS public."ramesh-test-schema-migrations" (
    version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
  await db.query(
    'REVOKE ALL ON public."ramesh-test-schema-migrations" FROM PUBLIC,anon,authenticated,service_role,ramesh_worker',
  );
  await db.query('GRANT SELECT ON public."ramesh-test-schema-migrations" TO ramesh_playground');
  await db.query('ALTER TABLE public."ramesh-test-schema-migrations" ENABLE ROW LEVEL SECURITY');
  if (
    !(
      await db.query(
        `SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ramesh-test-schema-migrations' AND policyname='ramesh_test_schema_read'`,
      )
    ).rowCount
  )
    await db.query(
      'CREATE POLICY "ramesh_test_schema_read" ON public."ramesh-test-schema-migrations" FOR SELECT TO ramesh_playground USING (true)',
    );
  for (const name of ['202610020001_capture.sql', '202610020002_media_and_batches.sql']) {
    const version = name.split('_')[0]!;
    const sql = await readFile(new URL(`../supabase/playground/${name}`, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = (
      await db.query(
        'SELECT checksum FROM public."ramesh-test-schema-migrations" WHERE version=$1',
        [version],
      )
    ).rows[0];
    if (previous && previous.checksum !== checksum)
      throw new Error('PLAYGROUND_MIGRATION_CHECKSUM_MISMATCH');
    if (!previous) {
      await db.query(sql);
      await db.query(
        'INSERT INTO public."ramesh-test-schema-migrations" (version,checksum) VALUES ($1,$2)',
        [version, checksum],
      );
    }
  }
}
