/** Application-owned identity binding for replies informed by private conversation memory. */
import { z } from 'zod';

export const contextDeliverySchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    owner: z.string().regex(/^[a-f0-9]{64}$/),
    employeeId: z.number().int().positive(),
    chatId: z.string().min(1).max(256),
  })
  .strict();
export type ContextDelivery = z.infer<typeof contextDeliverySchema>;
