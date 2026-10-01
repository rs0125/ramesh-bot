/** Operator-only enrollment/credential management. Secrets and callbacks are read from protected files, never CLI arguments. */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { loadContextEngineConfig } from '../src/config/context-engine.js';
import { createEmployeeContextAccess } from '../src/app/context-engine.js';
import { createPrismaClient } from '../src/infrastructure/database/prisma.js';
import { messagePoolOptions } from '../src/infrastructure/database/message-pool.js';
import { PostgresEmployeeRoster } from '../src/infrastructure/database/employee-roster.js';
import { ContextEngineError } from '../src/modules/context-engine/context.types.js';
import type { ContextOAuthScope } from '../src/modules/context-engine/oauth.types.js';

async function privateFile(path: string, maxBytes: number) {
  const file = resolve(path),
    info = await stat(file);
  if (!info.isFile() || info.size > maxBytes || (info.mode & 0o077) !== 0)
    throw new ContextEngineError('INVALID_ARGUMENTS');
  return readFile(file, 'utf8');
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'env-file': { type: 'string' },
      'employee-id': { type: 'string' },
      'enrollment-id': { type: 'string' },
      'callback-file': { type: 'string' },
      scopes: { type: 'string', default: 'crm:read' },
    },
  });
  const action = positionals[0];
  if (
    positionals.length !== 1 ||
    !['begin', 'complete', 'status', 'revoke', 'retry-revocations'].includes(action ?? '') ||
    !values['env-file']
  )
    throw new ContextEngineError('INVALID_ARGUMENTS');
  const env = parse(await privateFile(values['env-file'], 65_536));
  const config = loadContextEngineConfig(env);
  if (
    !config ||
    !env.DATABASE_URL?.startsWith('file:/') ||
    !env.MESSAGE_DATABASE_URL ||
    !env.AUTH_ENCRYPTION_KEY
  )
    throw new ContextEngineError('NOT_CONFIGURED');
  const databaseUrl = new URL(env.MESSAGE_DATABASE_URL);
  if (decodeURIComponent(databaseUrl.username).split('.')[0] !== 'ramesh_worker')
    throw new ContextEngineError('NOT_CONFIGURED');
  const db = createPrismaClient(env.DATABASE_URL);
  const pool = new Pool(messagePoolOptions(env.MESSAGE_DATABASE_URL, env.MESSAGE_DB_SSL_CA));
  pool.on('error', () => {});
  try {
    const { credentials } = createEmployeeContextAccess(config, {
      db,
      encryptionKey: env.AUTH_ENCRYPTION_KEY,
      accountId: env.MESSAGE_ACCOUNT_ID ?? 'primary',
      roster: new PostgresEmployeeRoster(pool),
    });
    const employeeId = Number(values['employee-id']);
    if (
      ['begin', 'status', 'revoke'].includes(action!) &&
      (!Number.isSafeInteger(employeeId) || employeeId <= 0)
    )
      throw new ContextEngineError('INVALID_ARGUMENTS');
    let result: unknown;
    if (action === 'begin') {
      if (!env.CONTEXT_OAUTH_REDIRECT_URI) throw new ContextEngineError('NOT_CONFIGURED');
      result = await credentials.beginEnrollment(
        employeeId,
        env.CONTEXT_OAUTH_REDIRECT_URI,
        values.scopes!.split(',') as ContextOAuthScope[],
      );
    } else if (action === 'complete') {
      if (!values['enrollment-id'] || !values['callback-file'])
        throw new ContextEngineError('INVALID_ARGUMENTS');
      result = await credentials.completeEnrollment(
        values['enrollment-id'],
        (await privateFile(values['callback-file'], 4096)).trim(),
      );
    } else if (action === 'revoke') result = await credentials.revoke(employeeId);
    else if (action === 'retry-revocations') result = await credentials.retryRevocations();
    else result = await credentials.status(employeeId);
    // Begin prints a consent URL with public PKCE challenge/state; no access/refresh token or employee key.
    console.log(JSON.stringify(result));
  } finally {
    await db.$disconnect();
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error instanceof ContextEngineError ? error.message : 'CONTEXT_AUTH_FAILED');
  process.exitCode = 1;
});
