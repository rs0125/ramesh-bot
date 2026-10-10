/** Model-free, read-only readiness. Reports never contain identity, source rows or credentials. */
import { cancellable } from '../../lib/cancellable.js';
import { strictUnsupportedTools, type CatalogueTool } from './catalogue-drift.js';
import { BusinessReadService, type BusinessAccessResolver } from '../assistant/business-reads.js';
import { ContextToolRun } from '../assistant/tool-executor.js';
import { toolDelivery } from '../assistant/tool-evidence.js';
import {
  ContextEngineError,
  CONTEXT_READ_TOOLS,
  type ContextErrorCode,
  type ContextReadTool,
} from '../context-engine/context.types.js';
import type { EmployeeIdentity } from '../identity/employee-identity.js';

export const CAPABILITY_NAMES = [
  'crm',
  'warehouses',
  'knowledge',
  'ga4',
  'search_console',
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export interface CapabilityProbeConfig {
  employeeId: number;
  required: CapabilityName[];
  optional: CapabilityName[];
  timeoutMs: number;
}
type Stage = 'configuration' | 'identity' | 'discovery' | 'scope' | 'source' | 'receipt';
const errors = [
  'CONFIG_INVALID',
  'BUSINESS_READS_DISABLED',
  'PROBE_NOT_CONFIGURED',
  'IDENTITY_DENIED',
  'EMPLOYEE_NOT_ENABLED',
  'ROSTER_ACCESS_DENIED',
  'ROSTER_UNAVAILABLE',
  'LOCAL_SCOPE_MISSING',
  'REMOTE_SCOPE_MISSING',
  'IDENTITY_CHANGED',
  'SOURCE_CHANGED',
  'INVALID_RECEIPT',
  'INVALID_OR_EXPIRED_RECEIPT',
  'AUTH_REQUIRED',
  'ACCESS_DENIED',
  'NOT_CONFIGURED',
  'TOOL_UNAVAILABLE',
  'INVALID_ARGUMENTS',
  'INVALID_RESPONSE',
  'RESPONSE_TOO_LARGE',
  'PAGINATION_STALLED',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'TIMEOUT',
  'CANCELLED',
  'STRICT_SCHEMA_UNSUPPORTED',
] as const;
export type CapabilityErrorCode = (typeof errors)[number];
export class CapabilityProbeError extends Error {
  constructor(readonly code: CapabilityErrorCode) {
    super(code);
  }
}
export interface CapabilityCheck {
  capability: CapabilityName | 'runtime' | 'identity' | 'catalogue';
  required: boolean;
  status: 'ready' | 'failed';
  stage: Stage;
  latencyMs: number;
  error?: CapabilityErrorCode;
}
export interface CapabilityReport {
  version: 1;
  release: string;
  status: 'ready' | 'degraded' | 'failed';
  latencyMs: number;
  checks: CapabilityCheck[];
}
const probes: Record<CapabilityName, { tool: ContextReadTool; args: Record<string, unknown> }> = {
  crm: { tool: 'search_crm_leads', args: { view: 'accessible', limit: 1 } },
  warehouses: { tool: 'search_warehouses', args: { limit: 1 } },
  knowledge: { tool: 'search_knowledge', args: { limit: 1 } },
  ga4: { tool: 'ga4_report', args: { report: 'overview', period: 'yesterday', limit: 1 } },
  search_console: {
    tool: 'search_console_report',
    args: { group: 'summary', period: 'last_7_days', limit: 1 },
  },
};

export function loadCapabilityProbeConfig(env: NodeJS.ProcessEnv): CapabilityProbeConfig {
  const employeeId = Number(env.CAPABILITY_PROBE_EMPLOYEE_ID);
  if (
    !/^[1-9]\d*$/.test(env.CAPABILITY_PROBE_EMPLOYEE_ID ?? '') ||
    !Number.isSafeInteger(employeeId)
  )
    throw new CapabilityProbeError('PROBE_NOT_CONFIGURED');
  const list = (raw: string, empty: boolean) => {
    if (!raw.trim() && empty) return [];
    const items = raw.split(',').map((value) => value.trim());
    if (
      items.some((name) => !CAPABILITY_NAMES.includes(name as CapabilityName)) ||
      new Set(items).size !== items.length
    )
      throw new CapabilityProbeError('CONFIG_INVALID');
    return items as CapabilityName[];
  };
  const required = list(env.CAPABILITY_PROBE_REQUIRED ?? 'crm,warehouses', false);
  const optional = list(env.CAPABILITY_PROBE_OPTIONAL ?? 'knowledge,ga4,search_console', true);
  if (required.some((name) => optional.includes(name)))
    throw new CapabilityProbeError('CONFIG_INVALID');
  const raw = env.CAPABILITY_PROBE_TIMEOUT_MS ?? '45000';
  const timeoutMs = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 60000
  )
    throw new CapabilityProbeError('CONFIG_INVALID');
  return { employeeId, required, optional, timeoutMs };
}

/** Explicit allowlist: an upstream exception's message or arbitrary code can contain private data. */
export function capabilityErrorCode(error: unknown): CapabilityErrorCode {
  const code =
    error instanceof ContextEngineError || error instanceof CapabilityProbeError
      ? error.code
      : undefined;
  return errors.includes(code as CapabilityErrorCode)
    ? (code as CapabilityErrorCode)
    : 'UNAVAILABLE';
}
export function capabilityFailureReport(
  code: CapabilityErrorCode,
  release = 'unknown',
  latencyMs = 0,
): CapabilityReport {
  return {
    version: 1,
    release: safeRelease(release),
    status: 'failed',
    latencyMs,
    checks: [
      {
        capability: 'runtime',
        required: true,
        status: 'failed',
        stage: 'configuration',
        latencyMs,
        error: code,
      },
    ],
  };
}
function safeRelease(release: string) {
  return release === 'development' || /^[a-f0-9]{40}$/.test(release) ? release : 'unknown';
}
export function capabilityExitCode(report: CapabilityReport): number {
  if (report.status !== 'failed') return 0;
  return report.checks.some((check) => check.stage === 'configuration' && check.status === 'failed')
    ? 2
    : 1;
}

/** Uses the worker's resolver and delivery verifier; deliberately has no queue or sender dependency. */
export async function runCapabilityPreflight(
  config: CapabilityProbeConfig,
  runtime: {
    release: string;
    employeeIds: readonly number[] | 'all';
    signingScopes: readonly string[];
    resolveEmployee(id: number, signal: AbortSignal): Promise<EmployeeIdentity | null>;
    resolve: BusinessAccessResolver;
    now?: () => number;
    /** Receives the live read catalogue (definitions only), e.g. to compare with test fixtures. */
    onCatalogue?: (tools: readonly CatalogueTool[]) => void;
  },
  caller?: AbortSignal,
): Promise<CapabilityReport> {
  const now = runtime.now ?? Date.now;
  const started = performance.now();
  const checks: CapabilityCheck[] = [];
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), config.timeoutMs);
  const signal = caller ? AbortSignal.any([deadline.signal, caller]) : deadline.signal;
  const elapsed = (since: number) => Math.max(0, Math.round(performance.now() - since));
  const errorCode = (error: unknown) =>
    caller?.aborted
      ? 'CANCELLED'
      : deadline.signal.aborted
        ? 'TIMEOUT'
        : capabilityErrorCode(error);
  const result = (): CapabilityReport => ({
    version: 1,
    release: safeRelease(runtime.release),
    latencyMs: elapsed(started),
    checks,
    status: checks.some((item) => item.required && item.status === 'failed')
      ? 'failed'
      : checks.some((item) => item.status === 'failed')
        ? 'degraded'
        : 'ready',
  });
  let stage: Stage = 'identity';
  let stageStarted = performance.now();
  try {
    const employee = await cancellable(
      () => runtime.resolveEmployee(config.employeeId, signal),
      signal,
    );
    if (!employee || !employee.active || employee.employeeId !== config.employeeId)
      throw new CapabilityProbeError('IDENTITY_DENIED');
    if (runtime.employeeIds !== 'all' && !runtime.employeeIds.includes(employee.employeeId))
      throw new CapabilityProbeError('EMPLOYEE_NOT_ENABLED');
    checks.push({
      capability: 'identity',
      required: true,
      status: 'ready',
      stage,
      latencyMs: elapsed(stageStarted),
    });
    // Only the operator-configured roster identity establishes this synthetic DM. No browser/model input.
    const key = { remoteJid: `${employee.phoneE164.slice(1)}@s.whatsapp.net`, fromMe: false };
    const resolve = async (currentSignal: AbortSignal) => {
      const reader = await runtime.resolve(key, currentSignal);
      return reader?.employeeId === employee.employeeId &&
        reader.tools?.employeeId === employee.employeeId
        ? reader
        : null;
    };
    const business = new BusinessReadService(
      (_key, currentSignal) => resolve(currentSignal),
      runtime.employeeIds,
      now,
      true,
    );
    stage = 'discovery';
    stageStarted = performance.now();
    const run = await cancellable(
      () =>
        ContextToolRun.open(async (s) => (await resolve(s))?.tools ?? null, undefined, signal, now),
      signal,
    );
    if (!run) throw new ContextEngineError('AUTH_REQUIRED');
    // Get the live effective scope intersection as well as the platform-selected catalogue.
    const context = await cancellable(() => run.execute('get_context', '{}', signal), signal);
    if (context.ok !== true) throw new ContextEngineError(safeContextCode(context.code));
    const contextData = run.evidence.find((entry) => entry.tool === 'get_context')?.result.data;
    if (!contextData || !Array.isArray(contextData.scopes))
      throw new ContextEngineError('INVALID_RESPONSE');
    const remoteScopes = contextData.scopes;
    checks.push({
      capability: 'catalogue',
      required: true,
      status: 'ready',
      stage,
      latencyMs: elapsed(stageStarted),
    });
    // A tool the provider's strict subset cannot express is dropped from every model session.
    const unsupported = strictUnsupportedTools(run.tools);
    checks.push({
      capability: 'catalogue',
      required: false,
      status: unsupported.length ? 'failed' : 'ready',
      stage,
      latencyMs: 0,
      ...(unsupported.length ? { error: 'STRICT_SCHEMA_UNSUPPORTED' as const } : {}),
    });
    runtime.onCatalogue?.(
      run.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool._meta ? { _meta: tool._meta } : {}),
        ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
      })),
    );
    for (const capability of [...config.required, ...config.optional]) {
      const capStarted = performance.now();
      const required = config.required.includes(capability);
      let capStage: Stage = 'scope';
      try {
        signal.throwIfAborted();
        const probe = probes[capability];
        const scope = CONTEXT_READ_TOOLS[probe.tool]!;
        if (!runtime.signingScopes.includes(scope))
          throw new CapabilityProbeError('LOCAL_SCOPE_MISSING');
        if (!remoteScopes.includes(scope)) throw new CapabilityProbeError('REMOTE_SCOPE_MISSING');
        if (!run.tools.some((tool) => tool.name === probe.tool))
          throw new ContextEngineError('TOOL_UNAVAILABLE');
        capStage = 'source';
        const read = await cancellable(
          () => run.execute(probe.tool, JSON.stringify(probe.args), signal),
          signal,
        );
        if (read.ok !== true) throw new ContextEngineError(safeContextCode(read.code));
        const evidence = run.evidence.find((entry) => entry.id === read.evidence_id);
        if (!evidence) throw new ContextEngineError('INVALID_RESPONSE');
        capStage = 'receipt';
        const receipt = toolDelivery(employee.employeeId, [evidence], now());
        let failure = 'INVALID_RECEIPT';
        const permitted = await cancellable(
          () =>
            business.canDeliver(key, receipt, signal, (reason) => {
              failure = reason;
            }),
          signal,
        );
        if (!permitted)
          throw new CapabilityProbeError(
            errors.includes(failure as CapabilityErrorCode)
              ? (failure as CapabilityErrorCode)
              : 'UNAVAILABLE',
          );
        checks.push({
          capability,
          required,
          status: 'ready',
          stage: capStage,
          latencyMs: elapsed(capStarted),
        });
      } catch (error) {
        const code = errorCode(error);
        checks.push({
          capability,
          required,
          status: 'failed',
          stage: capStage,
          latencyMs: elapsed(capStarted),
          error: code,
        });
        // Revocation is global authority failure even if observed through an optional source.
        if (['AUTH_REQUIRED', 'ACCESS_DENIED', 'IDENTITY_CHANGED'].includes(code)) {
          checks.push({
            capability: 'identity',
            required: true,
            status: 'failed',
            stage: capStage,
            latencyMs: 0,
            error: code,
          });
          break;
        }
      }
    }
    return result();
  } catch (error) {
    checks.push({
      capability: stage === 'identity' ? 'identity' : 'catalogue',
      required: true,
      status: 'failed',
      stage,
      latencyMs: elapsed(stageStarted),
      error: errorCode(error),
    });
    return result();
  } finally {
    clearTimeout(timer);
  }
}

function safeContextCode(code: unknown): ContextErrorCode {
  const allowed: ContextErrorCode[] = [
    'NOT_CONFIGURED',
    'AUTH_REQUIRED',
    'ACCESS_DENIED',
    'TOOL_UNAVAILABLE',
    'INVALID_ARGUMENTS',
    'INVALID_RESPONSE',
    'RESPONSE_TOO_LARGE',
    'PAGINATION_STALLED',
    'RATE_LIMITED',
    'UNAVAILABLE',
    'TIMEOUT',
    'CANCELLED',
  ];
  return allowed.includes(code as ContextErrorCode) ? (code as ContextErrorCode) : 'UNAVAILABLE';
}
