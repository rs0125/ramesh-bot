/** Application-owned coverage of accepted pages. Original source evidence stays intact. */
import type { ToolEvidence } from './tool-evidence.js';

const searches = new Set(['search_crm_leads', 'search_warehouses']);
const queryFields = (args: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(args)
      .filter(([key]) => !['cursor', 'limit', 'response_format'].includes(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
const key = (tool: string, args: Record<string, unknown>) =>
  `${tool}:${JSON.stringify(queryFields(args))}`;

export interface PaginationCoverage {
  tool: string;
  query: Record<string, unknown>;
  pages: number;
  unique_records: number;
  duplicate_records: number;
  status: 'more_available' | 'exhausted' | 'unlinked' | 'cursor_cycle';
  cross_request_snapshot: false;
}

function traversals(evidence: readonly ToolEvidence[]) {
  const groups = new Map<
    string,
    {
      summary: PaginationCoverage;
      ids: Set<string>;
      inputs: Set<string | null>;
      expected: string | null;
      unlinked: boolean;
      cycle: boolean;
    }
  >();
  for (const page of evidence) {
    if (!searches.has(page.tool) || !Array.isArray(page.result.data.items)) continue;
    const fingerprint = key(page.tool, page.arguments);
    let group = groups.get(fingerprint);
    if (!group) {
      group = {
        summary: {
          tool: page.tool,
          query: queryFields(page.arguments),
          pages: 0,
          unique_records: 0,
          duplicate_records: 0,
          status: 'more_available',
          cross_request_snapshot: false,
        },
        ids: new Set(),
        inputs: new Set(),
        expected: null,
        unlinked: false,
        cycle: false,
      };
      groups.set(fingerprint, group);
    }
    const cursor = typeof page.arguments.cursor === 'string' ? page.arguments.cursor : null;
    if (
      (group.summary.pages === 0 && cursor !== null) ||
      (group.summary.pages > 0 && (cursor === null || cursor !== group.expected))
    )
      group.unlinked = true;
    group.inputs.add(cursor);
    group.summary.pages++;
    for (const item of page.result.data.items) {
      const id = JSON.stringify(item.id);
      if (group.ids.has(id)) group.summary.duplicate_records++;
      else group.ids.add(id);
    }
    group.summary.unique_records = group.ids.size;
    const next = page.result.data.nextCursor;
    group.expected = typeof next === 'string' ? next : null;
    if (group.expected !== null && group.inputs.has(group.expected)) group.cycle = true;
    group.summary.status = group.cycle
      ? 'cursor_cycle'
      : group.unlinked
        ? 'unlinked'
        : group.expected === null
          ? 'exhausted'
          : 'more_available';
  }
  return groups;
}

export function paginationCoverage(evidence: readonly ToolEvidence[]): PaginationCoverage[] {
  return [...traversals(evidence).values()].map((group) => group.summary);
}

export function cyclicCursor(
  evidence: readonly ToolEvidence[],
  tool: string,
  args: Record<string, unknown>,
) {
  if (!searches.has(tool) || typeof args.cursor !== 'string') return false;
  const group = traversals(evidence).get(key(tool, args));
  return !!group?.cycle && group.inputs.has(args.cursor);
}
