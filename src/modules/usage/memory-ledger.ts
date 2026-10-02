/** In-process ledger for offline/local evaluations; production uses the PostgreSQL ledger. */
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
} from './usage.types.js';

export class MemoryUsageLedger implements UsageLedger {
  private readonly records = new Map<string, UsageRecord>();

  constructor(
    private readonly accountId?: string,
    private readonly purpose?: UsagePurpose,
  ) {
    if ((accountId === undefined) !== (purpose === undefined))
      throw new Error('INVALID_USAGE_SCOPE');
    if (accountId !== undefined) validateUsageScope(accountId, purpose!);
  }

  async reserve(input: UsageReservation): Promise<void> {
    const reservation = normalizeReservation(input);
    this.assertScope(reservation.accountId, reservation.purpose);
    const previous = this.records.get(reservation.id);
    if (previous) {
      if (JSON.stringify(previous.reservation) !== JSON.stringify(reservation))
        throw new UsageConflictError('USAGE_RESERVATION_CONFLICT');
      return;
    }
    const consumption = new Map<string, { micros: bigint; unpriced: number }>();
    for (const { reservation: held, settlement } of this.records.values()) {
      if (held.accountId !== reservation.accountId || held.purpose !== reservation.purpose)
        continue;
      const amount = settlement?.actualMicros ?? held.reservedMicros;
      for (const bucket of held.buckets) {
        const total = consumption.get(bucket.key) ?? { micros: 0n, unpriced: 0 };
        if (amount === null) total.unpriced++;
        else total.micros += BigInt(amount);
        consumption.set(bucket.key, total);
      }
    }
    assertUsageAdmission(reservation, consumption);
    // There is deliberately no await between admission and insertion.
    this.records.set(reservation.id, { reservation });
  }

  async settle(id: string, input: UsageSettlement): Promise<void> {
    const settlement = normalizeSettlement(input);
    const record = this.records.get(id.toLowerCase());
    if (!record) throw new UsageConflictError('USAGE_RESERVATION_NOT_FOUND');
    this.assertScope(record.reservation.accountId, record.reservation.purpose);
    if (record.settlement) {
      if (JSON.stringify(record.settlement) !== JSON.stringify(settlement))
        throw new UsageConflictError('USAGE_SETTLEMENT_CONFLICT');
      return;
    }
    record.settlement = settlement;
  }

  async summarize(accountId: string, purpose: UsagePurpose, runId: string): Promise<UsageSummary> {
    this.assertScope(accountId, purpose);
    return summarizeUsage(
      [...this.records.values()].filter(
        ({ reservation }) =>
          reservation.accountId === accountId &&
          reservation.purpose === purpose &&
          reservation.runId === runId,
      ),
    );
  }

  private assertScope(accountId: string, purpose: UsagePurpose): void {
    validateUsageScope(accountId, purpose);
    if (this.accountId !== undefined && (this.accountId !== accountId || this.purpose !== purpose))
      throw new Error('USAGE_SCOPE_MISMATCH');
  }
}
