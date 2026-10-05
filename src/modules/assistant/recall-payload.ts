/** Bounded views of accepted evidence. Omitted data remains in the current source ledger. */
import type { ToolEvidence } from './tool-evidence.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? 'null');
const priority = [
  'id',
  'name',
  'company_name',
  'city',
  'micro_market',
  'micromarkets',
  'lead',
  'requirement_context',
  'requirements',
  'total_space_sqft',
  'fire_noc_available',
  'recorded_context',
  'field_evidence',
  'verification_required',
  'availability',
  'source_updated_at',
  'updated_at',
  'last_polled_at',
  'items',
  'candidates',
  'nextCursor',
];

/** Retain complete scalar facts and distribute room over collections. Never clip
 * a number or silently shorten a source string into a different factual value. */
function project(value: unknown, budget: number, path: string, omitted: string[]): unknown {
  if (bytes(value) <= budget) return value;
  if (!value || typeof value !== 'object') {
    omitted.push(path);
    return undefined;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    const share = Math.max(2, Math.floor((budget - 2) / Math.max(1, value.length)) - 1);
    for (const [index, item] of value.entries()) {
      const projected = project(item, share, `${path}.${index}`, omitted);
      if (projected === undefined || bytes([...result, projected]) > budget) {
        omitted.push(`${path}.${index}`);
        break;
      }
      result.push(projected);
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value).sort(([left], [right]) => {
    const index = (key: string) =>
      priority.includes(key) ? priority.indexOf(key) : priority.length;
    return index(left) - index(right);
  });
  for (const [key, item] of entries) {
    const remaining = budget - bytes(result) - bytes(key) - 3;
    const projected =
      remaining > 0 ? project(item, remaining, `${path}.${key}`, omitted) : undefined;
    if (projected === undefined || bytes({ ...result, [key]: projected }) > budget)
      omitted.push(`${path}.${key}`);
    else result[key] = projected;
  }
  return result;
}

export function recallEvidenceView(reads: readonly ToolEvidence[], maxBytes = 60000) {
  const fresh = reads.map((entry) => ({
    evidence_id: entry.id,
    tool: entry.tool,
    arguments: entry.arguments,
    data: entry.result.data,
  }));
  if (bytes(fresh) <= maxBytes) return fresh;
  const perEntry = Math.max(256, Math.floor((maxBytes - 2) / Math.max(1, reads.length)) - 1);
  return fresh.map((entry) => {
    const omitted: string[] = [];
    const metadata = {
      evidence_id: entry.evidence_id,
      tool: entry.tool,
      ...(bytes(entry.arguments) <= 1000
        ? { arguments: entry.arguments }
        : { arguments_omitted: true }),
    };
    const data = project(
      entry.data,
      Math.max(2, perEntry - bytes(metadata) - 600),
      'data',
      omitted,
    );
    return {
      ...metadata,
      data,
      data_truncated: true,
      omitted_paths: [...new Set(omitted)].slice(0, 6).map((path) => path.slice(0, 64)),
      guidance:
        'Partial source view. Use evidence_id for the accepted full source; omitted fields are not missing facts.',
    };
  });
}
