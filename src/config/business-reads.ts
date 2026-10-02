/** Explicit enable switch; active employees use their existing Context permissions. Existing Context settings alone never enable business tools. */
import { loadContextEngineConfig, type ContextEngineConfig } from './context-engine.js';
import {
  loadContextSigningConfig,
  type ContextSigningConfig,
} from '../infrastructure/context-engine/request-credentials.js';

export interface BusinessReadConfig {
  employeeIds: number[] | 'all';
  context: ContextEngineConfig;
  signing: ContextSigningConfig;
}

export function loadBusinessReadConfig(env: NodeJS.ProcessEnv): BusinessReadConfig | undefined {
  if (env.BUSINESS_READS_ENABLED === undefined || env.BUSINESS_READS_ENABLED === 'false')
    return undefined;
  if (env.BUSINESS_READS_ENABLED !== 'true')
    throw new Error('BUSINESS_READS_ENABLED must be true or false');
  const raw = env.BUSINESS_READ_EMPLOYEE_IDS?.trim() || 'all';
  if (raw !== 'all' && !/^[1-9]\d*(,[1-9]\d*)*$/.test(raw))
    throw new Error('BUSINESS_READ_EMPLOYEE_IDS must be all or a list of employee IDs');
  const employeeIds = raw === 'all' ? 'all' : raw.split(',').map(Number);
  if (
    employeeIds !== 'all' &&
    (employeeIds.length > 100 ||
      employeeIds.some((id) => !Number.isSafeInteger(id)) ||
      new Set(employeeIds).size !== employeeIds.length)
  )
    throw new Error('Invalid business-read pilot employee list');
  const context = loadContextEngineConfig(env);
  const signing = loadContextSigningConfig(env);
  if (!context || !signing || !context.endpoint.endsWith('/mcp/ramesh'))
    throw new Error('WhatsApp business reads require signed Context Engine access at /mcp/ramesh');
  return { employeeIds, context, signing };
}
