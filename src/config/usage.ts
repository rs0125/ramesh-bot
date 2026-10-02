/** Operator-owned pricing and budget policy. No default dollar allowance or inferred model prices. */
import { z } from 'zod';

const micros = z.number().int().nonnegative().safe();
const ceiling = z.number().int().positive().max(100_000_000);
export const usagePriceSchema = z
  .object({
    inputMicrosPerMillion: micros,
    outputMicrosPerMillion: micros,
    cachedInputMicrosPerMillion: micros.optional(),
    audioInputMicrosPerMillion: micros.optional(),
    durationMicrosPerSecond: micros.optional(),
    /** Reviewed provider ceilings, not a token estimate from characters or compressed audio bytes. */
    maxInputTokens: ceiling.optional(),
    maxOutputTokens: ceiling.optional(),
  })
  .strict();
export type UsagePrice = z.infer<typeof usagePriceSchema>;
export const usagePricesSchema = z
  .object({
    version: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    models: z.record(z.string().regex(/^[A-Za-z0-9._-]{1,100}$/), usagePriceSchema),
  })
  .strict();
export interface UsagePolicy {
  mode: 'off' | 'observe' | 'enforce';
  prices?: z.infer<typeof usagePricesSchema>;
  limits: {
    runMicros?: number;
    subjectDayMicros?: number;
    accountDayMicros?: number;
    campaignMicros?: number;
  };
}

export function usdToMicros(value: string): number {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw new Error('INVALID_USAGE_USD');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_USAGE_USD');
  return Number(result);
}

export function loadUsagePolicy(env: NodeJS.ProcessEnv): UsagePolicy {
  const mode = env.USAGE_MODE ?? 'off';
  if (!['off', 'observe', 'enforce'].includes(mode)) throw new Error('INVALID_USAGE_MODE');
  let prices: UsagePolicy['prices'];
  if (env.USAGE_PRICES_JSON) {
    try {
      if (Buffer.byteLength(env.USAGE_PRICES_JSON) > 64000) throw new Error();
      prices = usagePricesSchema.parse(JSON.parse(env.USAGE_PRICES_JSON));
    } catch {
      throw new Error('INVALID_USAGE_PRICES');
    }
  }
  const limits: UsagePolicy['limits'] = {};
  for (const [name, key] of [
    ['USAGE_RUN_MAX_USD', 'runMicros'],
    ['USAGE_SUBJECT_DAY_MAX_USD', 'subjectDayMicros'],
    ['USAGE_ACCOUNT_DAY_MAX_USD', 'accountDayMicros'],
  ] as const) {
    if (env[name] !== undefined) limits[key] = usdToMicros(env[name]!);
  }
  if (mode === 'off' && Object.keys(limits).length) throw new Error('USAGE_LIMITS_DISABLED');
  if (mode === 'enforce' && (!prices || !Object.keys(limits).length))
    throw new Error('USAGE_ENFORCEMENT_POLICY_REQUIRED');
  return { mode: mode as UsagePolicy['mode'], ...(prices ? { prices } : {}), limits };
}
