/** A mixed reply must satisfy both private authorization boundaries before any part is sent. */
import { z } from 'zod';
import { personalDeliverySchema } from '../scheduling/personal-tools.js';
import { toolDeliverySchema } from '../assistant/tool-evidence.js';

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

export function getPersonalDelivery(value: unknown) {
  const direct = personalDeliverySchema.safeParse(value);
  if (direct.success) return direct.data;
  const composite = compositeDeliverySchema.safeParse(value);
  return composite.success ? composite.data.personal : undefined;
}

export function getBusinessReply(value: { text: string; receipt: unknown }) {
  const composite = compositeDeliverySchema.safeParse(value.receipt);
  if (composite.success && composite.data.businessRecallAllowed === false) return undefined;
  return composite.success
    ? { text: composite.data.businessText, receipt: composite.data.business }
    : value;
}
