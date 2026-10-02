/** Operator-only source readiness. No model, application startup, queue writer or WhatsApp sender. */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { loadConfig } from '../src/config/env.js';
import { createBusinessAccessResolver } from '../src/app/business-reads.js';
import { createPrismaClient } from '../src/infrastructure/database/prisma.js';
import { messagePoolOptions } from '../src/infrastructure/database/message-pool.js';
import { PostgresEmployeeRoster } from '../src/infrastructure/database/employee-roster.js';
import { EmployeeIdentityResolver } from '../src/modules/identity/employee-identity.js';
import {
  CapabilityProbeError,
  capabilityErrorCode,
  capabilityExitCode,
  capabilityFailureReport,
  loadCapabilityProbeConfig,
  runCapabilityPreflight,
  type CapabilityReport,
} from '../src/modules/operations/capability-preflight.js';

/** An explicit file replaces ambient config, so a developer's credentials cannot mask a worker error. */
export async function capabilityEnvironment(argv: string[], inherited: NodeJS.ProcessEnv) {
  const { values } = parseArgs({ args: argv, options: { 'env-file': { type: 'string' } } });
  if (!values['env-file']) return { ...inherited };
  const path = resolve(values['env-file']);
  const info = await stat(path);
  if (!info.isFile() || info.size > 65_536 || (info.mode & 0o077) !== 0)
    throw new CapabilityProbeError('CONFIG_INVALID');
  return parse(await readFile(path, 'utf8'));
}

/** Split for offline import checks and fixture tests; calling this explicitly can read real sources. */
export async function capabilityPreflight(env: NodeJS.ProcessEnv): Promise<CapabilityReport> {
  const started = performance.now();
  let config: ReturnType<typeof loadConfig>;
  let probe: ReturnType<typeof loadCapabilityProbeConfig>;
  try {
    // Validate the actual worker's complete runtime config; no model is constructed by loadConfig.
    config = loadConfig(env);
    if (!config.businessReads) throw new CapabilityProbeError('BUSINESS_READS_DISABLED');
    if (!config.messageDatabase) throw new CapabilityProbeError('CONFIG_INVALID');
    probe = loadCapabilityProbeConfig(env);
  } catch (error) {
    return capabilityFailureReport(
      error instanceof CapabilityProbeError ? error.code : 'CONFIG_INVALID',
      env.RELEASE_SHA,
      Math.round(performance.now() - started),
    );
  }
  const pool = new Pool(messagePoolOptions(config.messageDatabase.url, config.messageDatabase.ca));
  pool.on('error', () => {}); // Never emit driver errors containing credentials/host details.
  const db = createPrismaClient(config.databaseUrl);
  let rosterDenied = false;
  const roster = new PostgresEmployeeRoster({
    query: (async (...args: Parameters<Pool['query']>) => {
      try {
        return await pool.query(...args);
      } catch (error) {
        // Only a SQLSTATE boolean survives. Missing RLS rows are indistinguishable from unknown identity.
        rosterDenied =
          !!error && typeof error === 'object' && 'code' in error && error.code === '42501';
        throw error;
      }
    }) as Pool['query'],
  });
  const identities = new EmployeeIdentityResolver(roster);
  try {
    return await runCapabilityPreflight(probe, {
      release: config.release,
      employeeIds: config.businessReads.employeeIds,
      signingScopes: config.businessReads.signing.scopes,
      async resolveEmployee(id, signal) {
        try {
          return await identities.resolveEmployee(id, signal);
        } catch {
          throw new CapabilityProbeError(
            rosterDenied ? 'ROSTER_ACCESS_DENIED' : 'ROSTER_UNAVAILABLE',
          );
        }
      },
      resolve: createBusinessAccessResolver(config.businessReads, db, pool, config.encryptionKey),
    });
  } finally {
    await Promise.allSettled([db.$disconnect(), pool.end()]);
  }
}

async function main() {
  let report: CapabilityReport;
  try {
    report = await capabilityPreflight(
      await capabilityEnvironment(process.argv.slice(2), process.env),
    );
  } catch (error) {
    report = capabilityFailureReport(
      error instanceof CapabilityProbeError ? capabilityErrorCode(error) : 'CONFIG_INVALID',
    );
  }
  console.log(JSON.stringify(report));
  process.exitCode = capabilityExitCode(report);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main();
