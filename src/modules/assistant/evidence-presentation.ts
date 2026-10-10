/** Stable model projection of already validated live data. Raw evidence stays with the executor. */
import { createHash } from 'node:crypto';
import { isContextReadTool, type ContextEvidence } from '../context-engine/context.types.js';
import type { ToolEvidence } from './tool-evidence.js';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function runEvidenceId(runId: string, ordinal: number): string {
  const h = createHash('sha256')
    .update(JSON.stringify([runId, ordinal]))
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function presentSource<T extends ContextEvidence>(value: T, tool: string): T {
  const result = structuredClone(value);
  const meta = object(result.meta);
  if (meta) {
    delete meta.requestId;
    delete meta.generatedAt;
  }
  // Only the known first-party contract identifies these as retrieval timestamps.
  // Do not recursively strip date-shaped fields or unknown tools' source semantics.
  if (!isContextReadTool(tool)) return result;
  const data = object(result.data);
  if (!data) return result;
  const query = object(data.query_context);
  if (query) delete query.as_of;
  const consistency = object(data.read_consistency);
  if (consistency) delete consistency.transaction_started_at;
  const clock = object(data.server_clock);
  if (clock) delete clock.as_of;
  // A null cursor means every item this query matched is here. Say so, so a one-item list
  // is not hedged as possibly partial. Never on an empty list: "complete, 0 items" would make
  // a wrong filter (a locality searched as a city) look like a confirmed absence.
  if (Array.isArray(data.items) && data.items.length > 0 && 'nextCursor' in data)
    data.list_status = {
      all_results_for_this_query: data.nextCursor === null,
      item_count: data.items.length,
    };
  return result;
}

export function presentEvidence(items: readonly ToolEvidence[]): ToolEvidence[] {
  return items.map((item) => ({ ...item, result: presentSource(item.result, item.tool) }));
}

export function presentToolOutput(output: Record<string, unknown>, tool: string) {
  if (output.ok !== true || !object(output.meta) || !object(output.data)) return output;
  return presentSource(output as unknown as ContextEvidence, tool);
}

export function presentOrientation(context: Record<string, unknown>): Record<string, unknown> {
  const value = structuredClone(context);
  const clock = object(value.server_clock);
  if (clock) delete clock.as_of;
  return value;
}
