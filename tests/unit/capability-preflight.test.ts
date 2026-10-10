/** Capability readiness with synthetic identities/data only: no database, model or transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CapabilityProbeError,
  capabilityErrorCode,
  capabilityExitCode,
  capabilityFailureReport,
  loadCapabilityProbeConfig,
  runCapabilityPreflight,
  type CapabilityProbeConfig,
} from '../../src/modules/operations/capability-preflight.js';
import { capabilityEnvironment, capabilityPreflight } from '../../scripts/capability-preflight.js';
import {
  ContextEngineError,
  type ContextReadTool,
  type ContextEvidence,
  type ContextToolDefinition,
} from '../../src/modules/context-engine/context.types.js';
import { indiaDate } from '../../src/modules/assistant/followups.js';
import type {
  BoundCrmReader,
  BusinessAccessResolver,
} from '../../src/modules/assistant/business-reads.js';
import { analyticsFixture } from '../../scripts/lib/analytics-fixture.js';

const now = Date.parse('2026-10-02T06:00:00Z');
const scopes = ['crm:read', 'warehouses:read', 'knowledge:read', 'analytics:read'];
const tools: ContextReadTool[] = [
  'get_context',
  'search_crm_leads',
  'search_warehouses',
  'search_knowledge',
  'ga4_report',
  'search_console_report',
];
const employee = {
  employeeId: 23,
  phoneE164: '+919000000023',
  email: 'private@example.test',
  active: true,
};
const config = (changes: Partial<CapabilityProbeConfig> = {}): CapabilityProbeConfig => ({
  employeeId: 23,
  required: ['crm', 'warehouses'],
  optional: ['knowledge', 'ga4', 'search_console'],
  timeoutMs: 1000,
  ...changes,
});
function fixture() {
  const state = {
    active: true,
    identityError: undefined as Error | undefined,
    discoveryError: undefined as Error | undefined,
    sourceError: undefined as { tool: ContextReadTool; error: Error } | undefined,
    staleCrm: false,
    changeOnReceipt: undefined as ContextReadTool | undefined,
    revokeOnReceipt: undefined as ContextReadTool | undefined,
    sourceScopes: [...scopes],
    toolNames: [...tools],
    calls: [] as ContextReadTool[],
    resolveCalls: 0,
    catalogueCalls: 0,
  };
  const evidence = (tool: ContextReadTool, args: Record<string, unknown>): ContextEvidence => {
    if (tool === 'ga4_report' || tool === 'search_console_report')
      return analyticsFixture(tool, args, now);
    const paths: Partial<Record<ContextReadTool, string>> = {
      get_context: '/api/v1/context',
      search_crm_leads: '/api/v1/crm/opportunities',
      search_warehouses: '/api/v1/warehouses',
      search_knowledge: '/api/v1/wiki/pages',
    };
    const query = new URLSearchParams(
      Object.entries(args).map(([key, value]) => [key, String(value)]),
    ).toString();
    return {
      source_path: paths[tool]! + (query ? `?${query}` : ''),
      status: 200,
      meta: { requestId: 'private-request-id', generatedAt: new Date(now).toISOString() },
      data:
        tool === 'get_context'
          ? { employee_id: 23, scopes: state.sourceScopes }
          : {
              items: [],
              nextCursor: null,
              access_scope: 'all',
              query_context: {
                timezone: 'Asia/Kolkata',
                local_date: indiaDate(now),
                as_of: new Date(now).toISOString(),
                returned_count: 0,
                has_more: false,
              },
              source_status: {
                opportunities: { status: 'ok', last_run_at: new Date(now - 60000).toISOString() },
              },
              read_consistency: {
                database_snapshot: 'repeatable_read',
                lead_fields: 'same_row',
                cross_request_snapshot: false,
              },
            },
    };
  };
  const call = async (tool: ContextReadTool, args: Record<string, unknown>) => {
    state.calls.push(tool);
    if (state.sourceError?.tool === tool) throw state.sourceError.error;
    const result = evidence(tool, args);
    if (tool === 'search_crm_leads' && state.staleCrm) {
      (
        result.data.source_status as { opportunities: { last_run_at: string } }
      ).opportunities.last_run_at = new Date(now - 3600000).toISOString();
    }
    if (state.calls.filter((name) => name === tool).length === 2) {
      if (state.changeOnReceipt === tool) result.data.changed = 'PRIVATE_BUSINESS_CONTENT';
      if (state.revokeOnReceipt === tool) state.active = false;
    }
    return result;
  };
  const reader: BoundCrmReader = {
    employeeId: 23,
    search: async (args) => call('search_crm_leads', args),
    tools: {
      employeeId: 23,
      async discover() {
        state.catalogueCalls++;
        if (state.discoveryError) throw state.discoveryError;
        return state.toolNames.map(
          (name): ContextToolDefinition => ({
            name,
            // Closed schemas: an open object cannot be expressed in strict mode and is flagged.
            inputSchema: {
              type: 'object',
              properties: Object.fromEntries(
                ['view', 'limit', 'report', 'period', 'group', 'cursor', 'query', 'id'].map(
                  (key) => [key, key === 'limit' ? { type: 'integer' } : { type: 'string' }],
                ),
              ),
              additionalProperties: false,
            },
          }),
        );
      },
      call: async (tool, args) => call(tool, args),
    },
  };
  const runtime = {
    release: 'a'.repeat(40),
    employeeIds: 'all' as readonly number[] | 'all',
    signingScopes: [...scopes],
    now: () => now,
    async resolveEmployee() {
      if (state.identityError) throw state.identityError;
      return state.active ? employee : null;
    },
    async resolve(...[key]: Parameters<BusinessAccessResolver>) {
      assert.deepEqual(key, { remoteJid: '919000000023@s.whatsapp.net', fromMe: false });
      state.resolveCalls++;
      return state.active ? reader : null;
    },
  };
  return { state, runtime };
}

test('authorized empty CRM/supply reads succeed with receipts and bounded source calls', async () => {
  const { state, runtime } = fixture();
  const report = await runCapabilityPreflight(config(), runtime);
  assert.equal(report.status, 'ready');
  assert.equal(capabilityExitCode(report), 0);
  assert.equal(state.catalogueCalls, 1);
  assert.deepEqual(state.calls, ['get_context', ...tools.slice(1).flatMap((name) => [name, name])]);
  assert.ok(
    report.checks
      .filter((c) => !['identity', 'catalogue'].includes(c.capability))
      .every((c) => c.stage === 'receipt'),
  );
  const output = JSON.stringify(report);
  for (const privateValue of [
    employee.phoneE164,
    employee.email,
    'private-request-id',
    'source_path',
    'items',
  ])
    assert.ok(!output.includes(privateValue));
});

test('unknown/inactive or RLS-filtered identity fails before catalogue access', async () => {
  const { state, runtime } = fixture();
  state.active = false;
  const report = await runCapabilityPreflight(config(), runtime);
  assert.equal(report.checks[0]?.error, 'IDENTITY_DENIED');
  assert.equal(capabilityExitCode(report), 1);
  assert.equal(state.resolveCalls, 0);
  assert.equal(state.calls.length, 0);
});

for (const code of ['ROSTER_ACCESS_DENIED', 'ROSTER_UNAVAILABLE'] as const) {
  test(`roster failure ${code} remains distinct from unknown identity`, async () => {
    const { state, runtime } = fixture();
    state.identityError = new CapabilityProbeError(code);
    const report = await runCapabilityPreflight(config(), runtime);
    assert.equal(report.checks[0]?.error, code);
    assert.equal(state.calls.length, 0);
  });
}

test('employee pilot configuration is honored without opening tools', async () => {
  const { state, runtime } = fixture();
  runtime.employeeIds = [24];
  const report = await runCapabilityPreflight(config(), runtime);
  assert.equal(report.checks[0]?.error, 'EMPLOYEE_NOT_ENABLED');
  assert.equal(state.catalogueCalls, 0);
});

test('local signing scope, remote scope and platform tool removal remain distinct', async () => {
  for (const variant of ['local', 'remote', 'tool'] as const) {
    const { state, runtime } = fixture();
    if (variant === 'local') runtime.signingScopes = scopes.filter((scope) => scope !== 'crm:read');
    if (variant === 'remote') state.sourceScopes = scopes.filter((scope) => scope !== 'crm:read');
    if (variant === 'tool') state.toolNames = tools.filter((name) => name !== 'search_crm_leads');
    const report = await runCapabilityPreflight(
      config({ required: ['crm'], optional: [] }),
      runtime,
    );
    assert.equal(
      report.checks.at(-1)?.error,
      { local: 'LOCAL_SCOPE_MISSING', remote: 'REMOTE_SCOPE_MISSING', tool: 'TOOL_UNAVAILABLE' }[
        variant
      ],
    );
    assert.equal(report.status, 'failed');
    assert.deepEqual(state.calls, ['get_context']);
  }
});

test('discovery outage is not reported as an identity denial and exception text is discarded', async () => {
  const { state, runtime } = fixture();
  state.discoveryError = new Error('SECRET_KEY private database hostname');
  const report = await runCapabilityPreflight(config(), runtime);
  assert.equal(report.checks[0]?.status, 'ready');
  assert.equal(report.checks.at(-1)?.stage, 'discovery');
  assert.equal(report.checks.at(-1)?.error, 'UNAVAILABLE');
  assert.ok(!JSON.stringify(report).includes('SECRET_KEY'));
});

test('optional GA4 source outage degrades while Search Console and required reads pass', async () => {
  const { state, runtime } = fixture();
  state.sourceError = { tool: 'ga4_report', error: new ContextEngineError('UNAVAILABLE') };
  const report = await runCapabilityPreflight(config(), runtime);
  assert.equal(report.status, 'degraded');
  assert.equal(capabilityExitCode(report), 0);
  assert.equal(report.checks.find((c) => c.capability === 'ga4')?.stage, 'source');
  assert.equal(report.checks.find((c) => c.capability === 'search_console')?.status, 'ready');
  assert.equal(state.calls.filter((name) => name === 'ga4_report').length, 1);
});

test('required source outage fails readiness while process configuration may still be valid', async () => {
  const { state, runtime } = fixture();
  state.sourceError = { tool: 'search_crm_leads', error: new ContextEngineError('UNAVAILABLE') };
  const report = await runCapabilityPreflight(config(), runtime);
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.find((c) => c.capability === 'crm')?.error, 'UNAVAILABLE');
  assert.equal(report.checks.find((c) => c.capability === 'warehouses')?.status, 'ready');
});

test('stale CRM mirror fails source validation instead of passing as an empty authorized query', async () => {
  const { state, runtime } = fixture();
  state.staleCrm = true;
  const report = await runCapabilityPreflight(config({ required: ['crm'], optional: [] }), runtime);
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.at(-1)?.stage, 'source');
  assert.equal(report.checks.at(-1)?.error, 'UNAVAILABLE');
  assert.equal(state.calls.filter((name) => name === 'search_crm_leads').length, 1);
});

test('changed source is detected by the existing delivery fingerprint check', async () => {
  const { state, runtime } = fixture();
  state.changeOnReceipt = 'search_crm_leads';
  const report = await runCapabilityPreflight(config({ optional: [] }), runtime);
  const check = report.checks.find((c) => c.capability === 'crm');
  assert.equal(check?.stage, 'receipt');
  assert.equal(check?.error, 'SOURCE_CHANGED');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_BUSINESS_CONTENT'));
});

test('revocation during an optional receipt check fails global authority readiness', async () => {
  const { state, runtime } = fixture();
  state.revokeOnReceipt = 'ga4_report';
  const report = await runCapabilityPreflight(config(), runtime);
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.at(-1)?.capability, 'identity');
  assert.equal(report.checks.at(-1)?.error, 'IDENTITY_CHANGED');
  assert.equal(state.calls.includes('search_console_report'), false);
});

test('aborted probes stop before source operations', async () => {
  const { state, runtime } = fixture();
  const report = await runCapabilityPreflight(config(), runtime, AbortSignal.abort());
  assert.equal(report.checks.at(-1)?.error, 'CANCELLED');
  assert.equal(state.calls.length, 0);
});

test('whole-probe deadline bounds a dependency that ignores its signal', async () => {
  const { runtime } = fixture();
  runtime.resolveEmployee = () => new Promise(() => {});
  const report = await runCapabilityPreflight(config({ timeoutMs: 15 }), runtime);
  assert.equal(report.checks.at(-1)?.error, 'TIMEOUT');
  assert.ok(report.latencyMs < 1000);
});

test('operator config requires a specific employee and bounded nonoverlapping known capabilities', () => {
  const base = { CAPABILITY_PROBE_EMPLOYEE_ID: '23' };
  assert.deepEqual(loadCapabilityProbeConfig(base).required, ['crm', 'warehouses']);
  assert.deepEqual(
    loadCapabilityProbeConfig({ ...base, CAPABILITY_PROBE_OPTIONAL: '' }).optional,
    [],
  );
  for (const changes of [
    { CAPABILITY_PROBE_EMPLOYEE_ID: '' },
    { CAPABILITY_PROBE_EMPLOYEE_ID: '9007199254740992' },
    { CAPABILITY_PROBE_REQUIRED: '' },
    { CAPABILITY_PROBE_REQUIRED: 'admin' },
    { CAPABILITY_PROBE_REQUIRED: 'crm,crm' },
    { CAPABILITY_PROBE_OPTIONAL: 'crm' },
    { CAPABILITY_PROBE_TIMEOUT_MS: '0' },
    { CAPABILITY_PROBE_TIMEOUT_MS: '60001' },
  ])
    assert.throws(() => loadCapabilityProbeConfig({ ...base, ...changes }), CapabilityProbeError);
});

test('configuration reports sanitize release and source errors, with distinct exit codes', () => {
  assert.equal(capabilityErrorCode(new Error('private payload')), 'UNAVAILABLE');
  const report = capabilityFailureReport('PROBE_NOT_CONFIGURED', 'private-hostname');
  assert.equal(report.release, 'unknown');
  assert.equal(capabilityExitCode(report), 2);
});

test('disabled business reads and missing runtime configuration fail without external calls', async () => {
  const env = {
    DATABASE_URL: 'file:/unused-probe-state.sqlite',
    AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    WORKER_API_TOKEN: 'x'.repeat(32),
    BUSINESS_READS_ENABLED: 'false',
  };
  const disabled = await capabilityPreflight(env);
  assert.equal(disabled.checks[0]?.error, 'BUSINESS_READS_DISABLED');
  const invalid = await capabilityPreflight({});
  assert.equal(invalid.checks[0]?.error, 'CONFIG_INVALID');
});

test('explicit private worker env replaces ambient values and rejects world-readable files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ramesh-probe-env-'));
  const file = join(directory, 'worker.env');
  try {
    await writeFile(file, 'CAPABILITY_PROBE_EMPLOYEE_ID=23\n', { mode: 0o600 });
    const env = await capabilityEnvironment(['--env-file', file], {
      AMBIENT_PRIVATE: 'do-not-overlay',
    });
    assert.deepEqual(env, { CAPABILITY_PROBE_EMPLOYEE_ID: '23' });
    await chmod(file, 0o644);
    await assert.rejects(capabilityEnvironment(['--env-file', file], {}), CapabilityProbeError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI dependency closure contains no model adapters, application startup, queue writer or sender', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const pending = [resolve(root, 'scripts/capability-preflight.ts')];
  const seen = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    assert.doesNotMatch(
      file,
      // strict-tool-schema is a pure JSON Schema codec with no SDK import; preflight uses it to
      // flag tools the provider's strict mode cannot express.
      /infrastructure\/openai\/(?!strict-tool-schema\.ts$)|app\/application|whatsapp\/(baileys-client|durable-messages)|message-queue\.repository/,
    );
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]!;
      assert.notEqual(specifier, 'openai');
      if (specifier.startsWith('.'))
        pending.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
    }
  }
});
