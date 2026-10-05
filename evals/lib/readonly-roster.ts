/** Live evaluations get a SELECT-only roster port inside READ ONLY transactions. */
import type { Pool, QueryResult, QueryResultRow } from 'pg';
export function readonlyRoster(pool: Pool): Pick<Pool, 'query'> {
  const query = async <R extends QueryResultRow>(
    sql: string,
    values: unknown[],
  ): Promise<QueryResult<R>> => {
    if (
      !/^SELECT id, phone_number, email, is_active FROM public\."VerifiedNumber" WHERE /u.test(
        sql,
      ) ||
      /;/.test(sql)
    )
      throw new Error('EVAL_DATABASE_WRITE_REFUSED');
    const db = await pool.connect();
    let broken = false;
    try {
      await db.query('BEGIN READ ONLY');
      return await db.query<R>(sql, values);
    } finally {
      try {
        await db.query('ROLLBACK');
      } catch {
        broken = true;
      }
      db.release(broken);
    }
  };
  return { query: query as Pool['query'] };
}
