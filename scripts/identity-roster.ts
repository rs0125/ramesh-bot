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
  const verified = (
    await db.query(`SELECT bool_and(has_column_privilege('ramesh_worker', 'public."VerifiedNumber"', name, 'SELECT')) AS allowed
    FROM unnest(ARRAY['id','phone_number','email','is_active']) AS columns(name)`)
  ).rows[0];
  if (!verified?.allowed) throw new Error('ROSTER_PERMISSION_CHECK_FAILED');
}
