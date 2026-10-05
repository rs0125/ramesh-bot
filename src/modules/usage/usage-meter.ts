/** Meter the HTTP boundary so SDK retries, incomplete responses and auxiliary calls are included. */
import { randomUUID } from 'node:crypto';
import type { UsagePolicy } from '../../config/usage.js';
import { currentUsageScope, withUsageScope, type UsageScope } from './usage-scope.js';
import { reportedUsage, priceUsage, reserveUsage } from './usage-pricing.js';
import type {
  UsageLedger,
  UsageOperation,
  UsagePurpose,
  UsageReservation,
  UsageSettlement,
} from './usage.types.js';
import { UsageBudgetError, UsageConflictError } from './usage.types.js';
export type UsageEvent =
  | { type: 'reserved'; reservation: UsageReservation }
  | { type: 'settled'; id: string; runId: string; settlement: UsageSettlement };

function tokenPricedTool(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const tool = value as { type?: unknown; execution?: unknown; tools?: unknown };
  if (tool.type === 'function') return true;
  // Hosted tool search uses model tokens. Other hosted tools have separate fees.
  // Reviewed against https://developers.openai.com/api/docs/pricing on 2026-10-05.
  if (tool.type === 'tool_search')
    return tool.execution === undefined || tool.execution === 'server';
  return (
    tool.type === 'namespace' &&
    Array.isArray(tool.tools) &&
    tool.tools.every(
      (child: unknown) =>
        child !== null && typeof child === 'object' && 'type' in child && child.type === 'function',
    )
  );
}

export class UsageMeter {
  private failure?: string;
  constructor(
    readonly ledger: UsageLedger,
    readonly options: {
      accountId: string;
      purpose: UsagePurpose;
      policy: UsagePolicy;
      campaignId?: string;
      observe?: (event: UsageEvent) => void | Promise<void>;
      now?: () => number;
    },
  ) {
    const { policy } = options;
    if (policy.mode === 'enforce' && (!policy.prices || !Object.keys(policy.limits).length))
      throw new Error('USAGE_ENFORCEMENT_POLICY_REQUIRED');
    if (policy.limits.campaignMicros !== undefined && !options.campaignId)
      throw new Error('USAGE_CAMPAIGN_REQUIRED');
  }
  run<T>(scope: UsageScope, work: () => Promise<T>) {
    return withUsageScope(scope, work);
  }
  summarize(runId: string) {
    return this.ledger.summarize(this.options.accountId, this.options.purpose, runId);
  }
  wrapFetch(fetcher: typeof fetch): typeof fetch {
    if (this.options.policy.mode === 'off') return fetcher;
    return async (input, init) => {
      if (this.failure) throw new Error(this.failure);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== 'https://api.openai.com') throw new Error('USAGE_PROVIDER_NOT_SUPPORTED');
      // Exact input counting does not generate tokens. Keep all generating endpoints metered.
      if (
        url.pathname === '/v1/responses/input_tokens' &&
        (init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'POST'
      )
        return fetcher(input, init);
      const operation: UsageOperation =
        url.pathname === '/v1/responses'
          ? 'responses'
          : url.pathname === '/v1/audio/transcriptions'
            ? 'transcription'
            : (() => {
                throw new Error('USAGE_OPERATION_NOT_SUPPORTED');
              })();
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.throwIfAborted();
      const body =
        init?.body ??
        (input instanceof Request
          ? operation === 'responses'
            ? await input.clone().text()
            : await input.clone().formData()
          : undefined);
      let model: unknown,
        outputLimit: number | undefined,
        unsupportedPricing = false;
      if (operation === 'responses' && typeof body === 'string') {
        const value = JSON.parse(body);
        model = value.model;
        // Profiles cover standard-tier token billing, not hosted tool fees or asynchronous streams.
        unsupportedPricing =
          value.service_tier !== 'default' ||
          value.background === true ||
          value.stream === true ||
          (Array.isArray(value.tools) &&
            value.tools.some((tool: unknown) => !tokenPricedTool(tool)));
        if (unsupportedPricing && this.options.policy.mode === 'enforce')
          throw new Error('USAGE_REQUEST_PRICING_UNSUPPORTED');
        if (Number.isSafeInteger(value.max_output_tokens) && value.max_output_tokens > 0)
          outputLimit = value.max_output_tokens;
      } else if (body instanceof FormData) model = body.get('model');
      if (typeof model !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(model))
        throw new Error('USAGE_MODEL_NOT_IDENTIFIED');
      const now = this.options.now ?? Date.now;
      const started = now();
      const scope = currentUsageScope();
      if (
        this.options.policy.mode === 'enforce' &&
        (!scope?.scope.runId || scope.scope.runId === 'unscoped') &&
        !this.options.campaignId
      )
        throw new Error('USAGE_RUN_SCOPE_REQUIRED');
      const runId =
        scope?.scope.runId && scope.scope.runId !== 'unscoped'
          ? scope.scope.runId
          : (this.options.campaignId ?? randomUUID());
      const subjectId = scope?.scope.subjectId;
      const day = new Date(started).toISOString().slice(0, 10);
      const policy = this.options.policy;
      const price = policy.prices?.models[model];
      const retry = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      ).get('x-stainless-retry-count');
      const reservation: UsageReservation = {
        id: randomUUID(),
        accountId: this.options.accountId,
        purpose: this.options.purpose,
        runId,
        ...(subjectId ? { subjectId } : {}),
        stage: scope?.stage ?? (operation === 'transcription' ? 'transcription' : 'unscoped'),
        operation,
        model,
        ...(policy.prices ? { priceVersion: policy.prices.version } : {}),
        ...(retry && /^\d{1,3}$/.test(retry) ? { attempt: Number(retry) } : {}),
        reservedMicros: reserveUsage(
          price,
          operation === 'responses' ? outputLimit : undefined,
          operation,
        ),
        enforce: policy.mode === 'enforce',
        buckets: [],
      };
      for (const [key, limitMicros] of [
        [`run:${runId}`, policy.limits.runMicros],
        [`subject:${subjectId ?? 'unresolved'}:${day}`, policy.limits.subjectDayMicros],
        [`account:${day}`, policy.limits.accountDayMicros],
        [`campaign:${this.options.campaignId}`, policy.limits.campaignMicros],
      ] as const)
        if (limitMicros !== undefined) reservation.buckets.push({ key, limitMicros });
      await this.reserve(reservation);
      await this.notify({ type: 'reserved', reservation });
      // The reservation remains held if cancellation or a process crash follows admission.
      signal?.throwIfAborted();
      let response: Response;
      try {
        response = await fetcher(input, init);
      } catch (error) {
        await this.settle(reservation, {
          state: 'unknown',
          actualMicros: null,
          durationMs: Math.max(0, now() - started),
        });
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = await response.clone().json();
      } catch {
        /* Unknown is never zero. */
      }
      const usage = reportedUsage(parsed, operation);
      const tier = (parsed as { service_tier?: unknown } | null)?.service_tier;
      const tierMismatch =
        operation === 'responses' && tier !== undefined && tier !== null && tier !== 'default';
      const actualMicros = unsupportedPricing || tierMismatch ? null : priceUsage(usage, price);
      const responseId = (parsed as { id?: unknown } | null)?.id;
      const requestId = response.headers.get('x-request-id');
      const validId = (id: unknown): id is string =>
        typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);
      await this.settle(reservation, {
        state: actualMicros === null ? 'unknown' : 'settled',
        actualMicros,
        ...usage.fields,
        ...(validId(responseId) ? { responseId } : {}),
        ...(validId(requestId) ? { requestId } : {}),
        status: response.status,
        durationMs: Math.max(0, now() - started),
      });
      if (tierMismatch && policy.mode === 'enforce') {
        this.failure = 'USAGE_PROVIDER_PRICE_MISMATCH';
        throw new Error(this.failure);
      }
      return response;
    };
  }
  private async reserve(reservation: UsageReservation) {
    try {
      await this.ledger.reserve(reservation);
    } catch (error) {
      if (error instanceof UsageBudgetError || error instanceof UsageConflictError) throw error;
      this.failure = 'USAGE_LEDGER_UNAVAILABLE';
      throw new Error(this.failure);
    }
  }
  private async settle(reservation: UsageReservation, settlement: UsageSettlement) {
    try {
      await this.ledger.settle(reservation.id, settlement);
    } catch {
      this.failure = 'USAGE_LEDGER_UNAVAILABLE';
      throw new Error(this.failure);
    }
    await this.notify({
      type: 'settled',
      id: reservation.id,
      runId: reservation.runId,
      settlement,
    });
  }
  private async notify(event: UsageEvent) {
    try {
      await this.options.observe?.(event);
    } catch {
      this.failure = 'USAGE_OBSERVER_UNAVAILABLE';
      throw new Error(this.failure);
    }
  }
}
