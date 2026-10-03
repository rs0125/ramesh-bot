/** Persist displayed identities separately from mutable search pages and historical prose. */
import type { ToolEvidence } from './tool-evidence.js';

export interface DisplayedWarehouseRecord {
  kind: 'warehouse';
  id: number;
  position: number;
}

/** Only entity IDs in successful accepted warehouse evidence establish a reference. */
export function warehouseEvidenceIds(evidence: readonly ToolEvidence[]): Set<number> {
  const ids = new Set<number>();
  for (const entry of evidence) {
    const rows =
      entry.tool === 'search_warehouses'
        ? entry.result.data.items
        : entry.tool === 'read_warehouse'
          ? [entry.result.data]
          : entry.tool === 'assess_shortlist'
            ? entry.result.data.candidates
            : [];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const id = row && typeof row === 'object' && !Array.isArray(row) ? row.id : undefined;
      if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 2147483647)
        ids.add(id);
    }
  }
  return ids;
}

/** Legacy labels identify lookup targets, never authority; callers must freshly authorize every ID. */
export function displayedWarehouseLabels(reply: string): DisplayedWarehouseRecord[] {
  const selected = new Map<number, DisplayedWarehouseRecord>();
  // Explicit ID labels only: arbitrary numbers, dimensions, UUID prefixes, source text,
  // and tool arguments are not displayed warehouse identities.
  const headings = [
    ...reply.matchAll(
      /^\s*[*_]{0,2}([1-9]\d{0,2})[.)][*_]{0,2}\s+[*_]{0,2}(?:warehouse\s+)?ID(?:\s*:\s*|\s+)([1-9]\d{0,9})(?![\w-]|\.\d)/gimu,
    ),
  ];
  // Separate per-deal lists can restart at 1. Without group bindings there is no
  // single historical ordinal; leave those replies on the full-source recall path.
  if (new Set(headings.map((match) => Number(match[1]))).size !== headings.length) return [];
  const matches = headings.length
    ? headings
    : [...reply.matchAll(/\bID(?:\s*:\s*|\s+)([1-9]\d{0,9})(?![\w-]|\.\d)/giu)];
  for (const match of matches) {
    const id = Number(match[headings.length ? 2 : 1]);
    const position = headings.length ? Number(match[1]) : selected.size + 1;
    if (id <= 2147483647 && position <= 100 && !selected.has(id))
      selected.set(id, { kind: 'warehouse', id, position });
    if (selected.size >= 100) break;
  }
  return [...selected.values()];
}

/** Failed legacy references leave ordinal gaps; fresh visibility never renumbers history. */
export function displayedWarehousePositions(reply: string, evidence: readonly ToolEvidence[]) {
  const permitted = warehouseEvidenceIds(evidence);
  return displayedWarehouseLabels(reply).filter((record) => permitted.has(record.id));
}

export function displayedWarehouseRecords(
  reply: string,
  evidence: readonly ToolEvidence[],
): DisplayedWarehouseRecord[] {
  return displayedWarehousePositions(reply, evidence);
}
