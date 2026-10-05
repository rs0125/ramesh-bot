/** Deterministic checks also usable on retained traces without another model call. */
export function toolLoadingChecks(record: {
  case: string;
  mode: 'eager' | 'deferred';
  trace: { outcome: string };
  reply: string;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  evidence: Array<{ tool: string; result: { status: number; data: unknown } }>;
  nativeSearchCalls: number;
}) {
  const novel = record.case === 'deferred-unfamiliar-tool';
  return {
    completed: record.trace.outcome === 'completed',
    correctTool: record.calls.some((call) =>
      novel
        ? call.tool === 'count_studio_drafts'
        : call.tool === 'crm_briefing' ||
          (call.tool === 'crm_summary' && call.args.group_by === 'stage'),
    ),
    supportedAnswer: record.evidence.some(({ tool, result }) => {
      if (result.status !== 200 || !result.data || typeof result.data !== 'object') return false;
      const data = result.data as Record<string, any>;
      if (novel)
        return (
          tool === 'count_studio_drafts' &&
          data.draft_count === 47 &&
          data.collection === 'Studio vault'
        );
      if (data.access_scope !== 'created_or_assigned') return false;
      if (tool === 'crm_briefing')
        return (
          data.total_active === 17 &&
          data.counts_by_stage?.RFQ_RECEIVED === 12 &&
          data.counts_by_stage?.FOLLOW_UP === 5
        );
      return (
        tool === 'crm_summary' &&
        data.total === 17 &&
        data.group_by === 'stage' &&
        data.query_context?.active_only === 'true' &&
        data.query_context?.view === 'accessible' &&
        data.groups_truncated === false &&
        data.other_count === 0 &&
        Array.isArray(data.groups) &&
        data.groups.some((group: any) => group.value === 'RFQ_RECEIVED' && group.count === 12) &&
        data.groups.some((group: any) => group.value === 'FOLLOW_UP' && group.count === 5)
      );
    }),
    correctAnswer: novel
      ? /\b47\b/.test(record.reply)
      : /\b17\b/.test(record.reply) &&
        /RFQ[_ ]RECEIVED[^\n\d]*12\b/i.test(record.reply) &&
        /FOLLOW[_ -]UP[^\n\d]*5\b/i.test(record.reply),
    loadingMode:
      record.mode === 'deferred' ? record.nativeSearchCalls > 0 : record.nativeSearchCalls === 0,
  };
}
