/** A mixed reply must satisfy both private authorization boundaries before any part is sent. */
import { z } from 'zod';
import { personalDeliverySchema } from '../scheduling/personal-tools.js';
import { toolDeliverySchema } from '../assistant/tool-evidence.js';
import { writeDeliverySchema, type WriteDelivery } from '../writes/write-tools.js';
import { followupsDeliverySchema } from '../assistant/followups.js';
import { contextDeliverySchema, type ContextDelivery } from './context-delivery.js';

export const compositeDeliverySchema = z
  .object({
    kind: z.literal('composite'),
    version: z.literal(1),
    personal: personalDeliverySchema,
    business: toolDeliverySchema,
    // Recall only this business segment under business receipts. Personal text has its own recall.
    businessText: z.string().trim().min(1).max(12000),
    // Unsegmented prose informed by both personal recall and business reads cannot be
    // recalled using business permission alone. Retrieve each source again instead.
    businessRecallAllowed: z.literal(false).optional(),
  })
  .strict()
  .refine((value) => value.personal.employeeId === value.business.employeeId);

export const writeDeliveryBundleSchema = z
  .object({
    kind: z.literal('write_bundle'),
    version: z.literal(1),
    write: writeDeliverySchema,
    other: z
      .union([personalDeliverySchema, toolDeliverySchema, compositeDeliverySchema])
      .optional(),
    otherText: z.string().max(16000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.other ||
      (value.other.kind === 'composite'
        ? value.other.business.employeeId
        : value.other.employeeId) === value.write.employeeId,
  );

export const contextDeliveryBundleSchema = z
  .object({
    kind: z.literal('context_bundle'),
    version: z.literal(1),
    context: contextDeliverySchema,
    other: z
      .union([
        writeDeliveryBundleSchema,
        personalDeliverySchema,
        toolDeliverySchema,
        compositeDeliverySchema,
        followupsDeliverySchema,
      ])
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.other ||
      value.context.employeeId ===
        (value.other.kind === 'write_bundle'
          ? value.other.write.employeeId
          : value.other.kind === 'composite'
            ? value.other.business.employeeId
            : value.other.employeeId),
  );

/** Owner-unwrapped receipts only. Context envelopes must be checked by ChatContext first. */
export const historicalDeliverySchema = z.union([
  toolDeliverySchema,
  personalDeliverySchema,
  compositeDeliverySchema,
  writeDeliveryBundleSchema,
  followupsDeliverySchema,
]);
export type HistoricalDelivery = z.infer<typeof historicalDeliverySchema>;
export function historicalDeliveryParts(value: HistoricalDelivery) {
  const other = value.kind === 'write_bundle' ? value.other : value;
  return {
    write: value.kind === 'write_bundle' ? value.write : undefined,
    personal:
      other?.kind === 'composite' ? other.personal : other?.kind === 'personal' ? other : undefined,
    business:
      other?.kind === 'composite'
        ? other.business
        : other?.kind === 'context_tools' || other?.kind === 'assigned_followups_today'
          ? other
          : undefined,
  };
}
export function historicalDeliveryOwner(value: HistoricalDelivery) {
  const parts = historicalDeliveryParts(value);
  return (parts.write ?? parts.personal ?? parts.business)!.employeeId;
}
export function historicalDeliveryAt(value: HistoricalDelivery): string | undefined {
  const parts = historicalDeliveryParts(value);
  return [parts.write?.history?.at, parts.personal?.history?.at, parts.business?.preparedAt]
    .filter((at): at is string => !!at)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1);
}

export function contextDeliveryBundle(context: ContextDelivery, other?: unknown) {
  return contextDeliveryBundleSchema.parse({
    kind: 'context_bundle',
    version: 1,
    context,
    ...(other !== undefined ? { other } : {}),
  });
}

export function withoutContextDelivery(value: unknown): unknown {
  const parsed = contextDeliveryBundleSchema.safeParse(value);
  return parsed.success ? parsed.data.other : value;
}

/** Every constituent must pass; a memory binding never substitutes for business/write authority. */
export async function authorizeDelivery(
  value: unknown,
  checks: {
    context?: (receipt: ContextDelivery) => Promise<boolean>;
    write?: (receipt: WriteDelivery) => Promise<boolean>;
    personal?: (receipt: z.infer<typeof personalDeliverySchema>) => Promise<boolean>;
    business?: (receipt: unknown) => Promise<boolean>;
  },
): Promise<boolean> {
  const context = contextDeliveryBundleSchema.safeParse(value);
  // Check once before remote work, then again after it: slow business preflight
  // must not leave the memory owner binding stale at the transport boundary.
  const finish = () =>
    context.success ? checks.context!(context.data.context) : Promise.resolve(true);
  if (context.success) {
    if (!checks.context || !(await checks.context(context.data.context))) return false;
    value = context.data.other;
    if (value === undefined) return true;
  } else if (
    value &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'context_bundle'
  ) {
    return false;
  }
  const write = getWriteDelivery(value);
  if (write) {
    if (!checks.write || !(await checks.write(write))) return false;
    value = withoutWriteDelivery(value);
    if (value === undefined) return finish();
  }
  const personal = getPersonalDelivery(value);
  if (personal) {
    if (!checks.personal || !(await checks.personal(personal))) return false;
    const composite = compositeDeliverySchema.safeParse(value);
    if (!composite.success) return finish();
    value = composite.data.business;
  }
  return !!checks.business && (await checks.business(value)) && (await finish());
}

export function writeDeliveryBundle(write: WriteDelivery, other?: unknown, otherText?: string) {
  return writeDeliveryBundleSchema.parse({
    kind: 'write_bundle',
    version: 1,
    write,
    ...(other ? { other } : {}),
    ...(otherText ? { otherText } : {}),
  });
}
export function getWriteDelivery(value: unknown) {
  value = withoutContextDelivery(value);
  const parsed = writeDeliveryBundleSchema.safeParse(value);
  return parsed.success ? parsed.data.write : undefined;
}
export function withoutWriteDelivery(value: unknown): unknown {
  const parsed = writeDeliveryBundleSchema.safeParse(value);
  return parsed.success ? parsed.data.other : value;
}

export function getPersonalDelivery(value: unknown) {
  value = withoutContextDelivery(value);
  value = withoutWriteDelivery(value);
  const direct = personalDeliverySchema.safeParse(value);
  if (direct.success) return direct.data;
  const composite = compositeDeliverySchema.safeParse(value);
  return composite.success ? composite.data.personal : undefined;
}

export function getBusinessReply(value: { text: string; receipt: unknown }) {
  // Only ChatContext may unwrap this envelope after checking its current owner. Legacy
  // history/recall readers must not recover memory-derived prose using business access alone.
  if (contextDeliveryBundleSchema.safeParse(value.receipt).success) return undefined;
  const writes = writeDeliveryBundleSchema.safeParse(value.receipt);
  if (writes.success) {
    if (!writes.data.other || !writes.data.otherText) return undefined;
    value = { text: writes.data.otherText, receipt: writes.data.other };
  }
  const composite = compositeDeliverySchema.safeParse(value.receipt);
  if (composite.success && composite.data.businessRecallAllowed === false) return undefined;
  return composite.success
    ? { text: composite.data.businessText, receipt: composite.data.business }
    : value;
}
