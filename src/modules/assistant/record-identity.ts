/** Equality hints for refreshed source records. Never an authorization or old-answer freshness check. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ContextEvidence, ContextReadTool } from '../context-engine/context.types.js';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const recordIdentitySchema = z
  .object({
    count: z.number().int().min(0).max(1000),
    membership: fingerprint,
    order: fingerprint,
  })
  .strict();

export function recordIdentity(tool: ContextReadTool, evidence: ContextEvidence) {
  let rows: unknown;
  if (['search_crm_leads', 'search_warehouses', 'search_knowledge'].includes(tool))
    rows = evidence.data.items;
  else if (['read_crm_lead', 'read_warehouse', 'read_knowledge'].includes(tool))
    rows = [evidence.data];
  else return undefined;
  if (!Array.isArray(rows) || rows.length > 1000) return undefined;
  const ids: string[] = [];
  for (const row of rows) {
    const id = row && typeof row === 'object' && !Array.isArray(row) ? row.id : undefined;
    if (
      !(typeof id === 'string' && id.length > 0) &&
      !(typeof id === 'number' && Number.isSafeInteger(id))
    )
      return undefined;
    ids.push(JSON.stringify(id));
  }
  const hash = (values: string[]) =>
    createHash('sha256').update(JSON.stringify(values)).digest('hex');
  return { count: ids.length, membership: hash([...ids].sort()), order: hash(ids) };
}
