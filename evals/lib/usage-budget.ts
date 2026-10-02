/** One explicitly approved currency allowance for agent, grader and media requests. */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUsagePolicy } from '../../src/config/usage.js';
import { MemoryUsageLedger } from '../../src/modules/usage/memory-ledger.js';
import { UsageMeter } from '../../src/modules/usage/usage-meter.js';
import { UsageBudgetError, type UsageSummary } from '../../src/modules/usage/usage.types.js';

export const evalBudgetOptions = { 'max-usd': { type: 'string' } } as const;
export interface EvalBudgetOptions {
  'max-usd'?: string;
  campaignId?: string;
  directory?: string | URL;
}

/** Decimal USD only; no rounding up, exponents or floating-point conversion. */
export function evalAllowanceMicros(
  options: Pick<EvalBudgetOptions, 'max-usd'>,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = options['max-usd'] ?? env.EVAL_MAX_USD;
  if (!value) throw new Error('EVAL_MAX_USD_REQUIRED: provide the approved --max-usd allowance');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new Error('INVALID_EVAL_MAX_USD');
  const [whole, fraction = ''] = value.split('.');
  const micros = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (micros < 1n || micros > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('INVALID_EVAL_MAX_USD');
  return Number(micros);
}

/** Separate processes receive disjoint allowances, never a fresh copy of the total cap. */
export function splitEvalAllowance(micros: number, profiles: number): string {
  if (
    !Number.isSafeInteger(micros) ||
    micros < 1 ||
    !Number.isSafeInteger(profiles) ||
    profiles < 1
  )
    throw new Error('INVALID_EVAL_BUDGET_SPLIT');
  const each = Math.floor(micros / profiles);
  if (each < 1) throw new Error('EVAL_BUDGET_TOO_SMALL_TO_SPLIT');
  return `${Math.floor(each / 1_000_000)}.${String(each % 1_000_000).padStart(6, '0')}`;
}

/** Local accounting cannot control paid work inside an already-running remote graph. */
export function assertRemoteEvaluationBudget(): void {
  throw new Error(
    'REMOTE_EVAL_BUDGET_UNSUPPORTED: private HTTP evaluations require a server-enforced shared campaign allowance covering agent and grader before they can run. No requests were sent.',
  );
}

class EvalUsageMeter extends UsageMeter {
  private stoppedReason?: UsageBudgetError['code'];

  constructor(
    private readonly evalLedger: MemoryUsageLedger,
    config: ConstructorParameters<typeof UsageMeter>[1],
    readonly manifest: {
      campaignId: string;
      maxMicros: number;
      priceVersion: string;
      models: string[];
    },
    private readonly directory: string,
    private readonly runIds: Set<string>,
  ) {
    super(evalLedger, config);
  }

  override wrapFetch(implementation: typeof fetch): typeof fetch {
    const metered = super.wrapFetch(implementation);
    return async (input, init) => {
      if (this.stoppedReason) throw new UsageBudgetError(this.stoppedReason);
      try {
        return await metered(input, init);
      } catch (error) {
        // Already admitted requests can finish. Later stages/cases cannot resume spending
        // just because their smaller request would fit after a larger one was denied.
        if (error instanceof UsageBudgetError) this.stoppedReason ??= error.code;
        throw error;
      }
    };
  }

  async report() {
    const totals: UsageSummary = {
      requestCount: 0,
      settledRequests: 0,
      pendingRequests: 0,
      unknownRequests: 0,
      knownActualMicros: 0,
      heldMicros: 0,
      unpricedRequests: 0,
      costComplete: true,
    };
    for (const runId of this.runIds) {
      const summary = await this.evalLedger.summarize('local-evaluations', 'evaluation', runId);
      for (const key of Object.keys(totals) as Array<keyof UsageSummary>) {
        if (key === 'costComplete') totals.costComplete &&= summary.costComplete;
        else {
          totals[key] += summary[key];
          if (!Number.isSafeInteger(totals[key])) throw new Error('EVAL_USAGE_TOTAL_OVERFLOW');
        }
      }
    }
    const result = {
      ...this.manifest,
      ...totals,
      ...(this.stoppedReason ? { stoppedReason: this.stoppedReason } : {}),
    };
    await writeFile(join(this.directory, 'usage-summary.json'), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    return result;
  }
}

export async function createEvalUsageMeter(
  options: EvalBudgetOptions,
  env: NodeJS.ProcessEnv = process.env,
  models: readonly string[] = [],
) {
  const maxMicros = evalAllowanceMicros(options, env);
  const policy = loadUsagePolicy({
    ...env,
    USAGE_MODE: 'observe',
    USAGE_PRICES_JSON: env.EVAL_USAGE_PRICES_JSON ?? env.USAGE_PRICES_JSON,
    USAGE_RUN_MAX_USD: undefined,
    USAGE_SUBJECT_DAY_MAX_USD: undefined,
    USAGE_ACCOUNT_DAY_MAX_USD: undefined,
  });
  if (!policy.prices) throw new Error('EVAL_USAGE_PRICES_REQUIRED');
  for (const model of models)
    if (!policy.prices.models[model]) throw new Error('EVAL_MODEL_PRICE_REQUIRED');
  const campaignId = options.campaignId ?? randomUUID();
  const directory =
    options.directory instanceof URL
      ? fileURLToPath(options.directory)
      : (options.directory ??
        fileURLToPath(new URL(`../../.local/eval-usage/${campaignId}/`, import.meta.url)));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = {
    campaignId,
    maxMicros,
    priceVersion: policy.prices.version,
    models: [...new Set(models)],
  };
  // The rate snapshot is metadata, never API keys, source evidence or user messages.
  await writeFile(
    join(directory, 'usage-policy.json'),
    JSON.stringify({ ...manifest, prices: policy.prices }, null, 2),
    { mode: 0o600, flag: 'wx' },
  );
  const ledger = new MemoryUsageLedger('local-evaluations', 'evaluation');
  const runIds = new Set<string>();
  return new EvalUsageMeter(
    ledger,
    {
      accountId: 'local-evaluations',
      purpose: 'evaluation',
      campaignId,
      policy: { ...policy, mode: 'enforce', limits: { campaignMicros: maxMicros } },
      observe: async (event) => {
        runIds.add(event.type === 'reserved' ? event.reservation.runId : event.runId);
        await appendFile(join(directory, 'usage-ledger.ndjson'), JSON.stringify(event) + '\n', {
          mode: 0o600,
        });
      },
    },
    manifest,
    directory,
    runIds,
  );
}

/** Wait for admitted work to settle and preserve accounting even if an artifact/worker fails. */
export async function settleEvalWorkers<T>(
  meter: { report(): Promise<T> },
  workers: readonly Promise<unknown>[],
): Promise<T> {
  let summary: T;
  try {
    const outcomes = await Promise.allSettled(workers);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  } finally {
    summary = await meter.report();
  }
  return summary;
}
