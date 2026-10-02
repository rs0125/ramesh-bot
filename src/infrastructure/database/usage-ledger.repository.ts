/** Account-scoped monetary reservations. Transactions never span a provider request. */
import type { Pool, PoolClient } from 'pg';
import {
  assertUsageAdmission,
  normalizeReservation,
  normalizeSettlement,
  summarizeUsage,
  UsageConflictError,
  validateUsageScope,
  type UsageLedger,
  type UsagePurpose,
  type UsageRecord,
  type UsageReservation,
  type UsageSettlement,
  type UsageSummary,
} from '../../modules/usage/usage.types.js';

export class UsageLedgerRepository implements UsageLedger {
  private readonly requests: string;
  private readonly buckets: string;

  constructor(
    private readonly pool: Pool,
    private readonly accountId: string,
    private readonly purpose: UsagePurpose,
    namespace: 'production' | 'capture' = 'production',
  ) {
    validateUsageScope(accountId, purpose);
    if (!['production', 'capture'].includes(namespace)) throw new Error('INVALID_USAGE_NAMESPACE');
    if (namespace === 'capture' && purpose === 'production')
      throw new Error('USAGE_SCOPE_MISMATCH');
    this.requests =
      namespace === 'capture'
        ? 'public."ramesh-test-usage-requests"'
        : 'public."ramesh-usage-requests"';
    this.buckets =
      namespace === 'capture'
        ? 'public."ramesh-test-usage-buckets"'
        : 'public."ramesh-usage-buckets"';
  }

  async reserve(input: UsageReservation): Promise<void> {
    const reservation = normalizeReservation(input);
    this.assertScope(reservation.accountId, reservation.purpose);
    try {
      await this.transaction(async (db) => {
        const previous = (
          await db.query(
            `SELECT reservation FROM ${this.requests}
           WHERE id=$1 AND account_id=$2 AND purpose=$3`,
            [reservation.id, this.accountId, this.purpose],
          )
        ).rows[0];
        if (previous) {
          if (
            JSON.stringify(normalizeReservation(previous.reservation)) !==
            JSON.stringify(reservation)
          )
            throw new UsageConflictError('USAGE_RESERVATION_CONFLICT');
          return;
        }
        const consumption = new Map<string, { micros: bigint; unpriced: number }>();
        if (reservation.enforce && reservation.buckets.length) {
          const totals = await db.query(
            `SELECT b.bucket_key,
                    coalesce(sum(coalesce(r.actual_micros,r.reserved_micros)),0)::text AS micros,
                    count(*) FILTER(WHERE r.actual_micros IS NULL AND r.reserved_micros IS NULL)::int AS unpriced
             FROM ${this.buckets} b JOIN ${this.requests} r
               ON r.id=b.request_id AND r.account_id=b.account_id AND r.purpose=b.purpose
             WHERE b.account_id=$1 AND b.purpose=$2 AND b.bucket_key=ANY($3::text[])
             GROUP BY b.bucket_key`,
            [this.accountId, this.purpose, reservation.buckets.map((bucket) => bucket.key)],
          );
          for (const row of totals.rows)
            consumption.set(row.bucket_key, { micros: BigInt(row.micros), unpriced: row.unpriced });
        }
        assertUsageAdmission(reservation, consumption);
        await db.query(
          `INSERT INTO ${this.requests}
             (id,account_id,purpose,run_id,reserved_micros,reservation,attempt)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [
            reservation.id,
            this.accountId,
            this.purpose,
            reservation.runId,
            reservation.reservedMicros,
            JSON.stringify(reservation),
            reservation.attempt ?? 0,
          ],
        );
        if (reservation.buckets.length)
          await db.query(
            `INSERT INTO ${this.buckets} (request_id,account_id,purpose,bucket_key)
           SELECT $1,$2,$3,unnest($4::text[])`,
            [
              reservation.id,
              this.accountId,
              this.purpose,
              reservation.buckets.map((bucket) => bucket.key),
            ],
          );
      });
    } catch (error) {
      // An ID reused under another scope is hidden by RLS and still cannot be reused.
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
        throw new UsageConflictError('USAGE_RESERVATION_CONFLICT');
      throw error;
    }
  }

  async settle(id: string, input: UsageSettlement): Promise<void> {
    const settlement = normalizeSettlement(input);
    await this.transaction(async (db) => {
      const previous = (
        await db.query(
          `SELECT settlement FROM ${this.requests}
         WHERE id=$1 AND account_id=$2 AND purpose=$3 FOR UPDATE`,
          [id, this.accountId, this.purpose],
        )
      ).rows[0];
      if (!previous) throw new UsageConflictError('USAGE_RESERVATION_NOT_FOUND');
      if (previous.settlement) {
        if (JSON.stringify(normalizeSettlement(previous.settlement)) !== JSON.stringify(settlement))
          throw new UsageConflictError('USAGE_SETTLEMENT_CONFLICT');
        return;
      }
      await db.query(
        `UPDATE ${this.requests}
         SET state=$4,actual_micros=$5,settlement=$6::jsonb,settled_at=clock_timestamp()
         WHERE id=$1 AND account_id=$2 AND purpose=$3`,
        [
          id,
          this.accountId,
          this.purpose,
          settlement.state,
          settlement.actualMicros,
          JSON.stringify(settlement),
        ],
      );
    });
  }

  async summarize(accountId: string, purpose: UsagePurpose, runId: string): Promise<UsageSummary> {
    this.assertScope(accountId, purpose);
    return this.transaction(async (db) => {
      const result = await db.query(
        `SELECT reservation,settlement FROM ${this.requests}
         WHERE account_id=$1 AND purpose=$2 AND run_id=$3`,
        [this.accountId, this.purpose, runId],
      );
      return summarizeUsage(
        result.rows.map(
          (row): UsageRecord => ({
            reservation: normalizeReservation(row.reservation),
            ...(row.settlement ? { settlement: normalizeSettlement(row.settlement) } : {}),
          }),
        ),
      );
    });
  }

  private assertScope(accountId: string, purpose: UsagePurpose): void {
    if (this.accountId !== accountId || this.purpose !== purpose)
      throw new Error('USAGE_SCOPE_MISMATCH');
  }

  private async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await db.query(
        `SELECT set_config('ramesh.usage_account',$1,true),set_config('ramesh.usage_purpose',$2,true)`,
        [this.accountId, this.purpose],
      );
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        JSON.stringify(['ramesh-usage', this.accountId, this.purpose]),
      ]);
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }
}
