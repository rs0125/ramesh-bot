/** Remembered content selection, never approval or evidence that a write completed. */
import { z } from 'zod';

export const SOURCE_REFERENCE_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?::(?:text|attachment))?$';
export const sourceReferenceSchema = z.string().regex(new RegExp(SOURCE_REFERENCE_PATTERN));
export const writeSourceBindingSchema = z
  .object({
    id: z.string().uuid(),
    tool: z.string().min(1).max(128),
    label: z.string().min(1).max(240),
    references: z.array(sourceReferenceSchema).min(1).max(16),
    preparedBy: z.string().uuid(),
    expiresAt: z.number().int(),
    operationId: z.string().uuid().optional(),
    replacedBy: z.string().uuid().optional(),
  })
  .strict();
export type WriteSourceBinding = z.infer<typeof writeSourceBindingSchema>;
export interface WriteSourceBindings {
  list(): readonly WriteSourceBinding[];
  save(binding: WriteSourceBinding, replaces?: string): Promise<void>;
}

export function sourceReference(reference: string) {
  const [id, part = 'all'] = reference.split(':');
  return { id: id!.toLowerCase(), part: part as 'all' | 'text' | 'attachment' };
}
