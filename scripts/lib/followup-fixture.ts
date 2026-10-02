/** Synthetic CRM evidence for capture-only chat/evals. No roster, database, MCP or WhatsApp connection. */
import { randomUUID } from 'node:crypto';
import { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import { FOLLOWUPS_QUERY, indiaDate } from '../../src/modules/assistant/followups.js';
import type { ContextEvidence } from '../../src/modules/context-engine/context.types.js';

export function followupEvidence(now = Date.now()): ContextEvidence {
  const date = indiaDate(now);
  const start = Date.parse(`${date}T00:00:00+05:30`);
  return {
    source_path: `/api/v1/crm/opportunities?${new URLSearchParams(Object.entries(FOLLOWUPS_QUERY).map(([k, v]) => [k, String(v)]))}`,
    status: 200,
    meta: { requestId: randomUUID(), generatedAt: new Date(now).toISOString() },
    data: {
      items: [
        {
          id: '00000000-0000-4000-8000-000000000101',
          name: 'Fixture Acme Storage',
          stage: 'SITE_VISIT',
          next_follow_up: new Date(start + 36_000_000).toISOString(),
          verification_required: true,
        },
      ],
      nextCursor: null,
      access_scope: 'assigned',
      source_status: {
        opportunities: { status: 'ok', last_run_at: new Date(now - 60_000).toISOString() },
      },
      activity_status: { status: 'current' },
      read_consistency: {
        database_snapshot: 'repeatable_read',
        lead_fields: 'same_row',
        cross_request_snapshot: false,
      },
      query_context: {
        as_of: new Date(now).toISOString(),
        timezone: 'Asia/Kolkata',
        local_date: date,
        sort: 'follow_up_asc',
        returned_count: 1,
        has_more: false,
        follow_up: {
          status: 'today',
          timezone: 'Asia/Kolkata',
          start_at: new Date(start).toISOString(),
          end_before: new Date(start + 86_400_000).toISOString(),
        },
      },
    },
  };
}

export function createFollowupFixture(now = Date.now) {
  const state = { active: true, employeeId: 23, calls: 0, empty: false, stale: false, more: false };
  const service = new BusinessReadService(
    async () =>
      state.active
        ? {
            employeeId: state.employeeId,
            async search(args) {
              if (JSON.stringify(args) !== JSON.stringify(FOLLOWUPS_QUERY))
                throw new Error('Fixture permits only the fixed assigned query');
              state.calls++;
              const result = followupEvidence(now());
              if (state.empty) {
                result.data.items = [];
                (result.data.query_context as Record<string, unknown>).returned_count = 0;
              }
              if (state.stale)
                (
                  result.data.source_status as { opportunities: { status: string } }
                ).opportunities.status = 'error';
              if (state.more) {
                result.data.nextCursor = 'fixture-more';
                (result.data.query_context as Record<string, unknown>).has_more = true;
              }
              return result;
            },
          }
        : null,
    [23],
    now,
  );
  return { service, state };
}
