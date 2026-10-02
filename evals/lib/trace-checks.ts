import type { ConversationCase } from '../conversation-cases.js';

/** Counts actual source/local execution separately from model proposals. */
export function traceViolations(
  checks: NonNullable<ConversationCase['traceChecks']>,
  turns: Array<{
    calls: Array<{ tool: string }>;
    local_calls: Array<{ name: string }>;
    proposed_tools: Array<{ name: string }>;
  }>,
) {
  return checks.flatMap((check) => {
    const turn = turns[check.turn];
    if (!turn) return [`turn${check.turn + 1}:missing_trace`];
    const names =
      check.phase === 'proposed'
        ? turn.proposed_tools.map((c) => c.name)
        : [...turn.calls.map((c) => c.tool), ...turn.local_calls.map((c) => c.name)];
    const count = names.filter((name) => !check.name || name === check.name).length;
    return (check.min !== undefined && count < check.min) ||
      (check.max !== undefined && count > check.max)
      ? [
          `turn${check.turn + 1}:trace_count:${check.phase ?? 'executed'}:${check.name ?? 'all'}:${count}`,
        ]
      : [];
  });
}
