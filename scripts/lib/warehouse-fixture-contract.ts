/** Small synthetic contract model, not a database or a suitability engine. */
export const NUMERIC_FILTERS = [
  ['dock_count', 'docks_min', 'docks_max'],
  ['clear_height_ft', 'clear_height_min_ft', 'clear_height_max_ft'],
  ['asking_rate_per_sqft', 'min_rate', 'max_rate'],
  ['gate_size_ft', 'gate_width_min_ft', 'gate_width_max_ft'],
  ['plinth_height_ft', 'plinth_height_min_ft', 'plinth_height_max_ft'],
  ['dock_apron_length_ft', 'dock_apron_min_ft', 'dock_apron_max_ft'],
  ['approach_road_width_ft', 'approach_road_min_ft', 'approach_road_max_ft'],
  ['power_kva', 'power_min_kva', 'power_max_kva'],
  ['washroom_count', 'washrooms_min', 'washrooms_max'],
] as const;

export function recordedText(text: string | null) {
  return { state: text === null ? 'missing' : 'present', text, redacted: false, truncated: false };
}
export type FixtureMeasurement = {
  kind: 'exact' | 'approximate' | 'range' | 'unknown';
  value?: number;
  lower?: number;
  upper?: number;
  source?: string;
  recorded_source?: ReturnType<typeof recordedText>;
};
export type FixtureWarehouse = {
  id: number;
  city: string;
  micromarkets: string[];
  total_space_sqft: number[];
  field_evidence: Record<string, FixtureMeasurement>;
  recorded_context: Record<string, ReturnType<typeof recordedText>>;
  [field: string]: unknown;
};

export function fixtureMatchingPolicy(args: Record<string, unknown>) {
  const mode = args.match_mode === 'strict' ? 'strict' : 'permissive';
  return {
    mode,
    include_unknown:
      args.include_unknown === undefined ? mode === 'permissive' : args.include_unknown === 'true',
    range_matching: 'overlap',
    guidance:
      'Unknown numeric values remain candidates by default. Approximate values and overlapping ranges require verification. Exact category and boolean filters are not relaxed. Offered areas are alternatives, never a summed capacity.',
  };
}

const normalizeCity = (value: unknown) => {
  const label = String(value).trim().toLowerCase();
  return label === 'bangalore' ? 'bengaluru' : label === 'gurgaon' ? 'gurugram' : label;
};

export function fixtureWarehouseMatches(row: FixtureWarehouse, args: Record<string, unknown>) {
  const policy = fixtureMatchingPolicy(args);
  for (const [argument, field] of [
    ['city', 'city'],
    ['state', 'state'],
    ['type', 'warehouse_type'],
    ['zone', 'zone'],
    ['micromarket', 'micromarkets'],
    ['availability', 'availability'],
    ['status', 'status'],
    ['listing_type', 'listing_type'],
    ['flooring_type', 'flooring_type'],
    ['land_type', 'land_type'],
    ['pollution_zone', 'pollution_zone'],
    ['water_supply', 'water_supply'],
    ['suitable_for', 'suitable_for'],
  ]) {
    if (args[argument!] === undefined) continue;
    const values = Array.isArray(row[field!]) ? (row[field!] as unknown[]) : [row[field!]];
    const normal =
      argument === 'city' ? normalizeCity : (value: unknown) => String(value).trim().toLowerCase();
    if (!values.some((value) => value != null && normal(value) === normal(args[argument!])))
      return false;
  }
  for (const [argument, field] of [
    ['fire_noc', 'fire_noc_available'],
    ['verified', 'verified'],
    ['lift_access', 'lift_access'],
  ]) {
    if (args[argument!] === undefined) continue;
    const expected = args[argument!] === 'unknown' ? null : args[argument!] === 'true';
    if ((row[field!] ?? null) !== expected) return false;
  }
  const lower = [args.area_min_sqft, args.offered_area_min_sqft]
    .filter((value) => value !== undefined)
    .map(Number);
  const upper = [args.area_max_sqft, args.offered_area_max_sqft]
    .filter((value) => value !== undefined)
    .map(Number);
  if (lower.length || upper.length) {
    if (!row.total_space_sqft.length) {
      if (!policy.include_unknown) return false;
    } else if (
      !row.total_space_sqft.some(
        (value) => value >= Math.max(-Infinity, ...lower) && value <= Math.min(Infinity, ...upper),
      )
    )
      return false;
  }
  return NUMERIC_FILTERS.every(([field, minimum, maximum]) => {
    if (args[minimum] === undefined && args[maximum] === undefined) return true;
    const evidence = row.field_evidence[field]!;
    if (evidence.kind === 'unknown') return policy.include_unknown;
    if (policy.mode === 'strict' && evidence.kind !== 'exact') return false;
    const low = evidence.kind === 'range' ? evidence.lower! : evidence.value!;
    const high = evidence.kind === 'range' ? evidence.upper! : evidence.value!;
    return (
      (args[minimum] === undefined || high >= Number(args[minimum])) &&
      (args[maximum] === undefined || low <= Number(args[maximum]))
    );
  });
}

export function fixtureWarehouses(
  count: number,
  allBengaluru: boolean,
  start: number,
  messy: boolean,
): FixtureWarehouse[] {
  return Array.from({ length: count }, (_, i) => {
    const exact = (value: number): FixtureMeasurement => ({
      kind: 'exact',
      value,
      source: String(value),
    });
    const field_evidence: Record<string, FixtureMeasurement> = Object.fromEntries(
      NUMERIC_FILTERS.map(([field]) => [
        field,
        { kind: 'unknown', recorded_source: recordedText(null) },
      ]),
    );
    field_evidence.dock_count = exact(i + 1);
    field_evidence.clear_height_ft = exact(24 + i);
    if (messy && i === 0)
      field_evidence.dock_count = { kind: 'approximate', value: 3, source: 'about 3' };
    if (messy && i === 1)
      field_evidence.clear_height_ft = {
        kind: 'unknown',
        recorded_source: recordedText(
          'Height varies below roof bracing; measure usable clearance.',
        ),
      };
    if (messy && i === 2)
      field_evidence.clear_height_ft = {
        kind: 'range',
        lower: 24,
        upper: 30,
        source: '24 to 30 ft',
      };
    const total_space_sqft =
      messy && i === 3 ? [18000, 28000] : messy && i === 4 ? [] : [26000 + i * 1000];
    return {
      id: 101 + i,
      city: allBengaluru || i < 5 ? 'Bengaluru' : 'Pune',
      state: allBengaluru || i < 5 ? 'Karnataka' : 'Maharashtra',
      micromarkets: [allBengaluru || i < 5 ? 'Hoskote' : 'Chakan'],
      warehouse_type: 'PEB',
      total_space_sqft,
      ...Object.fromEntries(
        NUMERIC_FILTERS.map(([field]) => [
          field,
          field_evidence[field]!.kind === 'exact' ? field_evidence[field]!.value : null,
        ]),
      ),
      availability: 'Yes',
      verified: false,
      fire_noc_available: messy ? (i === 0 ? true : i === 4 ? false : null) : null,
      lift_access: null,
      flooring_type: null,
      land_type: null,
      image_count: 0,
      video_count: 0,
      has_valid_google_maps_id: false,
      verification_required: true,
      created_at: new Date(start - i * 86_400_000).toISOString(),
      updated_at: new Date(start).toISOString(),
      field_evidence,
      recorded_context: {
        compliances: recordedText(
          messy && i === 0
            ? 'Fire certificate recorded; full client compliance checklist and current documents have not been verified.'
            : 'Compliance documents need owner confirmation.',
        ),
        floor_strength_per_sqm: recordedText('Floor load certificate not supplied.'),
        other_specifications: recordedText(
          'Truck access and usable layout need a site inspection.',
        ),
      },
    };
  });
}
