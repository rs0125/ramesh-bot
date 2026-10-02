/** Application-owned read execution: discovered schemas, current employee binding, budgets and durable evidence. */
import { createHash, randomUUID } from 'node:crypto';
import { runEvidenceId } from './evidence-presentation.js';
import { currentCheckpoint } from './model-replay.js';
import { CheckpointError } from './checkpoint.types.js';
import { cyclicCursor, paginationCoverage } from './pagination.js';
import { internalCrmReferences } from './record-identity.js';
import type { TrustedReplyContext } from '../greetings/greeting.types.js';
import {
  ContextEngineError,
  isContextReadTool,
  type ContextToolDefinition,
  type ContextReadTool,
  type ContextEvidence,
  type ContextCatalogue,
} from '../context-engine/context.types.js';
import {
  contextReadDescriptor,
  sameToolContract,
  schemaAccepts,
  MAX_CATALOGUE_BYTES,
  MAX_CATALOGUE_TOOLS,
  MAX_GUIDANCE_BYTES,
} from '../context-engine/read-contract.js';
import {
  MAX_TOOL_CALLS,
  MAX_RUN_EVIDENCE_BYTES,
  verifyToolEvidence,
  toolDelivery,
  type ToolEvidence,
} from './tool-evidence.js';

export interface BoundContextReader {
  /** Trusted port: discovery already filters the current employee's permitted reads.
   * call must enforce current employee, tool and argument/row permissions independently.
   * The production MCP adapter owns that boundary; graph schemas never grant permission. */
  employeeId: number;
  discover(signal: AbortSignal): Promise<ContextToolDefinition[]>;
  describe?(signal: AbortSignal): Promise<ContextCatalogue>;
  /** Only immutable/synthetic sources may opt in. Production replays reads to reauthorize rows. */
  allowEvidenceReuse?: boolean;
  call(
    name: ContextReadTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ContextEvidence>;
}
export type ResolveContextReader = (signal: AbortSignal) => Promise<BoundContextReader | null>;
const queryKey = (name: string, args: Record<string, unknown>) =>
  createHash('sha256')
    .update(
      `${name}:${JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)))}`,
    )
    .digest('hex');
interface QueryAttempt {
  count: number;
  pending?: boolean;
  failure?: Record<string, unknown>;
  retryAt?: number;
}
interface RetryPolicy {
  attempted: Array<[string, QueryAttempt]>;
  unavailable: Array<[string, Record<string, unknown>]>;
  cooldowns: Array<[string, { until: number; failure: Record<string, unknown> }]>;
}
/** Only retry decisions survive; old pagination, evidence IDs and source bodies do not. */
function failurePolicy(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) =>
      ['ok', 'code', 'retryable', 'retry_after_seconds', 'recovery'].includes(key),
    ),
  );
}
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
  'scopes',
]);

export class ContextToolRun {
  readonly evidence: ToolEvidence[] = [];
  /** Removed source snapshots are no longer grounding or delivery evidence, even in old tool prose. */
  readonly retiredEvidenceIds: string[] = [];
  /** Source facts can expire; their known internal identifiers still must not be printed. */
  readonly internalCrmIds = new Set<string>();
  readonly failures: Array<{
    tool: string;
    code: string;
    recovery?: ContextEngineError['recovery'];
  }> = [];
  private readonly attempted = new Map<string, QueryAttempt>();
  private readonly unavailableTools = new Map<string, Record<string, unknown>>();
  private readonly cooldowns = new Map<
    string,
    { until: number; failure: Record<string, unknown> }
  >();
  private proposals = 0;
  private bytes = 0;
  private denied = false;
  private policyRestored = false;
  private constructor(
    readonly employeeId: number,
    readonly tools: readonly ContextToolDefinition[],
    private readonly resolve: ResolveContextReader,
    private readonly record: TrustedReplyContext['record'],
    private readonly now: () => number,
    readonly guidance = '',
    readonly context: Record<string, unknown> = {},
    private readonly runId?: string,
  ) {}
  static async open(
    resolve: ResolveContextReader,
    record: TrustedReplyContext['record'],
    signal: AbortSignal,
    now = Date.now,
    runId?: string,
  ) {
    const reader = await resolve(signal);
    if (!reader) return null;
    const catalogue = reader.describe
      ? await reader.describe(signal)
      : { tools: await reader.discover(signal), guidance: '' };
    const tools = catalogue.tools.filter(
      (tool) => isContextReadTool(tool.name) || contextReadDescriptor(tool),
    );
    if (
      tools.length > MAX_CATALOGUE_TOOLS ||
      new Set(tools.map((tool) => tool.name)).size !== tools.length ||
      Buffer.byteLength(JSON.stringify(tools)) > MAX_CATALOGUE_BYTES ||
      (catalogue.guidance !== undefined &&
        (typeof catalogue.guidance !== 'string' ||
          Buffer.byteLength(catalogue.guidance) > MAX_GUIDANCE_BYTES)) ||
      Buffer.byteLength(JSON.stringify(catalogue.context ?? {})) > 32_000
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
      structuredClone(catalogue.context ?? {}),
      runId,
    );
  }
  get remaining() {
    return this.denied ? 0 : Math.max(0, MAX_TOOL_CALLS - this.proposals);
  }
  get blocked() {
    return this.denied;
  }
  private async restorePolicy() {
    const checkpoint = currentCheckpoint();
    if (!checkpoint || this.policyRestored) return;
    const saved = await checkpoint.policy<RetryPolicy>(`context-retry:${this.employeeId}`);
    for (const [key, attempt] of saved?.attempted ?? []) this.attempted.set(key, attempt);
    for (const [key, failure] of saved?.unavailable ?? []) this.unavailableTools.set(key, failure);
    for (const [key, cooldown] of saved?.cooldowns ?? []) this.cooldowns.set(key, cooldown);
    this.policyRestored = true;
  }
  private async savePolicy() {
    const checkpoint = currentCheckpoint();
    if (!checkpoint) return;
    await checkpoint.policy<RetryPolicy>(`context-retry:${this.employeeId}`, () => ({
      attempted: [...this.attempted].map(([key, attempt]) => [
        key,
        { ...attempt, ...(attempt.failure ? { failure: failurePolicy(attempt.failure) } : {}) },
      ]),
      unavailable: [...this.unavailableTools].map(([key, failure]) => [
        key,
        failurePolicy(failure),
      ]),
      cooldowns: [...this.cooldowns].map(([key, cooldown]) => [
        key,
        { ...cooldown, failure: failurePolicy(cooldown.failure) },
      ]),
    }));
  }
  /** Harness utilities share the source proposal budget and live employee binding.
   * Their results are reviewed separately; they are never replayed as MCP reads.
   */
  async executeUtility(
    call: (authorizeResult: () => Promise<void>) => Promise<Record<string, unknown>>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.remaining <= 0)
      return { ok: false, code: this.denied ? 'ACCESS_DENIED' : 'TOOL_BUDGET_EXHAUSTED' };
    this.proposals++;
    const authorize = async () => {
      const current = await this.resolve(signal);
      signal.throwIfAborted();
      if (!current || current.employeeId !== this.employeeId)
        throw new ContextEngineError('AUTH_REQUIRED');
    };
    try {
      await authorize();
      // The utility invokes this recheck before accepting fresh or cached evidence.
      return await call(authorize);
    } catch (error) {
      if (error instanceof CheckpointError) throw error;
      signal.throwIfAborted();
      const code = error instanceof ContextEngineError ? error.code : 'UNAVAILABLE';
      if (code === 'AUTH_REQUIRED' || code === 'ACCESS_DENIED') this.denied = true;
      return { ok: false, code, retryable: false };
    }
  }
  get pagination() {
    return paginationCoverage(this.evidence);
  }
  private reusable(evidence: ToolEvidence, reader: BoundContextReader) {
    if (reader.allowEvidenceReuse !== true) return false;
    try {
      verifyToolEvidence(
        evidence.tool,
        evidence.arguments,
        evidence.result,
        this.now(),
        this.tools.find((tool) => tool.name === evidence.tool),
      );
      return true;
    } catch {
      return false;
    }
  }
  private retire(evidence: ToolEvidence) {
    const index = this.evidence.indexOf(evidence);
    if (index >= 0) this.evidence.splice(index, 1);
    this.retiredEvidenceIds.push(evidence.id);
    // bytes is cumulative work, not live array size: refreshing cannot reset the run's byte budget.
    return index;
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
      if (this.reusable(existing, current)) {
        const catalogue = current.describe
          ? await current.describe(signal)
          : { tools: await current.discover(signal) };
        const before = this.tools.find((tool) => tool.name === name);
        const after = catalogue.tools.find((tool) => tool.name === name);
        if (before && after && sameToolContract(before, after)) return existing;
      }
      if (this.remaining <= 0) {
        this.retire(existing);
        return undefined;
      }
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
    const operationId = this.runId ? runEvidenceId(this.runId, this.proposals) : randomUUID();
    let args: Record<string, unknown> = {};
    let fingerprint: string | undefined;
    let replaced: { id: string; index: number } | undefined;
    try {
      await this.restorePolicy();
      const tool = this.tools.find((tool) => tool.name === name);
      if (!tool) throw new ContextEngineError('TOOL_UNAVAILABLE');
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
      if (!schemaAccepts(tool.inputSchema, args)) throw new ContextEngineError('INVALID_ARGUMENTS');
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
        const currentCatalogue =
          reader.allowEvidenceReuse === true
            ? reader.describe
              ? await reader.describe(signal)
              : { tools: await reader.discover(signal) }
            : undefined;
        const currentTool = currentCatalogue?.tools.find((item) => item.name === name);
        if (this.reusable(cached, reader) && currentTool && sameToolContract(tool, currentTool)) {
          return {
            ok: true,
            evidence_id: cached.id,
            ...cached.result,
            reused_in_run: true,
            pagination: this.pagination,
          };
        }
        // Retire before the fresh attempt. A failed/cancelled refresh must not resurrect old facts.
        replaced = { id: cached.id, index: this.retire(cached) };
        // A successfully cached read starts a new bounded retry episode when it expires.
        this.attempted.delete(fingerprint);
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
      if (previous?.failure || previous?.pending) {
        const earlierFailure = previous.failure ?? {
          ok: false,
          code: 'UNAVAILABLE',
          retryable: true,
        };
        if (earlierFailure.retryable !== true || previous.count >= 2)
          return {
            ...earlierFailure,
            pagination: this.pagination,
            retryable: false,
            suppressed_repeat: true,
            guidance:
              'This query already failed. Do not vary irrelevant arguments to repeat it. Use a supported alternative or explain the limitation.',
          };
        if ((previous.retryAt ?? 0) > this.now())
          return {
            ...earlierFailure,
            pagination: this.pagination,
            retry_after_seconds: Math.ceil((previous.retryAt! - this.now()) / 1000),
            suppressed_repeat: true,
            guidance:
              'Retry-After has not elapsed. Do not bypass it by changing the query. Use another source or report that this source is temporarily busy.',
          };
      }
      const checkpoint = currentCheckpoint();
      if (checkpoint && !(await checkpoint.consume('tool', 1)))
        return { ok: false, code: 'TOOL_BUDGET_EXHAUSTED', retryable: false };
      this.attempted.set(fingerprint, { count: (previous?.count ?? 0) + 1, pending: true });
      // Reserve before dispatch: a crash leaves an ambiguous attempt, not a fresh retry episode.
      await this.savePolicy();
      signal.throwIfAborted();
      await this.record?.('tool_started', {
        version: 2,
        operationId,
        tool: name,
        employeeId: this.employeeId,
        arguments: args,
        ...(replaced ? { replacesEvidenceId: replaced.id } : {}),
      });
      const result = await reader.call(name, args, signal);
      signal.throwIfAborted();
      verifyToolEvidence(name, args, result, this.now(), tool);
      const size = Buffer.byteLength(JSON.stringify(result));
      if (this.bytes + size > MAX_RUN_EVIDENCE_BYTES)
        throw new ContextEngineError('RESPONSE_TOO_LARGE');
      if (checkpoint && !(await checkpoint.consume('bytes', size)))
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
      // A verified successful replay must not spend the next failure's retry allowance.
      this.attempted.delete(fingerprint);
      this.cooldowns.delete(name);
      await this.savePolicy();
      signal.throwIfAborted();
      this.bytes += size;
      for (const id of internalCrmReferences([evidence])) this.internalCrmIds.add(id);
      if (replaced) this.evidence.splice(replaced.index, 0, evidence);
      else this.evidence.push(evidence);
      return {
        ok: true,
        evidence_id: operationId,
        ...result,
        pagination: this.pagination,
        ...(replaced ? { replaces_evidence_id: replaced.id } : {}),
        ...(this.retiredEvidenceIds.length
          ? { retired_evidence_ids: [...this.retiredEvidenceIds] }
          : {}),
      };
    } catch (error) {
      if (error instanceof CheckpointError) throw error;
      signal.throwIfAborted();
      const code = error instanceof ContextEngineError ? error.code : 'UNAVAILABLE';
      if (code === 'AUTH_REQUIRED' || code === 'ACCESS_DENIED') this.denied = true;
      // No upstream exception bodies or failed tool data enter the model or logs.
      const tool = this.tools.some((item) => item.name === name) ? name : 'unknown';
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
        ...(this.retiredEvidenceIds.length
          ? { retired_evidence_ids: [...this.retiredEvidenceIds] }
          : {}),
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
              ? 'Check the current advertised schema and source guidance. Omit unset fields, and correct the invalid argument or filter combination.'
              : error instanceof ContextEngineError && error.retryable
                ? 'A transient read may be retried once with the same arguments, within the run deadline and after Retry-After if supplied. Do not change the query to bypass a delay. If recovery is unavailable, preserve useful results from other sources and explain the limitation.'
                : code === 'RESPONSE_TOO_LARGE'
                  ? 'Narrow the query or use a smaller page.'
                  : 'Report the limitation. A failed read does not mean there are no matching records.',
      };
      if (fingerprint) {
        const attempt = this.attempted.get(fingerprint);
        if (attempt) {
          delete attempt.pending;
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
      await this.savePolicy();
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
