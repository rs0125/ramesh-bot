import { sourceDate } from '../../src/modules/assistant/analytics-evidence.js';
import type { ContextReadTool } from '../../src/modules/context-engine/context.types.js';
import { matchesQuery } from './query-equivalence.js';
export interface ToolCheck {
  turn: number;
  name: ContextReadTool;
  alternatives?: ContextReadTool[];
  args?: Record<string, unknown>;
  anyArgs?: Array<Record<string, unknown>>;
  absent?: string[];
  last?: boolean;
  every?: boolean;
}
export function satisfiesToolCheck(
  check: ToolCheck,
  calls: Array<{ tool: string; args: Record<string, unknown> }>,
  instant: string,
) {
  const names = [check.name, ...(check.alternatives ?? [])];
  const matching = calls.filter((c) => names.includes(c.tool as ContextReadTool));
  const candidates = check.last ? matching.slice(-1) : matching;
  const matches = (c: (typeof calls)[number]) => {
    const day = sourceDate(
      c.tool === 'search_console_report' ? 'America/Los_Angeles' : 'Asia/Kolkata',
      Date.parse(instant),
    );
    return (
      matchesQuery(c.tool, c.args, check.args ?? {}, day) &&
      (!check.anyArgs || check.anyArgs.some((args) => matchesQuery(c.tool, c.args, args, day))) &&
      (check.absent ?? []).every((k) => !(k in c.args))
    );
  };
  return (
    candidates.length > 0 && (check.every ? candidates.every(matches) : candidates.some(matches))
  );
}
