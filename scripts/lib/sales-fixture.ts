/** Synthetic facts with a snapshot of the real signed MCP catalogue. Never opens a network connection. */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import {
  CONTEXT_READ_TOOLS,
  ContextEngineError,
  type ContextReadTool,
  type ContextEvidence,
  type ContextToolDefinition,
} from '../../src/modules/context-engine/context.types.js';
import { indiaDate } from '../../src/modules/assistant/followups.js';
import { analyticsFixture } from './analytics-fixture.js';

export const SALES_CATALOGUE = JSON.parse(
  readFileSync(
    new URL('../../tests/fixtures/context-tool-catalogue.json', import.meta.url),
    'utf8',
  ),
) as ContextToolDefinition[];
export const CONTEXT_GUIDANCE = readFileSync(
  new URL('../../tests/fixtures/context-guidance.md', import.meta.url),
  'utf8',
).trim();
export const FIXTURE_LEAD_ID = '00000000-0000-4000-8000-000000000101';
export const FIXTURE_EMPLOYEE = {
  employeeId: 23,
  phoneE164: '+919000000023',
  email: 'fixture@example.com',
  active: true,
};
export const FIXTURE_JID = '919000000023@s.whatsapp.net';

const DAY = 86_400_000;
function dateBounds(args: Record<string, unknown>, localDate: string) {
  const today = Date.parse(`${localDate}T00:00:00Z`);
  const d = new Date(today);
  const monday = today - ((d.getUTCDay() + 6) % 7) * DAY;
  const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const periods: Record<string, number[]> = {
    today: [today, today],
    yesterday: [today - DAY, today - DAY],
    tomorrow: [today + DAY, today + DAY],
    this_week: [monday, monday + 6 * DAY],
    last_week: [monday - 7 * DAY, monday - DAY],
    this_month: [month, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)],
    last_month: [Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1), month - DAY],
    last_7_days: [today - 6 * DAY, today],
    last_30_days: [today - 29 * DAY, today],
    next_7_days: [today, today + 6 * DAY],
  };
  const range = args.period ? periods[String(args.period)] : undefined;
  return range
    ? range.map((t) => new Date(t).toISOString().slice(0, 10))
    : [args.date_from as string | undefined, args.date_to as string | undefined];
}
function pageRows<T>(rows: T[], args: Record<string, unknown>) {
  const offset = Number(String(args.cursor ?? 'fixture:0').split(':')[1]);
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid fixture cursor');
  const limit = Number(args.limit ?? 10);
  const items = rows.slice(offset, offset + limit);
  const nextCursor = offset + limit < rows.length ? `fixture:${offset + limit}` : null;
  return { items, nextCursor };
}

export function salesEvidence(
  tool: ContextReadTool,
  args: Record<string, unknown>,
  now = Date.now(),
  options: {
    warehouseCount?: number;
    warehousePageOverlap?: boolean;
    visibleLeadIds?: readonly string[];
  } = {},
): ContextEvidence {
  if (CONTEXT_READ_TOOLS[tool] === 'analytics:read') return analyticsFixture(tool, args, now);
  const localDate = indiaDate(now);
  const start = Date.parse(`${localDate}T00:00:00+05:30`);
  const clock = {
    as_of: new Date(now).toISOString(),
    timezone: 'Asia/Kolkata',
    local_date: localDate,
  };
  const lead = {
    id: FIXTURE_LEAD_ID,
    name: 'Fixture Acme Storage',
    stage: 'RFQ_RECEIVED',
    source_created_at: '2026-09-01T08:30:00Z',
    source_updated_at: '2026-09-29T13:30:00Z',
    city: 'Bengaluru',
    requirement_sqft: 25000,
    next_follow_up: new Date(start + 36_000_000).toISOString(),
    verification_required: true,
  };
  const tomorrowLead = {
    ...lead,
    id: '00000000-0000-4000-8000-000000000102',
    name: 'Fixture Beacon Retail',
    source_created_at: '2026-09-12T21:30:00Z',
    next_follow_up: new Date(start + 122_400_000).toISOString(),
  };
  // A stable fictional dataset: filters never rewrite record facts to make a query match.
  const leads = [
    lead,
    tomorrowLead,
    ...Array.from({ length: 15 }, (_, i) => ({
      ...lead,
      id: `00000000-0000-4000-8000-${String(103 + i).padStart(12, '0')}`,
      name: `Fixture Enquiry ${i + 1}`,
      stage: i < 10 ? 'RFQ_RECEIVED' : 'FOLLOW_UP',
      source_created_at: '2026-08-10T08:30:00Z',
      next_follow_up: new Date(
        start + (i < 2 ? (-2 + i) * DAY : (i + 2) * DAY) + 36_000_000,
      ).toISOString(),
    })),
  ].filter((row) => !options.visibleLeadIds || options.visibleLeadIds.includes(row.id));
  const matchingLeads = () => {
    const [from, to] = dateBounds(args, localDate);
    return leads.filter((row) => {
      if (args.q && !row.name.toLowerCase().includes(String(args.q).toLowerCase())) return false;
      if (args.stage && row.stage !== args.stage) return false;
      if (args.city && row.city.toLowerCase() !== String(args.city).toLowerCase()) return false;
      const followDate = indiaDate(Date.parse(row.next_follow_up));
      if (args.follow_up_status === 'overdue' && followDate >= localDate) return false;
      if (args.follow_up_status === 'today' && followDate !== localDate) return false;
      if (args.follow_up_status === 'upcoming' && followDate <= localDate) return false;
      if (args.follow_up_status === 'missing') return false;
      if (args.date_field) {
        const value =
          args.date_field === 'created'
            ? row.source_created_at
            : args.date_field === 'updated'
              ? row.source_updated_at
              : row.next_follow_up;
        const day = indiaDate(Date.parse(value));
        if ((from && day < from) || (to && day > to)) return false;
      }
      return true;
    });
  };
  const warehouse = {
    id: 101,
    city: 'Bengaluru',
    micro_market: 'Hoskote',
    warehouse_type: 'PEB',
    area_sqft: 30000,
    total_space_sqft: 30000,
    clear_height_ft: 28,
    dock_count: 3,
    asking_rate_per_sqft: null,
    fire_noc_available: null,
    micromarkets: ['Hoskote'],
    verification_required: true,
    field_evidence: {
      availability: { status: 'unknown', reason: 'Confirm current availability with the owner.' },
    },
  };
  const warehouses = Array.from({ length: options.warehouseCount ?? 9 }, (_, i) => ({
    ...warehouse,
    id: 101 + i,
    city: options.warehouseCount !== undefined || i < 5 ? 'Bengaluru' : 'Pune',
    micro_market: i < 5 ? 'Hoskote' : 'Chakan',
    micromarkets: [i < 5 ? 'Hoskote' : 'Chakan'],
    total_space_sqft: 26000 + i * 1000,
    area_sqft: 26000 + i * 1000,
    dock_count: i + 1,
    clear_height_ft: 24 + i,
    ...(options.warehouseCount !== undefined
      ? {
          created_at: new Date(start - i * DAY).toISOString(),
          updated_at: new Date(start).toISOString(),
        }
      : {}),
  }));
  const matchingWarehouses = () =>
    warehouses.filter(
      (row) =>
        (!args.city || row.city.toLowerCase() === String(args.city).toLowerCase()) &&
        (!args.micromarket ||
          row.micro_market.toLowerCase() === String(args.micromarket).toLowerCase()) &&
        (args.area_min_sqft === undefined || row.area_sqft >= Number(args.area_min_sqft)) &&
        (args.area_max_sqft === undefined || row.area_sqft <= Number(args.area_max_sqft)) &&
        (args.docks_min === undefined || row.dock_count >= Number(args.docks_min)) &&
        (args.clear_height_min_ft === undefined ||
          row.clear_height_ft >= Number(args.clear_height_min_ft)),
    );
  const page = {
    id: 'warehouse-visits',
    title: 'Warehouse visit checklist',
    summary: 'Confirm access, power and owner availability.',
    body: 'Before a visit, confirm truck access, sanctioned power and current availability with the owner.',
  };
  const access = {
    access_scope:
      args.view === 'assigned' || args.view === 'created' ? args.view : 'created_or_assigned',
    source_status: {
      opportunities: { status: 'ok', last_run_at: new Date(now - 60_000).toISOString() },
    },
    read_consistency: {
      database_snapshot: 'repeatable_read',
      lead_fields: 'same_row',
      cross_request_snapshot: false,
      transaction_started_at: new Date(now).toISOString(),
    },
  };
  let path: string;
  let data: Record<string, unknown>;
  switch (tool) {
    case 'get_context':
      path = '/api/v1/context';
      data = {
        employee_id: 23,
        scopes: ['crm:read', 'warehouses:read', 'knowledge:read'],
        read_only: true,
        server_clock: clock,
      };
      break;
    case 'crm_filters':
      path = '/api/v1/crm/filters';
      data = {
        cities: ['Bengaluru'],
        stages: ['RFQ_RECEIVED', 'FOLLOW_UP'],
        date_fields: ['follow_up', 'created', 'updated'],
        periods: ['today', 'tomorrow', 'this_week', 'this_month'],
        sorts: ['id_asc', 'follow_up_asc', 'created_desc', 'created_asc', 'updated_desc'],
        lead_sources: ['WEBSITE_SEO'],
        industries: ['OTHER'],
      };
      break;
    case 'search_crm_leads': {
      path = '/api/v1/crm/opportunities';
      const rows = matchingLeads();
      if (args.sort === 'created_desc')
        rows.sort((a, b) => b.source_created_at.localeCompare(a.source_created_at));
      if (args.sort === 'created_asc')
        rows.sort((a, b) => a.source_created_at.localeCompare(b.source_created_at));
      if (args.sort === 'follow_up_asc')
        rows.sort((a, b) => a.next_follow_up.localeCompare(b.next_follow_up));
      const { items, nextCursor } = pageRows(rows, args);
      const [from, to] = dateBounds(args, localDate);
      data = {
        items,
        nextCursor,
        query_context: {
          ...clock,
          sort: args.sort ?? 'id_asc',
          returned_count: items.length,
          has_more: nextCursor !== null,
          date_field: args.date_field ?? null,
          period: args.period ?? null,
          date_from: from ?? null,
          date_to: to ?? null,
          follow_up: args.follow_up_status ? { status: args.follow_up_status } : null,
        },
      };
      break;
    }
    case 'crm_summary': {
      path = '/api/v1/crm/summary';
      const rows = matchingLeads();
      const field = String(args.group_by ?? 'stage');
      const groups = Object.entries(
        rows.reduce<Record<string, number>>((a, r) => {
          const v = String((r as Record<string, unknown>)[field] ?? 'Not recorded');
          a[v] = (a[v] ?? 0) + 1;
          return a;
        }, {}),
      ).map(([value, count]) => ({ value, count }));
      data = {
        total: rows.length,
        group_by: args.group_by ?? 'stage',
        groups,
        other_count: 0,
        groups_truncated: false,
        query_context: { ...clock, ...args },
      };
      break;
    }
    case 'read_crm_lead':
      if (!leads.some((row) => row.id === args.id))
        throw new ContextEngineError('TOOL_UNAVAILABLE');
      path = `/api/v1/crm/opportunities/${args.id}`;
      data = {
        ...leads.find((row) => row.id === args.id),
        id: args.id,
        description: 'Needs a Bengaluru warehouse, approximately 25,000 square feet.',
      };
      break;
    case 'read_crm_lead_context':
      if (!leads.some((row) => row.id === args.id))
        throw new ContextEngineError('TOOL_UNAVAILABLE');
      path = `/api/v1/crm/opportunities/${args.id}/context`;
      data = {
        lead_id: args.id,
        section: args.section,
        items: [{ id: 'fixture-note', body: 'Customer asked for a site visit on Friday.' }],
        nextCursor: null,
        source_fetched_at: new Date(now).toISOString(),
      };
      break;
    case 'crm_briefing': {
      path = '/api/v1/crm/my-briefing';
      const overdue = leads.filter((row) => indiaDate(Date.parse(row.next_follow_up)) < localDate);
      data = {
        ...clock,
        total_active: leads.length,
        counts_by_stage: Object.fromEntries(
          ['RFQ_RECEIVED', 'FOLLOW_UP'].map((stage) => [
            stage,
            leads.filter((row) => row.stage === stage).length,
          ]),
        ),
        counts_by_sla: { breached: overdue.length },
        follow_up_overdue: overdue.length,
        priorities: [...overdue, ...leads.filter((row) => row.id === lead.id)],
      };
      break;
    }
    case 'warehouse_filters':
      path = '/api/v1/warehouses/filters';
      data = {
        options: {
          city: ['Bengaluru', 'Pune'],
          micro_market: ['Hoskote', 'Chakan'],
          warehouse_type: ['PEB'],
        },
        truncated: false,
      };
      break;
    case 'search_warehouses': {
      path = '/api/v1/warehouses';
      const rows = matchingWarehouses();
      if (args.sort === 'created_asc') rows.reverse();
      const page = pageRows(rows, args);
      if (options.warehousePageOverlap && page.nextCursor) {
        const offset = Number(String(args.cursor ?? 'fixture:0').split(':')[1]);
        page.nextCursor = `fixture:${offset + Math.max(1, page.items.length - 1)}`;
      }
      const { items, nextCursor } = page;
      data = {
        items,
        nextCursor,
        query_context: {
          ...clock,
          sort: args.sort ?? 'id_asc',
          returned_count: items.length,
          has_more: nextCursor !== null,
        },
        matching_policy: 'Recorded values only; verify current availability and specifications.',
      };
      break;
    }
    case 'warehouse_summary': {
      path = '/api/v1/warehouses/summary';
      const rows = matchingWarehouses();
      data = {
        total: rows.length,
        group_by: args.group_by ?? 'city',
        groups: ['Bengaluru', 'Pune']
          .map((value) => ({ value, count: rows.filter((r) => r.city === value).length }))
          .filter((r) => r.count),
        other_count: 0,
        groups_truncated: false,
        query_context: clock,
      };
      break;
    }
    case 'read_warehouse':
      if (!warehouses.some((row) => row.id === args.id))
        throw new ContextEngineError('TOOL_UNAVAILABLE');
      path = `/api/v1/warehouses/${args.id}`;
      data = {
        ...warehouses.find((row) => row.id === args.id),
      };
      break;
    case 'search_knowledge':
      path = `/api/v1/wiki/${args.q ? 'search' : 'pages'}`;
      data = { items: [page], nextCursor: null };
      break;
    case 'read_knowledge':
      if (args.id !== page.id) throw new ContextEngineError('TOOL_UNAVAILABLE');
      path = `/api/v1/wiki/pages/${args.id}`;
      data = page;
      break;
    case 'assess_shortlist':
      if (!leads.some((row) => row.id === args.lead_id))
        throw new ContextEngineError('TOOL_UNAVAILABLE');
      path = `/api/v1/crm/opportunities/${args.lead_id}/assessment`;
      data = {
        lead_id: args.lead_id,
        requirements: { area_sqft: 25000, city: 'Bengaluru' },
        candidates: ((args.warehouse_ids as number[] | undefined) ?? []).map((id) => ({
          warehouse_id: id,
          fit: 'potential_match',
          verification_required: true,
        })),
        disclaimer: 'Recorded fit only. Confirm current availability and requirements.',
      };
      break;
    default:
      throw new Error('Unsupported synthetic tool');
  }
  if (CONTEXT_READ_TOOLS[tool] === 'crm:read') data = { ...data, ...access };
  const query = Object.entries(args).filter(
    ([key]) =>
      !['id', 'lead_id', 'cursor'].includes(key) &&
      !(tool === 'search_warehouses' && key === 'response_format') &&
      tool !== 'assess_shortlist',
  );
  if (query.length) path += `?${new URLSearchParams(query.map(([k, v]) => [k, String(v)]))}`;
  return {
    source_path: path,
    status: 200,
    data,
    meta: { requestId: randomUUID(), generatedAt: new Date(now).toISOString() },
  };
}

export function createSalesFixture(now = Date.now) {
  const state = {
    active: true,
    employeeId: 23,
    discoveries: 0,
    calls: [] as Array<{ tool: ContextReadTool; args: Record<string, unknown> }>,
    evidence: [] as Array<{
      tool: ContextReadTool;
      args: Record<string, unknown>;
      result: ContextEvidence;
    }>,
    tools: structuredClone(SALES_CATALOGUE),
    guidance: CONTEXT_GUIDANCE,
    warehouseCount: undefined as number | undefined,
    warehousePageOverlap: false,
    visibleLeadIds: undefined as string[] | undefined,
    failures: new Map<ContextReadTool, ContextEngineError>(),
    mutate: undefined as
      | ((result: ContextEvidence, tool: ContextReadTool, args: Record<string, unknown>) => void)
      | undefined,
  };
  const resolve = async (key: { remoteJid?: string | null }) => {
    if (!state.active || key.remoteJid !== FIXTURE_JID) return null;
    return {
      employeeId: state.employeeId,
      search: async () => salesEvidence('search_crm_leads', {}, now(), state),
      tools: {
        employeeId: state.employeeId,
        discover: async () => {
          state.discoveries++;
          return state.tools;
        },
        describe: async () => {
          state.discoveries++;
          return { tools: state.tools, guidance: state.guidance };
        },
        call: async (tool: ContextReadTool, args: Record<string, unknown>) => {
          state.calls.push({ tool, args: structuredClone(args) });
          if (state.failures.has(tool)) throw state.failures.get(tool)!;
          const result = salesEvidence(tool, args, now(), state);
          if (tool === 'get_context')
            result.data.scopes = [
              ...new Set(
                state.tools
                  .map((t) => CONTEXT_READ_TOOLS[t.name as ContextReadTool])
                  .filter(Boolean),
              ),
            ];
          state.mutate?.(result, tool, args);
          state.evidence.push({
            tool,
            args: structuredClone(args),
            result: structuredClone(result),
          });
          return result;
        },
      },
    };
  };
  return { state, service: new BusinessReadService(resolve, [23], now, true) };
}
