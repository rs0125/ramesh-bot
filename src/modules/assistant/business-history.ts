/** Historical observations, never live evidence, authorization or executable tool calls. */
import { z } from 'zod';
import { TOOL_NAME } from '../context-engine/read-contract.js';

export const BUSINESS_HISTORY_PREFIX = '[Historical tool reply]\n';
export const BUSINESS_HISTORY_DAYS = 30;
export const BUSINESS_HISTORY_TOKENS = 6000;
export const BUSINESS_HISTORY_BYTES = 96000;
export const HISTORY_TURN_ID = /^turn-[a-f0-9]{24}$/;

/** Original user wording is historical data, never a new instruction or source fact. */
export function historyRequest(text: string) {
  return text.length <= 2000
    ? text
    : `${text.slice(0, 1200)}\n[... original request excerpt omitted ...]\n${text.slice(-700)}`;
}
// List bodies can exceed the generic node/byte limits before their last rows or
// selection ID are visited. Keep the bounded, ordered references separately so
// "the ninth item from the earlier list" still identifies the original selection.
// These are historical selectors, never permission or a substitute for current
// owner/version checks in the personal repository. Whole old entries can still
// expire or be evicted by the normal history budget.
const personalSelectionSchema = z
  .object({
    kind: z.enum(['task', 'reminder']),
    selectionId: z.string().min(1).max(200),
    nextCursor: z.string().min(1).max(300).nullable(),
    records: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            version: z.number().int().positive().safe(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .refine((value) => new Set(value.records.map((row) => row.id)).size === value.records.length);

export const toolActivitySchema = z
  .object({
    tool: z.string().regex(TOOL_NAME),
    at: z.iso.datetime({ offset: true }),
    status: z.enum([
      'succeeded',
      'failed',
      'interrupted',
      'staged',
      'awaiting_confirmation',
      'committed',
      'not_dispatched',
      'uncertain',
      'cancelled',
      'expired',
    ]),
    phase: z.enum(['call', 'commit', 'recovery']).optional(),
    operationId: z.string().min(1).max(200).optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    argumentsOmitted: z.literal(true).optional(),
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .optional(),
    retryable: z.boolean().optional(),
    retryAfterSeconds: z.number().finite().nonnegative().optional(),
    records: z
      .array(
        z
          .object({
            kind: z.enum(['crm_lead', 'warehouse', 'knowledge']),
            id: z.union([z.string().min(1).max(160), z.number().int().positive().safe()]),
            name: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    returnedCount: z.number().int().nonnegative().optional(),
    personalSelection: personalSelectionSchema.optional(),
    result: z.unknown().optional(),
    resultOmitted: z.literal(true).optional(),
  })
  .strict();
export type ToolActivity = z.infer<typeof toolActivitySchema>;
/** Preserve selectors, outcomes, operation identity and record references before result bodies. */
export function compactToolActivity({ result, ...activity }: ToolActivity): ToolActivity {
  return { ...activity, ...(result === undefined ? {} : { resultOmitted: true as const }) };
}

export function boundToolActivity(activity: ToolActivity[]) {
  const entries = [...activity];
  let omitted = 0;
  while (entries.length > 24) {
    entries.shift();
    omitted++;
  }
  for (
    let index = 0;
    index < entries.length && Buffer.byteLength(JSON.stringify(entries)) > 24000;
    index++
  )
    entries[index] = compactToolActivity(entries[index]!);
  while (entries.length && Buffer.byteLength(JSON.stringify(entries)) > 24000) {
    entries.shift();
    omitted++;
  }
  return { activity: entries, omittedCount: omitted };
}
export const toolHistorySchema = z
  .object({
    at: z.iso.datetime({ offset: true }),
    activity: z.array(toolActivitySchema).max(24),
    omittedCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const sensitive =
  /^(?:authorization|headers?|.*(?:token|secret|password|credential|api.?key)|employee_?id|user_?id|phoneE164|phone_number|remoteJid|participant|scopes|idempotency_key|original_operation_id)$/i;

/** Bounded source output, not a model-generated summary. Never copy exception bodies. */
function historicalResult(value: unknown): Pick<ToolActivity, 'result' | 'resultOmitted'> {
  let omitted = false;
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 100 || depth > 5) {
      omitted = true;
      return '[omitted]';
    }
    if (typeof item === 'string' && item.length > 600) {
      omitted = true;
      return item.slice(0, 600) + '[truncated]';
    }
    if (Array.isArray(item)) {
      if (item.length > 10) omitted = true;
      return item.slice(0, 10).map((child) => visit(child, depth + 1));
    }
    if (item && typeof item === 'object') {
      const entries = Object.entries(item);
      if (entries.length > 24) omitted = true;
      return Object.fromEntries(
        entries.slice(0, 24).flatMap(([key, child]) => {
          if (sensitive.test(key)) {
            omitted = true;
            return [];
          }
          return [[key, visit(child, depth + 1)]];
        }),
      );
    }
    return item;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result) ?? '') > 4000) return { resultOmitted: true };
  return { result, ...(omitted ? { resultOmitted: true } : {}) };
}

function historicalPersonalSelection(
  tool: string,
  value: Record<string, unknown> | undefined,
): Pick<ToolActivity, 'personalSelection'> {
  if (
    tool !== 'personal_list' ||
    value?.ok !== true ||
    !Array.isArray(value.records) ||
    value.records.length > 50 ||
    !value.records.every(
      (row) => row && typeof row === 'object' && !Array.isArray(row) && row.kind === value.kind,
    )
  )
    return {};
  const parsed = personalSelectionSchema.safeParse({
    kind: value.kind,
    selectionId: value.selectionId,
    nextCursor: value.nextCursor,
    // Copy only selector fields from the actual result, never arbitrary tool text.
    records: value.records.map((row) => ({ id: row.id, version: row.version })),
  });
  return parsed.success ? { personalSelection: parsed.data } : {};
}

/** Shared by every tool family. Recording never authorizes, dispatches or retries a tool. */
export class ToolHistory {
  private readonly entries: ToolActivity[] = [];
  private omitted = 0;
  constructor(private readonly now: () => number) {}
  get activity(): ToolActivity[] {
    return structuredClone(this.entries);
  }
  get used() {
    return this.entries.length > 0;
  }
  snapshot() {
    return {
      at: new Date(this.now()).toISOString(),
      activity: this.activity,
      ...(this.omitted ? { omittedCount: this.omitted } : {}),
    };
  }
  record(
    tool: string,
    input: string | undefined,
    output: unknown,
    details: Partial<
      Pick<ToolActivity, 'status' | 'phase' | 'operationId' | 'records' | 'returnedCount'>
    > = {},
  ) {
    const value =
      output && typeof output === 'object' ? (output as Record<string, unknown>) : undefined;
    const status = !value
      ? 'interrupted'
      : value.ok === false
        ? 'failed'
        : ['staged_not_committed', 'draft_not_executed'].includes(String(value.status))
          ? 'staged'
          : 'succeeded';
    const code =
      typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)
        ? value.code
        : undefined;
    const entry = toolActivitySchema.safeParse({
      tool,
      at: new Date(this.now()).toISOString(),
      status,
      phase: 'call',
      ...(input === undefined ? { argumentsOmitted: true } : historicalArguments(input)),
      ...(code ? { code } : {}),
      ...(typeof value?.retryable === 'boolean' ? { retryable: value.retryable } : {}),
      ...(typeof value?.retry_after_seconds === 'number' &&
      Number.isFinite(value.retry_after_seconds) &&
      value.retry_after_seconds >= 0
        ? { retryAfterSeconds: value.retry_after_seconds }
        : {}),
      ...(value && value.ok !== false ? historicalResult(value) : {}),
      ...historicalPersonalSelection(tool, value),
      ...details,
    });
    if (!entry.success) return;
    this.entries.push(entry.data);
    const bounded = boundToolActivity(this.entries);
    this.entries.splice(0, this.entries.length, ...bounded.activity);
    this.omitted += bounded.omittedCount;
  }
  async track<T>(tool: string, input: string, call: () => Promise<T>): Promise<T> {
    let result: T | undefined;
    try {
      result = await call();
      return result;
    } finally {
      this.record(tool, input, result);
    }
  }
}

/** Never persist raw malformed input, authority fields or exception bodies in chat memory. */
export function historicalArguments(
  input: string,
): Pick<ToolActivity, 'arguments' | 'argumentsOmitted'> {
  if (Buffer.byteLength(input) > 2048) return { argumentsOmitted: true };
  try {
    const value = JSON.parse(input);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { argumentsOmitted: true };
    const inspect = (item: unknown): boolean =>
      item !== null &&
      typeof item === 'object' &&
      Object.entries(item).some(([key, child]) => sensitive.test(key) || inspect(child));
    return inspect(value) ? { argumentsOmitted: true } : { arguments: value };
  } catch {
    return { argumentsOmitted: true };
  }
}

export function historicalRecords(
  tool: string,
  data: Record<string, unknown>,
): Pick<ToolActivity, 'records' | 'returnedCount'> {
  const kind = /^(?:search_crm_leads|read_crm_lead|crm_briefing)$/.test(tool)
    ? ('crm_lead' as const)
    : /^(?:search_warehouses|read_warehouse)$/.test(tool)
      ? ('warehouse' as const)
      : /^(?:search_knowledge|read_knowledge)$/.test(tool)
        ? ('knowledge' as const)
        : undefined;
  if (!kind) return {};
  const rows = tool.startsWith('read_')
    ? [data]
    : tool === 'crm_briefing'
      ? data.priorities
      : data.items;
  if (!Array.isArray(rows)) return {};
  const records = rows.slice(0, 32).flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const name = row.name ?? row.title;
    const parsed = toolActivitySchema.shape.records.unwrap().element.safeParse({
      kind,
      id: row.id,
      ...(typeof name === 'string' ? { name: name.slice(0, 200) } : {}),
    });
    return parsed.success ? [parsed.data] : [];
  });
  return { records, returnedCount: rows.length };
}
