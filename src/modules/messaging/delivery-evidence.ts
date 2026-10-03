/** A mixed reply must satisfy both private authorization boundaries before any part is sent. */
import { z } from 'zod';
import { personalDeliverySchema } from '../scheduling/personal-tools.js';
import { toolDeliverySchema } from '../assistant/tool-evidence.js';
import { writeDeliverySchema, type WriteDelivery } from '../writes/write-tools.js';

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
  const parsed = writeDeliveryBundleSchema.safeParse(value);
  return parsed.success ? parsed.data.write : undefined;
}
export function withoutWriteDelivery(value: unknown): unknown {
  const parsed = writeDeliveryBundleSchema.safeParse(value);
  return parsed.success ? parsed.data.other : value;
}

export function getPersonalDelivery(value: unknown) {
  value = withoutWriteDelivery(value);
  const direct = personalDeliverySchema.safeParse(value);
  if (direct.success) return direct.data;
  const composite = compositeDeliverySchema.safeParse(value);
  return composite.success ? composite.data.personal : undefined;
}

export function getBusinessReply(value: { text: string; receipt: unknown }) {
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
