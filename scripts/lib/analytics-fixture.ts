/** Fictional metrics and public tool contracts. No property IDs, customer records or Google requests. */
import { randomUUID } from 'node:crypto';
import {
  ANALYTICS_CITATION_FIELDS,
  sourceDate,
} from '../../src/modules/assistant/analytics-evidence.js';
import {
  ContextEngineError,
  type ContextEvidence,
  type ContextReadTool,
} from '../../src/modules/context-engine/context.types.js';

const DAY = 86400000;
const iso = (n: number) => new Date(n).toISOString().slice(0, 10);
export function analyticsFixture(
  tool: ContextReadTool,
  args: Record<string, any>,
  now = Date.now(),
): ContextEvidence {
  const system = tool === 'search_console_report' ? 'search_console' : 'ga4';
  const timezone = system === 'ga4' ? 'Asia/Kolkata' : 'America/Los_Angeles';
  const local_date = sourceDate(timezone, now),
    today = Date.parse(local_date + 'T00:00:00Z');
  const month = new Date(today);
  month.setUTCDate(1);
  const period = args.date_from ? null : (args.period ?? 'last_28_days');
  const range: Record<string, number[]> = {
    today: [today, today],
    yesterday: [today - DAY, today - DAY],
    last_7_days: [today - 7 * DAY, today - DAY],
    last_28_days: [today - 28 * DAY, today - DAY],
    this_month: [month.getTime(), today],
    last_month: [
      Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1),
      month.getTime() - DAY,
    ],
  };
  const report = args.report ?? args.group ?? (system === 'ga4' ? 'overview' : 'summary');
  if (
    (args.period && args.date_from) ||
    !!args.date_from !== !!args.date_to ||
    (args.compare_to && !['overview', 'summary'].includes(report)) ||
    (system === 'search_console' &&
      ((args.period === 'today' && args.data_state !== 'all') ||
        (args.country && !/^[a-z]{3}$/i.test(args.country)))) ||
    (args.query_equals && args.query_contains) ||
    (args.page_equals && args.page_contains) ||
    (report === 'form_performance' &&
      ['compare_to', 'cursor', 'page_path_contains', 'event_name'].some(
        (k) => args[k] !== undefined,
      ))
  )
    throw new ContextEngineError('INVALID_ARGUMENTS', false, undefined, {
      sourceCode: 'INVALID_QUERY',
      action: 'correct_query',
    });
  const dates = {
    date_from: args.date_from ?? iso(range[period]![0]!),
    date_to: args.date_to ?? iso(range[period]![1]!),
    timezone,
    local_date,
    period,
    inclusive: true,
    includes_recent_days: Date.parse(args.date_to ?? iso(range[period]![1]!)) >= today - 2 * DAY,
  };
  const query_context: Record<string, any> = { ...dates };
  for (const name of [
    'event_name',
    'query_contains',
    'query_equals',
    'query_not_contains',
    'page_contains',
    'page_equals',
    'landing_page_contains',
    'page_path_contains',
    'device',
    'country',
    'channel',
    'source',
    'compare_to',
  ])
    query_context[name] = args[name] ?? null;
  query_context.data_state = system === 'search_console' ? (args.data_state ?? 'final') : null;
  query_context.event_names = args.event_name
    ? [args.event_name]
    : report === 'form_submissions'
      ? ['form_submit', 'generate_lead']
      : [];
  const quality = {
    provisional: dates.includes_recent_days,
    warnings: [] as string[],
    data_loss_from_other_row: false,
    subject_to_thresholding: false,
    sampling: [],
    schema_restrictions: [],
    data_truncated: false,
    empty_reason: null,
    privacy_redactions: false,
    totals_included: true,
    first_incomplete_date: null,
    aggregation_type: system === 'search_console' ? 'byProperty' : null,
  };
  if (quality.provisional) quality.warnings.push('Recent data is provisional and may change.');
  const provenance = {
    source_fetched_at: new Date(now - 1000).toISOString(),
    served_at: new Date(now).toISOString(),
    cache: { hit: false, max_age_seconds: 300, age_seconds: 1 },
    quality,
  };
  const column = (name: string, unit = 'count') => ({ name, kind: 'metric', unit });
  const row = (
    metrics: Record<string, number | null>,
    dimensions: Record<string, string> = {},
  ) => ({ dimensions, metrics, redacted: false, verification_required: false });
  const aggregate = ['overview', 'summary', 'form_performance'].includes(report);
  let columns: any[];
  let items: any[];
  if (system === 'search_console') {
    columns = [
      column('clicks'),
      column('impressions'),
      column('ctr', 'fraction'),
      column('position', 'position'),
    ];
    const associations = [
      {
        query: 'warehouse bengaluru',
        page: 'https://example.test/warehouses/bengaluru',
        clicks: 55,
        impressions: 1100,
        position: 8,
      },
      {
        query: 'warehouse bengaluru',
        page: 'https://example.test/warehouses/mumbai',
        clicks: 15,
        impressions: 300,
        position: 10.3333333333,
      },
      {
        query: 'storage lease',
        page: 'https://example.test/warehouses/bengaluru',
        clicks: 25,
        impressions: 600,
        position: 11,
      },
      {
        query: 'storage lease',
        page: 'https://example.test/warehouses/mumbai',
        clicks: 15,
        impressions: 400,
        position: 13.5,
      },
    ].filter(
      (r) =>
        (!args.query_equals || r.query === args.query_equals) &&
        (!args.query_contains ||
          r.query.toLowerCase().includes(String(args.query_contains).toLowerCase())) &&
        (!args.query_not_contains ||
          !r.query.toLowerCase().includes(String(args.query_not_contains).toLowerCase())) &&
        (!args.page_equals || r.page === args.page_equals) &&
        (!args.page_contains || r.page.includes(String(args.page_contains))),
    );
    if (['query', 'page', 'query_page'].includes(report)) {
      const groups = new Map<string, typeof associations>();
      for (const r of associations) {
        const key = JSON.stringify({
          ...(report.includes('query') ? { query: r.query } : {}),
          ...(report.includes('page') ? { page: r.page } : {}),
        });
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      items = [...groups].map(([key, rs]) => {
        const clicks = rs.reduce((n, r) => n + r.clicks, 0),
          impressions = rs.reduce((n, r) => n + r.impressions, 0);
        return row(
          {
            clicks,
            impressions,
            ctr: clicks / impressions,
            position:
              Math.round(
                (rs.reduce((n, r) => n + r.position * r.impressions, 0) / impressions) * 1e6,
              ) / 1e6,
          },
          JSON.parse(key),
        );
      });
    } else
      items = aggregate
        ? [row({ clicks: 240, impressions: 6000, ctr: 0.04, position: 9.2 })]
        : [
            row(
              { clicks: 70, impressions: 1400, ctr: 0.05, position: 8.5 },
              { ...(report === 'device' ? { device: args.device ?? 'mobile' } : {}) },
            ),
            row(
              { clicks: 40, impressions: 1000, ctr: 0.04, position: 12 },
              { ...(report === 'device' ? { device: 'desktop' } : {}) },
            ),
          ];
  } else if (
    ['events', 'first_visits', 'form_submissions', 'warehouse_interest', 'lead_sources'].includes(
      report,
    )
  ) {
    columns = [column('eventCount'), column('totalUsers')];
    items =
      report === 'form_submissions' && !args.event_name
        ? [
            row(
              { eventCount: 60, totalUsers: 50 },
              { eventName: 'form_submit', pagePath: '/warehouses/bengaluru' },
            ),
            row(
              { eventCount: 40, totalUsers: 35 },
              { eventName: 'generate_lead', pagePath: '/warehouses/bengaluru' },
            ),
          ]
        : [
            row(
              { eventCount: 60, totalUsers: 50 },
              {
                eventName:
                  args.event_name ?? (report === 'first_visits' ? 'first_visit' : 'generate_lead'),
                pagePath: '/warehouses/bengaluru',
              },
            ),
          ];
  } else {
    columns = [
      column('sessions'),
      column('totalUsers'),
      column('engagementRate', 'fraction'),
      column('averageEngagementTimePerSession', 'seconds'),
    ];
    items = aggregate
      ? [
          row({
            sessions: 1200,
            totalUsers: 900,
            engagementRate: 0.6,
            averageEngagementTimePerSession: 45,
          }),
        ]
      : [
          row(
            {
              sessions: 500,
              totalUsers: 400,
              engagementRate: 0.64,
              averageEngagementTimePerSession: 48,
            },
            {
              ...(report === 'acquisition'
                ? { sessionDefaultChannelGroup: args.channel ?? 'Organic Search' }
                : { landingPage: args.landing_page_contains ?? '/warehouses/bengaluru' }),
              ...(report === 'devices' ? { deviceCategory: args.device ?? 'mobile' } : {}),
            },
          ),
          row(
            {
              sessions: 300,
              totalUsers: 240,
              engagementRate: 0.5,
              averageEngagementTimePerSession: 35,
            },
            {
              ...(report === 'acquisition'
                ? { sessionDefaultChannelGroup: 'Direct' }
                : { landingPage: '/warehouses/mumbai' }),
            },
          ),
        ];
  }
  items = items.slice(0, args.limit ?? 10);
  const data: Record<string, any> = {
    source: {
      system,
      property: system === 'ga4' ? 'fictional-property' : 'sc-domain:example.test',
      timezone,
    },
    source_status: { status: 'available', read_only: true },
    report,
    query_context,
    columns,
    items,
    pagination: {
      limit: args.limit ?? 10,
      returned_count: items.length,
      has_more: false,
      next_cursor: null,
      offset: 0,
      source_row_count: items.length,
      cap_reached: false,
      max_rows: 500,
      snapshot: false,
    },
    nextCursor: null,
    ...provenance,
    interpretation: {
      aggregation: aggregate ? 'aggregate' : 'grouped',
      page_basis:
        report === 'form_submissions'
          ? 'event_page'
          : args.landing_page_contains
            ? 'session_entry'
            : 'none',
      acquisition_basis: 'session',
      individual_journeys_available: false,
      crm_linkage_available: false,
      event_counts_are_unique_leads: false,
      limits: aggregate ? [] : ['Grouped top rows are not property totals.'],
    },
    quota: null,
    comparison: null,
  };
  if (args.compare_to) {
    const from = Date.parse(dates.date_from),
      days = Date.parse(dates.date_to) - from + DAY;
    data.comparison = {
      mode: 'previous_period',
      window: 'preceding_equal_days',
      read_consistency: 'independent_source_reads',
      baseline: {
        ...provenance,
        query_context: {
          ...query_context,
          period: null,
          date_from: iso(from - days),
          date_to: iso(from - DAY),
        },
      },
      metrics: columns.map((c) => {
        const current = items[0].metrics[c.name];
        const previous =
          c.unit === 'fraction'
            ? c.name === 'ctr'
              ? current
              : current - 0.1
            : c.unit === 'position'
              ? current + 1.2
              : current / 1.2;
        return {
          name: c.name,
          unit: c.unit,
          current,
          previous,
          absolute_change: current - previous,
          relative_change_percent: ['fraction', 'position'].includes(c.unit) ? null : 20,
          percentage_point_change: c.unit === 'fraction' ? (current - previous) * 100 : null,
          status: 'available',
        };
      }),
      warnings: ['Independent source reads, not a frozen snapshot.'],
    };
  }
  if (report === 'form_performance') {
    data.columns = [
      column('sessions'),
      column('formSubmitEventCount'),
      column('generateLeadEventCount'),
      column('formSubmitEventsPer100EntrySessions', 'events_per_100_sessions'),
      column('generateLeadEventsPer100EntrySessions', 'events_per_100_sessions'),
    ];
    data.items = [
      row({
        sessions: 1200,
        formSubmitEventCount: 60,
        generateLeadEventCount: 40,
        formSubmitEventsPer100EntrySessions: 5,
        generateLeadEventsPer100EntrySessions: 40 / 12,
      }),
    ];
    data.form_performance = {
      matching_cohort: true,
      read_consistency: 'independent_source_reads',
      denominator: 'matching_entry_sessions',
      components: ['sessions', 'form_submit', 'generate_lead'].map((name, i) => ({
        name,
        value: [1200, 60, 40][i],
        query_context: { ...query_context },
        ...structuredClone(provenance),
      })),
      ratios: [
        {
          event_name: 'form_submit',
          metric: 'formSubmitEventsPer100EntrySessions',
          value: 5,
          status: 'available',
        },
        {
          event_name: 'generate_lead',
          metric: 'generateLeadEventsPer100EntrySessions',
          value: 40 / 12,
          status: 'available',
        },
      ],
    };
    data.quality.warnings = [
      'Events per 100 matching entry sessions, not unique leads or visitor conversion. Never add the two events.',
    ];
  }
  let path = system === 'ga4' ? '/api/v1/analytics/ga4' : '/api/v1/analytics/search-console';
  if (tool === 'analytics_capabilities') {
    path = '/api/v1/analytics/capabilities';
    const reports = [
      'overview',
      'daily',
      'acquisition',
      'landing_pages',
      'pages',
      'devices',
      'countries',
      'events',
      'warehouse_interest',
      'lead_sources',
      'first_visits',
      'form_submissions',
      'form_performance',
    ];
    return {
      source_path: path,
      status: 200,
      data: {
        read_only: true,
        access: 'analysts_only',
        ga4: {
          status: 'available',
          timezone: 'Asia/Kolkata',
          reports: reports.map((name) => ({ name, available: true })),
          event_definitions: [
            {
              name: 'generate_lead',
              meaning: 'Recorded website enquiry event; not unique CRM leads.',
            },
          ],
        },
        search_console: {
          status: 'configured_not_verified',
          timezone: 'America/Los_Angeles',
          groups: ['summary', 'date', 'query', 'page', 'query_page', 'country', 'device'],
        },
        served_at: new Date(now).toISOString(),
        max_date_range_days: 93,
        max_rows_per_page: 25,
        max_report_rows: 500,
      },
      meta: { requestId: randomUUID(), generatedAt: new Date(now).toISOString() },
    };
  }
  const citation = Object.entries(args).filter(([key]) => ANALYTICS_CITATION_FIELDS.has(key));
  if (citation.length) path += '?' + new URLSearchParams(citation.map(([k, v]) => [k, String(v)]));
  return {
    source_path: path,
    status: 200,
    data,
    meta: { requestId: randomUUID(), generatedAt: new Date(now).toISOString() },
  };
}
