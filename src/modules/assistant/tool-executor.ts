/** Application-owned read execution: discovered schemas, current employee binding, budgets and durable evidence. */
import { randomUUID } from 'node:crypto';
import { cyclicCursor, paginationCoverage } from './pagination.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { TrustedReplyContext } from '../greetings/greeting.types.js';
import {
  ContextEngineError,
  isContextReadTool,
  type ContextToolDefinition,
  type ContextReadTool,
  type ContextEvidence,
} from '../context-engine/context.types.js';
import {
  MAX_TOOL_CALLS,
  MAX_RUN_EVIDENCE_BYTES,
  verifyToolEvidence,
  toolDelivery,
  type ToolEvidence,
} from './tool-evidence.js';

export interface BoundContextReader {
  employeeId: number;
  discover(signal: AbortSignal): Promise<ContextToolDefinition[]>;
  describe?(signal: AbortSignal): Promise<{ tools: ContextToolDefinition[]; guidance?: string }>;
  call(
    name: ContextReadTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ContextEvidence>;
}
export type ResolveContextReader = (signal: AbortSignal) => Promise<BoundContextReader | null>;
const queryKey = (name: string, args: Record<string, unknown>) =>
  `${name}:${JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)))}`;
const forbidden = new Set([
  'employee_id',
  'employeeId',
  'user_id',
  'phoneE164',
  'phone_number',
  'remoteJid',
  'participant',
  'authorization',
  'headers',
  'api_key',
  'access_token',
  'credential',
  'destination',
  'recipient',
  'scopes',
]);

export class ContextToolRun {
  readonly evidence: ToolEvidence[] = [];
  readonly failures: Array<{
    tool: string;
    code: string;
    recovery?: ContextEngineError['recovery'];
  }> = [];
  private readonly validator = new AjvJsonSchemaValidator();
  private readonly attempted = new Map<
    string,
    { count: number; failure?: Record<string, unknown>; retryAt?: number }
  >();
  private readonly unavailableTools = new Map<string, Record<string, unknown>>();
  private readonly cooldowns = new Map<
    string,
    { until: number; failure: Record<string, unknown> }
  >();
  private proposals = 0;
  private bytes = 0;
  private denied = false;
  private constructor(
    readonly employeeId: number,
    readonly tools: readonly ContextToolDefinition[],
    private readonly resolve: ResolveContextReader,
    private readonly record: TrustedReplyContext['record'],
    private readonly now: () => number,
    readonly guidance = '',
  ) {}
  static async open(
    resolve: ResolveContextReader,
    record: TrustedReplyContext['record'],
    signal: AbortSignal,
    now = Date.now,
  ) {
    const reader = await resolve(signal);
    if (!reader) return null;
    const catalogue = reader.describe
      ? await reader.describe(signal)
      : { tools: await reader.discover(signal), guidance: '' };
    const tools = catalogue.tools.filter((tool) => isContextReadTool(tool.name));
    if (
      tools.length > 32 ||
      new Set(tools.map((tool) => tool.name)).size !== tools.length ||
      Buffer.byteLength(JSON.stringify(tools)) > 200_000 ||
      (catalogue.guidance !== undefined &&
        (typeof catalogue.guidance !== 'string' || Buffer.byteLength(catalogue.guidance) > 32_000))
    )
      throw new ContextEngineError('INVALID_RESPONSE');
    const current = await resolve(signal);
    if (!current || current.employeeId !== reader.employeeId)
      throw new ContextEngineError('AUTH_REQUIRED');
    return new ContextToolRun(
      reader.employeeId,
      structuredClone(tools),
      resolve,
      record,
      now,
      catalogue.guidance,
    );
  }
  get remaining() {
    return this.denied ? 0 : Math.max(0, MAX_TOOL_CALLS - this.proposals);
  }
  get blocked() {
    return this.denied;
  }
  get pagination() {
    return paginationCoverage(this.evidence);
  }
  /** A recalled query shares this run's evidence, budget and employee boundary. */
  async executeCached(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    const stable = (value: Record<string, unknown>) =>
      JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    const existing = this.evidence.find(
      (e) => e.tool === name && stable(e.arguments) === stable(args),
    );
    if (existing) {
      const current = await this.resolve(signal);
      signal.throwIfAborted();
      if (!current || current.employeeId !== this.employeeId) {
        this.denied = true;
        return undefined;
      }
      verifyToolEvidence(existing.tool, existing.arguments, existing.result, this.now());
      return existing;
    }
    const result = await this.execute(name, JSON.stringify(args), signal);
    return result.ok ? this.evidence.find((e) => e.id === result.evidence_id) : undefined;
  }
  async execute(
    name: string,
    argumentsJson: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (this.remaining <= 0)
      return { ok: false, code: this.denied ? 'ACCESS_DENIED' : 'TOOL_BUDGET_EXHAUSTED' };
    this.proposals++;
    const operationId = randomUUID();
    let args: Record<string, unknown> = {};
    let fingerprint: string | undefined;
    try {
      const tool = this.tools.find((tool) => tool.name === name);
      if (!tool || !isContextReadTool(name)) throw new ContextEngineError('TOOL_UNAVAILABLE');
      if (Buffer.byteLength(argumentsJson) > 16384)
        throw new ContextEngineError('INVALID_ARGUMENTS');
      try {
        args = JSON.parse(argumentsJson);
      } catch {
        throw new ContextEngineError('INVALID_ARGUMENTS');
      }
      if (
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).some((key) => forbidden.has(key))
      )
        throw new ContextEngineError('INVALID_ARGUMENTS');
      const checked = this.validator.getValidator(tool.inputSchema)(args);
      if (!checked.valid) throw new ContextEngineError('INVALID_ARGUMENTS');
      if (name === 'search_crm_leads' || name === 'crm_summary') {
        const window = ['period', 'date_from', 'date_to'].some((key) => args[key] !== undefined);
        // MCP's JSON Schema does not express every backend filter dependency.
        if (
          (args.date_field !== undefined && !window) ||
          (args.follow_up_status !== undefined && (window || args.date_field !== undefined))
        )
          throw new ContextEngineError('INVALID_ARGUMENTS');
      }
      const reader = await this.resolve(signal);
      signal.throwIfAborted();
      if (!reader || reader.employeeId !== this.employeeId)
        throw new ContextEngineError('AUTH_REQUIRED');
      fingerprint = queryKey(name, args);
      if (cyclicCursor(this.evidence, name, args))
        throw new ContextEngineError('PAGINATION_STALLED');
      const cached = this.evidence.find((e) => queryKey(e.tool, e.arguments) === fingerprint);
      if (cached) {
        verifyToolEvidence(name, args, cached.result, this.now());
        return {
          ok: true,
          evidence_id: cached.id,
          ...cached.result,
          reused_in_run: true,
          pagination: this.pagination,
        };
      }
      const unavailable = this.unavailableTools.get(name);
      if (unavailable) return { ...unavailable, suppressed_repeat: true };
      const cooldown = this.cooldowns.get(name);
      if (cooldown && cooldown.until > this.now())
        return {
          ...cooldown.failure,
          retry_after_seconds: Math.ceil((cooldown.until - this.now()) / 1000),
          suppressed_repeat: true,
          guidance:
            'Retry-After has not elapsed for this source. Changing the report or query cannot bypass it. Use another source or explain the temporary limit.',
        };
      const previous = this.attempted.get(fingerprint);
      if (previous?.failure) {
        if (previous.failure.retryable !== true || previous.count >= 2)
          return {
            ...previous.failure,
            retryable: false,
            suppressed_repeat: true,
            guidance:
              'This query already failed. Do not vary irrelevant arguments to repeat it. Use a supported alternative or explain the limitation.',
          };
        if ((previous.retryAt ?? 0) > this.now())
          return {
            ...previous.failure,
            retry_after_seconds: Math.ceil((previous.retryAt! - this.now()) / 1000),
            suppressed_repeat: true,
            guidance:
              'Retry-After has not elapsed. Do not bypass it by changing the query. Use another source or report that this source is temporarily busy.',
          };
      }
      this.attempted.set(fingerprint, { count: (previous?.count ?? 0) + 1 });
      await this.record?.('tool_started', {
        version: 2,
        operationId,
        tool: name,
        employeeId: this.employeeId,
        arguments: args,
      });
      const result = await reader.call(name, args, signal);
      signal.throwIfAborted();
      verifyToolEvidence(name, args, result, this.now());
      const size = Buffer.byteLength(JSON.stringify(result));
      if (this.bytes + size > MAX_RUN_EVIDENCE_BYTES)
        throw new ContextEngineError('RESPONSE_TOO_LARGE');
      const current = await this.resolve(signal);
      if (!current || current.employeeId !== this.employeeId)
        throw new ContextEngineError('AUTH_REQUIRED');
      const evidence = { id: operationId, tool: name, arguments: structuredClone(args), result };
      await this.record?.('tool_succeeded', {
        version: 2,
        employeeId: this.employeeId,
        ...evidence,
      });
      signal.throwIfAborted();
      this.bytes += size;
      this.evidence.push(evidence);
      return { ok: true, evidence_id: operationId, ...result, pagination: this.pagination };
    } catch (error) {
      signal.throwIfAborted();
      const code = error instanceof ContextEngineError ? error.code : 'UNAVAILABLE';
      if (code === 'AUTH_REQUIRED' || code === 'ACCESS_DENIED') this.denied = true;
      // No upstream exception bodies or failed tool data enter the model or logs.
      const tool = isContextReadTool(name) ? name : 'unknown';
      await this.record?.('tool_failed', {
        version: 2,
        operationId,
        employeeId: this.employeeId,
        tool,
        code,
      });
      const recovery = error instanceof ContextEngineError ? error.recovery : undefined;
      this.failures.push({ tool, code, ...(recovery ? { recovery } : {}) });
      const failure: Record<string, unknown> = {
        ok: false,
        code,
        pagination: this.pagination,
        ...(error instanceof ContextEngineError
          ? {
              retryable: error.retryable,
              retry_after_seconds: error.retryAfterSeconds,
              ...(recovery ? { recovery } : {}),
            }
          : {}),
        guidance: recovery
          ? 'Follow the recovery action. Do not repeat a non-retryable request unchanged. Other available sources may still work. Never treat failure as zero activity.'
          : code === 'PAGINATION_STALLED'
            ? 'The source repeated a cursor. Stop this traversal; preserve unique records already retrieved and state that coverage is partial. Do not bypass the cycle by changing page size.'
            : code === 'INVALID_ARGUMENTS'
              ? 'Check the advertised schema and omit unset fields. CRM date_field requires a period or date_from/date_to; never combine these with follow_up_status. For all dates, omit date_field, period, date_from, date_to and follow_up_status.'
              : error instanceof ContextEngineError && error.retryable
                ? 'A transient read may be retried once with the same arguments, within the run deadline and after Retry-After if supplied. Do not change the query to bypass a delay. If recovery is unavailable, preserve useful results from other sources and explain the limitation.'
                : code === 'RESPONSE_TOO_LARGE'
                  ? 'Narrow the query or use a smaller page.'
                  : 'Report the limitation. A failed read does not mean there are no matching records.',
      };
      if (fingerprint) {
        const attempt = this.attempted.get(fingerprint);
        if (attempt) {
          attempt.failure = failure;
          const delay = error instanceof ContextEngineError ? error.retryAfterSeconds : undefined;
          if (delay !== undefined && Number.isFinite(delay) && delay >= 0)
            attempt.retryAt = this.now() + Math.min(delay, 3600) * 1000;
          if (failure.retryable === true && attempt.retryAt !== undefined)
            this.cooldowns.set(tool, { until: attempt.retryAt, failure });
        }
      }
      if (
        failure.retryable !== true &&
        (recovery?.action === 'check_source_configuration' ||
          recovery?.action === 'check_google_access')
      )
        this.unavailableTools.set(tool, failure);
      return failure;
    }
  }
  delivery() {
    if (this.denied) throw new ContextEngineError('ACCESS_DENIED');
    return this.evidence.length
      ? toolDelivery(this.employeeId, this.evidence, this.now())
      : undefined;
  }
}
