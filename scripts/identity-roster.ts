/** Grants only the roster columns needed to bind a phone to an active employee. No business-row writes. */
import type { PoolClient } from 'pg';

export async function grantIdentityRosterRead(db: PoolClient) {
  const role = (
    await db.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
    FROM pg_roles WHERE rolname='ramesh_worker'`)
  ).rows[0];
  if (!role || Object.values(role).some(Boolean)) throw new Error('SCOPED_RUNTIME_ROLE_REQUIRED');
  await db.query(
    'GRANT SELECT (id, phone_number, email, is_active) ON public."VerifiedNumber" TO ramesh_worker',
  );
  // The production roster enables RLS. Column grants alone silently expose no rows.
  // Add only this login's read policy; do not alter RLS or other applications' policies.
  const existing = (
    await db.query(`SELECT cmd, roles::text[] AS roles, qual, with_check FROM pg_policies
      WHERE schemaname='public' AND tablename='VerifiedNumber'
        AND policyname='ramesh_worker_identity_read'`)
  ).rows[0];
  if (existing) {
    if (
      existing.cmd !== 'SELECT' ||
      existing.roles.length !== 1 ||
      existing.roles[0] !== 'ramesh_worker' ||
      existing.qual !== 'true' ||
      existing.with_check !== null
    )
      throw new Error('ROSTER_POLICY_DIFFERS');
  } else {
    await db.query(
      'CREATE POLICY "ramesh_worker_identity_read" ON public."VerifiedNumber" FOR SELECT TO ramesh_worker USING (true)',
    );
  }
  const verified = (
    await db.query(`SELECT bool_and(has_column_privilege('ramesh_worker', 'public."VerifiedNumber"', name, 'SELECT')) AS allowed
    FROM unnest(ARRAY['id','phone_number','email','is_active']) AS columns(name)`)
  ).rows[0];
  if (!verified?.allowed) throw new Error('ROSTER_PERMISSION_CHECK_FAILED');
}
