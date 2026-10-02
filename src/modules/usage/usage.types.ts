/** Monetary accounting uses integer USD millionths. No prompt, media or credentials belong here. */
export type UsagePurpose = 'production' | 'playground' | 'evaluation';
export type UsageOperation = 'responses' | 'transcription';

export interface UsageReservation {
  id: string;
  accountId: string;
  purpose: UsagePurpose;
  runId: string;
  subjectId?: string;
  stage: string;
  model: string;
  operation: UsageOperation;
  /** Zero-based provider retry attempt, when supplied by the SDK transport. */
  attempt?: number;
  priceVersion?: string;
  reservedMicros: number | null;
  buckets: Array<{ key: string; limitMicros: number }>;
  enforce: boolean;
}

export interface UsageSettlement {
  state: 'settled' | 'unknown';
  actualMicros: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  audioInputTokens?: number;
  audioSeconds?: number;
  responseId?: string;
  requestId?: string;
  status?: number;
  durationMs: number;
}

export interface UsageSummary {
  requestCount: number;
  settledRequests: number;
  pendingRequests: number;
  unknownRequests: number;
  knownActualMicros: number;
  heldMicros: number;
  unpricedRequests: number;
  costComplete: boolean;
}

export interface UsageLedger {
  reserve(reservation: UsageReservation): Promise<void>;
  settle(id: string, settlement: UsageSettlement): Promise<void>;
  summarize(accountId: string, purpose: UsagePurpose, runId: string): Promise<UsageSummary>;
}

export class UsageBudgetError extends Error {
  constructor(
    readonly code: 'USAGE_BUDGET_EXCEEDED' | 'USAGE_PRICE_UNKNOWN' | 'USAGE_ACCOUNTING_UNKNOWN',
    readonly bucketKey?: string,
  ) {
    super(code);
    this.name = 'UsageBudgetError';
  }
}

export class UsageConflictError extends Error {
  constructor(
    readonly code:
      | 'USAGE_RESERVATION_CONFLICT'
      | 'USAGE_SETTLEMENT_CONFLICT'
      | 'USAGE_RESERVATION_NOT_FOUND',
  ) {
    super(code);
    this.name = 'UsageConflictError';
  }
}

const integerFields = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'audioInputTokens',
  'durationMs',
] as const;

function integer(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('INVALID_USAGE_NUMBER');
}

function reference(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    /[\r\n\x00]/u.test(value)
  )
    throw new Error('INVALID_USAGE_REFERENCE');
}

export function validateUsageScope(accountId: string, purpose: UsagePurpose): void {
  reference(accountId);
  if (!['production', 'playground', 'evaluation'].includes(purpose))
    throw new Error('INVALID_USAGE_PURPOSE');
}

/** Explicit fields and stable ordering make retry comparisons independent of object key order. */
export function normalizeReservation(value: UsageReservation): UsageReservation {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(value.id))
    throw new Error('INVALID_USAGE_ID');
  validateUsageScope(value.accountId, value.purpose);
  for (const field of ['runId', 'stage', 'model'] as const) reference(value[field]);
  if (value.subjectId !== undefined) reference(value.subjectId);
  if (value.priceVersion !== undefined) reference(value.priceVersion);
  if (value.attempt !== undefined) integer(value.attempt);
  if (!['responses', 'transcription'].includes(value.operation))
    throw new Error('INVALID_USAGE_OPERATION');
  if (typeof value.enforce !== 'boolean') throw new Error('INVALID_USAGE_ENFORCEMENT');
  if (value.reservedMicros !== null) integer(value.reservedMicros);
  if (!Array.isArray(value.buckets) || value.buckets.length > 16)
    throw new Error('INVALID_USAGE_BUCKETS');
  if (value.enforce && value.buckets.length === 0) throw new Error('INVALID_USAGE_BUCKETS');
  const buckets = value.buckets
    .map((bucket) => {
      reference(bucket.key);
      integer(bucket.limitMicros);
      return { key: bucket.key, limitMicros: bucket.limitMicros };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
  if (new Set(buckets.map((bucket) => bucket.key)).size !== buckets.length)
    throw new Error('DUPLICATE_USAGE_BUCKET');
  return {
    id: value.id.toLowerCase(),
    accountId: value.accountId,
    purpose: value.purpose,
    runId: value.runId,
    ...(value.subjectId === undefined ? {} : { subjectId: value.subjectId }),
    stage: value.stage,
    model: value.model,
    operation: value.operation,
    ...(value.attempt === undefined ? {} : { attempt: value.attempt }),
    ...(value.priceVersion === undefined ? {} : { priceVersion: value.priceVersion }),
    reservedMicros: value.reservedMicros,
    buckets,
    enforce: value.enforce,
  };
}

export function normalizeSettlement(value: UsageSettlement): UsageSettlement {
  if (!['settled', 'unknown'].includes(value.state)) throw new Error('INVALID_USAGE_STATE');
  if (value.actualMicros !== null) integer(value.actualMicros);
  if ((value.state === 'settled') !== (value.actualMicros !== null))
    throw new Error('INVALID_USAGE_SETTLEMENT');
  for (const field of integerFields) {
    if (field === 'durationMs' || value[field] !== undefined) integer(value[field]);
  }
  if (
    value.audioSeconds !== undefined &&
    (!Number.isFinite(value.audioSeconds) || value.audioSeconds < 0)
  )
    throw new Error('INVALID_USAGE_NUMBER');
  if (value.status !== undefined) {
    integer(value.status);
    if (value.status < 100 || value.status > 599) throw new Error('INVALID_USAGE_STATUS');
  }
  if (value.responseId !== undefined) reference(value.responseId);
  if (value.requestId !== undefined) reference(value.requestId);
  return {
    state: value.state,
    actualMicros: value.actualMicros,
    ...Object.fromEntries(
      integerFields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
    ),
    ...(value.audioSeconds === undefined ? {} : { audioSeconds: value.audioSeconds }),
    ...(value.responseId === undefined ? {} : { responseId: value.responseId }),
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
    ...(value.status === undefined ? {} : { status: value.status }),
    durationMs: value.durationMs,
  };
}

export interface UsageRecord {
  reservation: UsageReservation;
  settlement?: UsageSettlement;
}

export function assertUsageAdmission(
  reservation: UsageReservation,
  consumption: Map<string, { micros: bigint; unpriced: number }>,
): void {
  if (!reservation.enforce) return;
  if (reservation.reservedMicros === null) throw new UsageBudgetError('USAGE_PRICE_UNKNOWN');
  for (const bucket of reservation.buckets) {
    const spent = consumption.get(bucket.key);
    if (spent?.unpriced) throw new UsageBudgetError('USAGE_ACCOUNTING_UNKNOWN', bucket.key);
    if ((spent?.micros ?? 0n) + BigInt(reservation.reservedMicros) > BigInt(bucket.limitMicros))
      throw new UsageBudgetError('USAGE_BUDGET_EXCEEDED', bucket.key);
  }
}

export function safeUsageNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n)
    throw new Error('USAGE_TOTAL_OVERFLOW');
  return Number(value);
}

export function summarizeUsage(records: Iterable<UsageRecord>): UsageSummary {
  let knownActual = 0n;
  let held = 0n;
  const result: UsageSummary = {
    requestCount: 0,
    settledRequests: 0,
    pendingRequests: 0,
    unknownRequests: 0,
    knownActualMicros: 0,
    heldMicros: 0,
    unpricedRequests: 0,
    costComplete: true,
  };
  for (const record of records) {
    result.requestCount++;
    if (record.settlement?.state === 'settled') {
      result.settledRequests++;
      knownActual += BigInt(record.settlement.actualMicros!);
    } else {
      result.costComplete = false;
      if (record.settlement) result.unknownRequests++;
      else result.pendingRequests++;
      if (record.reservation.reservedMicros === null) result.unpricedRequests++;
      else held += BigInt(record.reservation.reservedMicros);
    }
  }
  result.knownActualMicros = safeUsageNumber(knownActual);
  result.heldMicros = safeUsageNumber(held);
  return result;
}
