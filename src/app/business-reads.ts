/** Explicit production composition; tests inject a synthetic resolver instead of this factory. */
import type { PrismaClient } from '@prisma/client';
import type { Pool } from 'pg';
import type { BusinessReadConfig } from '../config/business-reads.js';
import { PostgresEmployeeRoster } from '../infrastructure/database/employee-roster.js';
import { BusinessReadService } from '../modules/assistant/business-reads.js';
import { createSignedEmployeeContextAccess } from './context-engine.js';
import { scopedCrmReader } from './scoped-crm-reader.js';

export function createBusinessReads(
  config: BusinessReadConfig,
  db: PrismaClient,
  pool: Pool,
  encryptionKey: string,
) {
  const access = createSignedEmployeeContextAccess(config.context, {
    db,
    encryptionKey,
    roster: new PostgresEmployeeRoster(pool),
    signing: config.signing,
  });
  return new BusinessReadService(
    async (key, signal) => {
      const resolved = await access.whatsapp.resolve({ key }, signal);
      if (!resolved || resolved.sender.audience !== 'dm') return null;
      return scopedCrmReader(
        config.context,
        access.credentials,
        resolved.employee,
        resolved.sender,
      );
    },
    config.employeeIds,
    Date.now,
    true,
  );
}
