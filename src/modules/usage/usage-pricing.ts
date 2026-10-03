/** Price only reported usage; never count reasoning twice or guess missing usage as zero. */
import type { UsagePrice } from '../../config/usage.js';
import type { UsageOperation, UsageSettlement } from './usage.types.js';
type UsageFields = Pick<
  UsageSettlement,
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedInputTokens'
  | 'cacheWriteTokens'
  | 'reasoningTokens'
  | 'audioInputTokens'
  | 'audioSeconds'
>;
export interface ReportedUsage {
  fields: UsageFields;
  valid: boolean;
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function reportedUsage(body: unknown, operation: UsageOperation): ReportedUsage {
  const u = (body as { usage?: any } | null)?.usage;
  if (!u || typeof u !== 'object') return { fields: {}, valid: false };
  if (operation === 'transcription' && u.type === 'duration') {
    return typeof u.seconds === 'number' && Number.isFinite(u.seconds) && u.seconds >= 0
      ? { fields: { audioSeconds: u.seconds }, valid: true }
      : { fields: {}, valid: false };
  }
  if (!count(u.input_tokens) || !count(u.output_tokens)) return { fields: {}, valid: false };
  const fields: UsageFields = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
  const cached = u.input_tokens_details?.cached_tokens;
  const reasoning = u.output_tokens_details?.reasoning_tokens;
  const audio = u.input_token_details?.audio_tokens;
  const cacheWrite = u.input_tokens_details?.cache_write_tokens;
  for (const [key, value, maximum] of [
    ['cachedInputTokens', cached, u.input_tokens],
    ['reasoningTokens', reasoning, u.output_tokens],
    ['audioInputTokens', audio, u.input_tokens],
  ] as const) {
    if (value !== undefined) {
      if (!count(value) || value > maximum) return { fields, valid: false };
      fields[key] = value;
    }
  }
  if (operation === 'transcription' && audio === undefined) return { fields, valid: false };
  if (cacheWrite !== undefined && (!count(cacheWrite) || cacheWrite > u.input_tokens))
    return { fields, valid: false };
  if (cacheWrite !== undefined) fields.cacheWriteTokens = cacheWrite;
  return { fields, valid: true };
}

function roundedMicros(numerator: bigint): number | null {
  const value = (numerator + 999_999n) / 1_000_000n;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}
export function priceUsage(usage: ReportedUsage, price?: UsagePrice): number | null {
  if (!price || !usage.valid) return null;
  const u = usage.fields;
  if (u.audioSeconds !== undefined) {
    if (price.durationMicrosPerSecond === undefined) return null;
    const amount = Math.ceil(u.audioSeconds * price.durationMicrosPerSecond);
    return Number.isSafeInteger(amount) ? amount : null;
  }
  if (u.inputTokens === undefined || u.outputTokens === undefined) return null;
  const cached = u.cachedInputTokens ?? 0,
    audio = u.audioInputTokens ?? 0,
    cacheWrite = u.cacheWriteTokens ?? 0;
  // These are disjoint input subsets. Never add a write premium to regular input.
  if (cached + audio + cacheWrite > u.inputTokens) return null;
  if (cached && price.cachedInputMicrosPerMillion === undefined) return null;
  if (cacheWrite && price.cacheWriteInputMicrosPerMillion === undefined) return null;
  // Without a reported cache split, differing cached-input rates cannot be priced exactly.
  if (
    u.cachedInputTokens === undefined &&
    u.audioInputTokens === undefined &&
    price.cachedInputMicrosPerMillion !== undefined &&
    price.cachedInputMicrosPerMillion !== price.inputMicrosPerMillion
  )
    return null;
  if (audio && price.audioInputMicrosPerMillion === undefined) return null;
  return roundedMicros(
    BigInt(u.inputTokens - cached - audio - cacheWrite) * BigInt(price.inputMicrosPerMillion) +
      BigInt(cached) * BigInt(price.cachedInputMicrosPerMillion ?? price.inputMicrosPerMillion) +
      BigInt(cacheWrite) * BigInt(price.cacheWriteInputMicrosPerMillion ?? 0) +
      BigInt(audio) * BigInt(price.audioInputMicrosPerMillion ?? 0) +
      BigInt(u.outputTokens) * BigInt(price.outputMicrosPerMillion),
  );
}

/** Conservative admission allowance from reviewed provider ceilings, not estimated prompt length. */
export function reserveUsage(
  price: UsagePrice | undefined,
  outputLimit?: number,
  operation: UsageOperation = 'responses',
): number | null {
  if (!price?.maxInputTokens) return null;
  // Compressed file size is not an upper bound on duration. No trusted duration limiter exists yet.
  if (operation === 'transcription' && price.durationMicrosPerSecond !== undefined) return null;
  if (operation === 'transcription' && price.audioInputMicrosPerMillion === undefined) return null;
  const output = outputLimit ?? price.maxOutputTokens;
  if (!count(output) || output < 1) return null;
  return roundedMicros(
    BigInt(price.maxInputTokens) *
      BigInt(
        Math.max(
          price.inputMicrosPerMillion,
          price.cachedInputMicrosPerMillion ?? 0,
          price.cacheWriteInputMicrosPerMillion ?? 0,
          price.audioInputMicrosPerMillion ?? 0,
        ),
      ) +
      BigInt(output) * BigInt(price.outputMicrosPerMillion),
  );
}
