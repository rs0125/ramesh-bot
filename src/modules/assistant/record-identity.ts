/** Equality hints for refreshed source records. Never an authorization or old-answer freshness check. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ContextEvidence, ContextReadTool } from '../context-engine/context.types.js';
import type { ToolEvidence } from './tool-evidence.js';

/** Native CRM rows from accepted source evidence, never a guess based on ID syntax. */
export function nativeCrmRecords(evidence: readonly ToolEvidence[]) {
  const records = new Map<string, Record<string, unknown>>();
  for (const entry of evidence) {
    const data = entry.result.data;
    const items =
      entry.tool === 'search_crm_leads'
        ? data.items
        : entry.tool === 'crm_briefing'
          ? data.priorities
          : entry.tool === 'read_crm_lead'
            ? [data]
            : [];
    if (!Array.isArray(items)) continue;
    for (const row of items)
      if (row && typeof row === 'object' && !Array.isArray(row) && typeof row.id === 'string')
        records.set(row.id, row);
  }
  return [...records.values()];
}

/** Private CRM references identified by source provenance, including accepted lead-targeted reads. */
export function internalCrmReferences(evidence: readonly ToolEvidence[]): Set<string> {
  const internalIds = new Set(nativeCrmRecords(evidence).map((row) => String(row.id)));
  for (const entry of evidence) {
    const id =
      entry.tool === 'read_crm_lead_context'
        ? entry.arguments.id
        : entry.tool === 'assess_shortlist'
          ? entry.arguments.lead_id
          : undefined;
    if (typeof id === 'string') internalIds.add(id);
  }
  return internalIds;
}

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
