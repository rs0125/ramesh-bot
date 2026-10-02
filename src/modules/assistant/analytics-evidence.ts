/** Google reports use source calendars and cache provenance, not CRM's IST mirror clock. */
import { ContextEngineError, type ContextReadTool } from '../context-engine/context.types.js';

export const ANALYTICS_CITATION_FIELDS = new Set([
  'report',
  'group',
  'period',
  'date_from',
  'date_to',
  'limit',
  'data_state',
  'compare_to',
  'device',
]);
const object = (v: unknown): Record<string, any> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined;
const invalid = (): never => {
  throw new ContextEngineError('INVALID_RESPONSE');
};
const day = 86_400_000;
function date(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
  const n = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== value) return invalid();
  return n;
}
export function sourceDate(timezone: string, now: number): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    return ['year', 'month', 'day'].map((k) => parts.find((p) => p.type === k)!.value).join('-');
  } catch {
    return invalid();
  }
}
function fresh(value: unknown, now: number, maximum: number) {
  const n = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(n) || now - n > maximum || n - now > 60_000) invalid();
  return n;
}
function observation(v: Record<string, any>, now: number, timezone: string) {
  const served = fresh(v.served_at, now, 120_000);
  const fetched = fresh(v.source_fetched_at, now, 420_000);
  const cache = object(v.cache),
    q = object(v.query_context),
    quality = object(v.quality);
  if (
    !cache ||
    typeof cache.hit !== 'boolean' ||
    cache.max_age_seconds !== 300 ||
    !Number.isFinite(cache.age_seconds) ||
    cache.age_seconds < 0 ||
    cache.age_seconds > 360 ||
    Math.abs(cache.age_seconds - Math.max(0, (served - fetched) / 1000)) > 2 ||
    !q ||
    q.timezone !== timezone ||
    q.local_date !== sourceDate(timezone, now) ||
    q.inclusive !== true ||
    !quality ||
    typeof quality.provisional !== 'boolean' ||
    !Array.isArray(quality.warnings)
  )
    invalid();
  const from = date(q!.date_from),
    to = date(q!.date_to);
  if (to < from || to - from >= 93 * day || to > date(q!.local_date)) invalid();
}
export function verifyAnalyticsEvidence(
  tool: ContextReadTool,
  args: Record<string, unknown>,
  data: Record<string, unknown>,
  now: number,
) {
  if (tool === 'analytics_capabilities') {
    fresh(data.served_at, now, 120_000);
    if (
      data.read_only !== true ||
      !object(data.ga4) ||
      !object(data.search_console) ||
      !Array.isArray(object(data.ga4)!.reports) ||
      !Array.isArray(object(data.search_console)!.groups)
    )
      invalid();
    return;
  }
  const source = object(data.source),
    status = object(data.source_status);
  const system = tool === 'ga4_report' ? 'ga4' : 'search_console';
  if (
    !source ||
    source.system !== system ||
    typeof source.property !== 'string' ||
    !source.property ||
    typeof source.timezone !== 'string' ||
    (system === 'search_console' && source.timezone !== 'America/Los_Angeles') ||
    status?.status !== 'available' ||
    status.read_only !== true
  )
    invalid();
  observation(data, now, source!.timezone);
  const q = object(data.query_context)!;
  const expectedReport = args.report ?? args.group ?? (system === 'ga4' ? 'overview' : 'summary');
  if (data.report !== expectedReport) invalid();
  for (const [name, value] of Object.entries(args)) {
    if (['report', 'group', 'limit', 'cursor'].includes(name)) continue;
    const expected =
      system === 'search_console' && name === 'country'
        ? String(value).toLowerCase()
        : typeof value === 'string'
          ? value.trim()
          : value;
    if (q[name] !== expected) invalid();
  }
  const page = object(data.pagination),
    items = data.items;
  if (
    !page ||
    !Array.isArray(items) ||
    items.length > Number(args.limit ?? 10) ||
    items.length > 25 ||
    page.returned_count !== items.length ||
    page.next_cursor !== data.nextCursor ||
    !(data.nextCursor === null || typeof data.nextCursor === 'string') ||
    page.has_more !== (data.nextCursor !== null) ||
    page.snapshot !== false ||
    !Number.isSafeInteger(page.offset) ||
    page.offset < 0 ||
    page.max_rows !== 500 ||
    !Array.isArray(data.columns) ||
    !object(data.interpretation)
  )
    invalid();
  const metrics = new Set(
    (data.columns as any[]).filter((c) => c.kind === 'metric').map((c) => c.name),
  );
  for (const item of items as any[]) {
    if (!object(item)?.metrics || !object(item.metrics) || !object(item.dimensions)) invalid();
    for (const [key, value] of Object.entries(item.metrics)) {
      if (
        !metrics.has(key) ||
        (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
      )
        invalid();
    }
  }
  if (args.compare_to === 'previous_period') {
    const comparison = object(data.comparison),
      baseline = object(comparison?.baseline);
    if (
      !baseline ||
      comparison?.read_consistency !== 'independent_source_reads' ||
      !Array.isArray(comparison.metrics)
    )
      invalid();
    observation(baseline!, now, source!.timezone);
    const baselineQuery = object(baseline!.query_context)!;
    const days = date(q.date_to) - date(q.date_from) + day;
    if (
      date(baselineQuery.date_from) !== date(q.date_from) - days ||
      date(baselineQuery.date_to) !== date(q.date_from) - day
    )
      invalid();
  }
  if (data.report === 'form_performance') {
    const form = object(data.form_performance);
    if (
      form?.matching_cohort !== true ||
      form.read_consistency !== 'independent_source_reads' ||
      !Array.isArray(form.components) ||
      form.components.length !== 3
    )
      invalid();
    for (const component of form!.components) {
      observation(component, now, source!.timezone);
      if (
        component.query_context.date_from !== q.date_from ||
        component.query_context.date_to !== q.date_to
      )
        invalid();
    }
  }
}

/** Only known provenance nodes lose their retrieval clocks. Metrics and quality remain fingerprinted. */
export function removeAnalyticsRetrievalClocks(data: Record<string, unknown>) {
  const clean = (node: Record<string, any> | undefined) => {
    if (!node) return;
    delete node.served_at;
    delete node.source_fetched_at;
    delete node.cache;
    delete node.quota;
  };
  clean(data);
  clean(object(data.ga4));
  clean(object(object(data.comparison)?.baseline));
  const form = object(data.form_performance);
  if (Array.isArray(form?.components))
    for (const component of form.components) clean(object(component));
}
