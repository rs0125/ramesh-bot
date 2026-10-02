/** Explicit operator setup for the live-data capture harness. Prints no source credentials or CRM rows. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { messagePoolOptions } from '../src/infrastructure/database/message-pool.js';
import { PlaygroundRepository } from '../src/infrastructure/database/playground.repository.js';
import { EmployeeIdentityResolver } from '../src/modules/identity/employee-identity.js';
import { PostgresEmployeeRoster } from '../src/infrastructure/database/employee-roster.js';
import { loadLivePlaygroundConfig } from '../src/config/playground.js';
import { applyPlaygroundSchema } from './playground-schema.js';
import { privateEnvironment } from './lib/private-env.js';

async function main() {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      'model-env-file': { type: 'string' },
      'signing-key-file': { type: 'string' },
      'context-url': { type: 'string' },
      'employee-id': { type: 'string' },
      'employee-label': { type: 'string' },
      'output-file': { type: 'string', default: '.local/live-playground.env' },
      apply: { type: 'boolean', default: false },
    },
  });
  if (!values['env-file'] || !values['model-env-file'] || !values['signing-key-file'])
    throw new Error('EXPLICIT_PRIVATE_SOURCE_FILES_REQUIRED');
  const output = resolve(values['output-file']!);
  if (
    [values['env-file'], values['model-env-file'], values['signing-key-file']].some(
      (p) => resolve(p) === output,
    )
  )
    throw new Error('SEPARATE_OUTPUT_FILE_REQUIRED');
  const admin = parse(await readFile(resolve(values['env-file'])));
  const model = parse(await readFile(resolve(values['model-env-file'])));
  const signing = await readFile(resolve(values['signing-key-file']), 'utf8');
  const adminUrl = new URL(admin.MESSAGE_ADMIN_DATABASE_URL ?? admin.DATABASE_URL ?? '');
  const ca = admin.MESSAGE_DB_SSL_CA ?? admin.PG_SSL_CA;
  let previous: Record<string, string> = {};
  try {
    previous = parse(await readFile(output));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const password = previous.PLAYGROUND_DATABASE_URL
    ? decodeURIComponent(new URL(previous.PLAYGROUND_DATABASE_URL).password)
    : randomBytes(32).toString('base64url');
  const runtime = new URL(adminUrl);
  const project = decodeURIComponent(adminUrl.username).split('.')[1];
  runtime.username = project ? `ramesh_playground.${project}` : 'ramesh_playground';
  runtime.password = password;
  runtime.search = '';
  const generated: Record<string, string> = {
    PLAYGROUND_DATABASE_URL: runtime.href,
    PLAYGROUND_DB_SSL_CA: ca ?? '',
    PLAYGROUND_NAMESPACE: previous.PLAYGROUND_NAMESPACE ?? randomUUID(),
    PLAYGROUND_ENCRYPTION_KEY:
      previous.PLAYGROUND_ENCRYPTION_KEY ?? randomBytes(32).toString('base64url'),
    PLAYGROUND_EMPLOYEE_ID: values['employee-id'] ?? '',
    PLAYGROUND_EMPLOYEE_LABEL: values['employee-label'] ?? '',
    CONTEXT_MCP_URL: values['context-url'] ?? '',
    CONTEXT_RAMESH_SIGNING_KEY_JSON: signing,
    OPENAI_API_KEY: model.OPENAI_API_KEY ?? '',
    OPENAI_MODEL: model.OPENAI_MODEL ?? 'gpt-5.6-terra',
  };
  for (const name of ['AGENT_TIMEOUT_MS', 'AGENT_MAX_OUTPUT_TOKENS'])
    if (model[name]) generated[name] = model[name]!;
  const config = loadLivePlaygroundConfig(generated);
  const serialized = privateEnvironment(generated);
  if (
    Object.keys(previous).length &&
    Object.entries(generated).some(([name, value]) => previous[name] !== value)
  )
    throw new Error('EXISTING_PLAYGROUND_CONFIG_DIFFERS_USE_NEW_OUTPUT_FILE');
  const pool = new Pool({ ...messagePoolOptions(adminUrl.href, ca), max: 1 });
  pool.on('error', () => {});
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='2000ms'");
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('ramesh:playground-migrations',0))",
    );
    const roleExists = (await db.query("SELECT 1 FROM pg_roles WHERE rolname='ramesh_playground'"))
      .rowCount;
    if (roleExists && !previous.PLAYGROUND_DATABASE_URL)
      throw new Error('EXISTING_ROLE_REQUIRES_ITS_RUNTIME_FILE');
    const employee = await new EmployeeIdentityResolver(
      new PostgresEmployeeRoster({ query: db.query.bind(db) } as Pick<Pool, 'query'>),
    ).resolveEmployee(config.employeeId, AbortSignal.timeout(10000));
    if (!employee) throw new Error('ACTIVE_UNAMBIGUOUS_EMPLOYEE_REQUIRED');
    await applyPlaygroundSchema(db, password);
    if (values.apply && !previous.PLAYGROUND_DATABASE_URL) {
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, serialized, { mode: 0o600, flag: 'wx' });
    }
    await db.query(values.apply ? 'COMMIT' : 'ROLLBACK');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release(true);
    await pool.end();
  }
  if (values.apply) {
    const verify = new Pool(messagePoolOptions(config.databaseUrl, config.ca));
    verify.on('error', () => {});
    try {
      await new PlaygroundRepository(
        verify,
        config.namespace,
        config.employeeId,
        config.encryptionKey,
      ).health();
      if (
        !(await new EmployeeIdentityResolver(new PostgresEmployeeRoster(verify)).resolveEmployee(
          config.employeeId,
          AbortSignal.timeout(10000),
        ))
      )
        throw new Error('PLAYGROUND_EMPLOYEE_NOT_VISIBLE_OR_AMBIGUOUS');
    } finally {
      await verify.end();
    }
  }
  console.log(
    JSON.stringify({
      checked: true,
      applied: values.apply,
      employeeId: config.employeeId,
      tables: [
        'ramesh-test-inbound-queue',
        'ramesh-test-outbound-queue',
        'ramesh-test-agent-events',
      ],
      runtimeRole: 'ramesh_playground',
      ...(values.apply ? { runtimeEnvFile: output } : {}),
    }),
  );
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  console.error(/^[A-Z_]+$/.test(message) ? message : 'PLAYGROUND_SETUP_FAILED');
  process.exitCode = 1;
});
