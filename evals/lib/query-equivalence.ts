/** Compare meaning before spelling: CRM and Google reporting calendars differ. */
export function queryBounds(
  tool: string,
  args: Record<string, unknown>,
  localDate: string,
): [string | undefined, string | undefined] {
  if (args.date_from || args.date_to)
    return [args.date_from as string | undefined, args.date_to as string | undefined];
  const today = Date.parse(`${localDate}T00:00:00Z`);
  if (!Number.isFinite(today)) return [undefined, undefined];
  const day = 86400000,
    d = new Date(today);
  const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const monday = today - ((d.getUTCDay() + 6) % 7) * day;
  const crm = tool === 'search_crm_leads' || tool === 'crm_summary';
  const ranges: Record<string, number[]> = {
    today: [today, today],
    yesterday: [today - day, today - day],
    tomorrow: [today + day, today + day],
    this_week: [monday, monday + 6 * day],
    last_week: [monday - 7 * day, monday - day],
    this_month: [month, crm ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) : today],
    last_month: [Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1), month - day],
    last_7_days: crm ? [today - 6 * day, today] : [today - 7 * day, today - day],
    last_28_days: [today - 28 * day, today - day],
    last_30_days: [today - 29 * day, today],
    next_7_days: [today, today + 6 * day],
  };
  const period =
    crm && args.follow_up_status === 'today' && !args.period ? 'today' : String(args.period);
  const range = ranges[period];
  return range
    ? [
        new Date(range[0]!).toISOString().slice(0, 10),
        new Date(range[1]!).toISOString().slice(0, 10),
      ]
    : [undefined, undefined];
}
export function matchesQuery(
  tool: string,
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  localDate: string,
): boolean {
  const temporal = ['period', 'date_from', 'date_to', 'follow_up_status'].some(
    (k) => k in expected,
  );
  const crm = tool === 'search_crm_leads' || tool === 'crm_summary';
  const field = (args: Record<string, unknown>) =>
    args.date_field ?? (args.follow_up_status === 'today' ? 'follow_up' : 'created');
  if (crm && (temporal || 'date_field' in expected) && field(actual) !== field(expected))
    return false;
  // Mutually exclusive forms are not semantically valid, even if the literal values match.
  if (actual.period && (actual.date_from || actual.date_to)) return false;
  if (crm && actual.follow_up_status && actual.date_field === 'follow_up') return false;
  const a = queryBounds(tool, actual, localDate),
    e = queryBounds(tool, expected, localDate);
  return Object.entries(expected).every(([key, value]) => {
    if (key === 'date_field' && crm) return field(actual) === value;
    if (
      key === 'period' ||
      key === 'date_from' ||
      key === 'date_to' ||
      (key === 'follow_up_status' && value === 'today')
    ) {
      if (e[0] || e[1]) return a[0] === e[0] && a[1] === e[1];
    }
    if (
      tool === 'search_console_report' &&
      ['query_contains', 'query_not_contains', 'page_contains', 'country'].includes(key) &&
      typeof value === 'string' &&
      typeof actual[key] === 'string'
    )
      return actual[key].toLowerCase() === value.toLowerCase();
    return JSON.stringify(actual[key]) === JSON.stringify(value);
  });
}
