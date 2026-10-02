/** Live playground is a separate process, login, namespace and encryption key. No production fallback. */
import { z } from 'zod';
import { loadAssistantConfig } from './assistant.js';
import { loadContextEngineConfig } from './context-engine.js';
import { loadContextSigningConfig } from '../infrastructure/context-engine/request-credentials.js';

export function loadLivePlaygroundConfig(env: NodeJS.ProcessEnv) {
  const model = loadAssistantConfig(env);
  const context = loadContextEngineConfig(env);
  const signing = loadContextSigningConfig(env);
  if (
    !model ||
    !context ||
    !signing ||
    !context.endpoint.endsWith('/mcp/ramesh') ||
    !signing.scopes.includes('crm:read')
  )
    throw new Error('PLAYGROUND_MODEL_AND_SIGNED_CONTEXT_REQUIRED');
  let url: URL;
  try {
    url = new URL(env.PLAYGROUND_DATABASE_URL ?? '');
  } catch {
    throw new Error('PLAYGROUND_DATABASE_REQUIRED');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    decodeURIComponent(url.username).split('.')[0] !== 'ramesh_playground'
  )
    throw new Error('PLAYGROUND_DEDICATED_LOGIN_REQUIRED');
  const namespace = z.uuid().parse(env.PLAYGROUND_NAMESPACE);
  const employeeId = z.coerce.number().int().positive().safe().parse(env.PLAYGROUND_EMPLOYEE_ID);
  const employeeLabel = z.string().trim().min(1).max(80).parse(env.PLAYGROUND_EMPLOYEE_LABEL);
  const encryptionKey = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .parse(env.PLAYGROUND_ENCRYPTION_KEY);
  if (Buffer.from(encryptionKey, 'base64url').toString('base64url') !== encryptionKey)
    throw new Error('INVALID_PLAYGROUND_ENCRYPTION_KEY');
  const port = z.coerce
    .number()
    .int()
    .min(1024)
    .max(65535)
    .parse(env.PLAYGROUND_PORT ?? '3012');
  return {
    model,
    context,
    signing,
    databaseUrl: url.href,
    ca: env.PLAYGROUND_DB_SSL_CA,
    namespace,
    employeeId,
    employeeLabel,
    encryptionKey,
    port,
  };
}
export type LivePlaygroundConfig = ReturnType<typeof loadLivePlaygroundConfig>;
