/** Roster identity is application-owned. Message text, display names and model arguments never establish it. */
import { ContextEngineError } from '../context-engine/context.types.js';

export interface RosterEmployee {
  id: number;
  phone_number: string;
  email: string | null;
  is_active: boolean;
}
export interface EmployeeRoster {
  byPhone(phoneE164: string, signal: AbortSignal): Promise<RosterEmployee[]>;
  byId(employeeId: number, signal: AbortSignal): Promise<RosterEmployee[]>;
}
export interface EmployeeIdentity {
  employeeId: number;
  phoneE164: string;
  email: string | null;
  active: boolean;
}

export const isE164 = (phone: string) => /^\+[1-9]\d{7,14}$/.test(phone);

/** Matches the WAG roster's country-prefixed storage and its legacy Indian national format.
 * Only roster records use the India fallback. Transport JIDs must already include a country code.
 */
export function rosterPhone(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\+?[0-9(). -]{8,40}$/.test(value.trim())) return null;
  const raw = value.trim();
  let digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) {
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 10) digits = `91${digits}`;
  }
  return isE164(`+${digits}`) ? `+${digits}` : null;
}

function identity(rows: RosterEmployee[]): EmployeeIdentity | null {
  const row = rows[0];
  if (rows.length !== 1 || !row || !Number.isSafeInteger(row.id) || row.id <= 0) return null;
  const phoneE164 = rosterPhone(row.phone_number);
  if (!phoneE164 || typeof row.is_active !== 'boolean') return null;
  const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : null;
  return { employeeId: row.id, phoneE164, email, active: row.is_active };
}

export class EmployeeIdentityResolver {
  constructor(private readonly roster: EmployeeRoster) {}

  /** Includes inactive matches so the credential layer can persist offboarding denial. */
  async lookupPhone(phoneE164: string, signal: AbortSignal): Promise<EmployeeIdentity | null> {
    if (!isE164(phoneE164)) return null;
    signal.throwIfAborted();
    const found = identity(await this.roster.byPhone(phoneE164, signal));
    signal.throwIfAborted();
    return found?.phoneE164 === phoneE164 ? found : null;
  }

  async resolvePhone(phoneE164: string, signal: AbortSignal): Promise<EmployeeIdentity | null> {
    const found = await this.lookupPhone(phoneE164, signal);
    return found?.active ? found : null;
  }

  async resolveEmployee(employeeId: number, signal: AbortSignal): Promise<EmployeeIdentity | null> {
    if (!Number.isSafeInteger(employeeId) || employeeId <= 0) return null;
    signal.throwIfAborted();
    const found = identity(await this.roster.byId(employeeId, signal));
    if (!found?.active || found.employeeId !== employeeId) return null;
    // A unique raw phone column can still contain two differently formatted copies of one number.
    const unique = await this.resolvePhone(found.phoneE164, signal);
    return unique?.employeeId === employeeId && unique.email === found.email ? unique : null;
  }
}

export function requireEmployeeEmail(employee: EmployeeIdentity): string {
  if (!employee.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.email))
    throw new ContextEngineError('AUTH_REQUIRED');
  return employee.email;
}
