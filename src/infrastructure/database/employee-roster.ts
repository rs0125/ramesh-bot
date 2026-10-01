/** Minimal, parameterized reads of the live VerifiedNumber roster; never caches employee authorization. */
import type { Pool } from 'pg';
import type { EmployeeRoster, RosterEmployee } from '../../modules/identity/employee-identity.js';
import { ContextEngineError } from '../../modules/context-engine/context.types.js';

export class PostgresEmployeeRoster implements EmployeeRoster {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  private async read(where: string, values: unknown[], signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      const result = await this.pool.query<RosterEmployee>(
        `SELECT id, phone_number, email, is_active FROM public."VerifiedNumber" WHERE ${where} LIMIT 2`,
        values,
      );
      signal.throwIfAborted();
      return result.rows;
    } catch {
      throw new ContextEngineError(signal.aborted ? 'CANCELLED' : 'UNAVAILABLE', !signal.aborted);
    }
  }

  byPhone(phoneE164: string, signal: AbortSignal) {
    const digits = phoneE164.slice(1);
    const variants = [digits];
    if (/^91\d{10}$/.test(digits)) variants.push(digits.slice(2), `0${digits.slice(2)}`);
    return this.read(
      `phone_number ~ '^[+0-9(). -]{8,40}$' AND regexp_replace(phone_number, '[^0-9]', '', 'g') = ANY($1::text[])`,
      [variants],
      signal,
    );
  }

  byId(employeeId: number, signal: AbortSignal) {
    return this.read('id = $1', [employeeId], signal);
  }
}
