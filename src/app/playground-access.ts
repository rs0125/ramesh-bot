/** Operator-authorized test identity. No WhatsApp message, device database or user OAuth grant. */
import type { Pool } from 'pg';
import type { LivePlaygroundConfig } from '../config/playground.js';
import { PostgresEmployeeRoster } from '../infrastructure/database/employee-roster.js';
import { EmployeeIdentityResolver } from '../modules/identity/employee-identity.js';
import { SignedEmployeeCredentials } from '../infrastructure/context-engine/request-credentials.js';
import { BusinessReadService } from '../modules/assistant/business-reads.js';
import { scopedCrmReader } from './scoped-crm-reader.js';

export function createPlaygroundAccess(config: LivePlaygroundConfig, pool: Pool) {
  const identities = new EmployeeIdentityResolver(new PostgresEmployeeRoster(pool));
  const credentials = new SignedEmployeeCredentials(config.context, identities, config.signing);
  const employee = (signal: AbortSignal) => identities.resolveEmployee(config.employeeId, signal);
  const reads = new BusinessReadService(
    async (key, signal) => {
      const actor = await employee(signal);
      if (!actor || key.remoteJid !== `${actor.phoneE164.slice(1)}@s.whatsapp.net`) return null;
      return scopedCrmReader(config.context, credentials, actor, {
        phoneE164: actor.phoneE164,
        audience: 'dm',
      });
    },
    [config.employeeId],
    Date.now,
    true,
  );
  return { employee, reads };
}
