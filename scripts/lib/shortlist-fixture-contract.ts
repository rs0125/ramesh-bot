import { recordedText, type FixtureWarehouse } from './warehouse-fixture-contract.js';

type Lead = {
  id: string;
  name: string;
  city: string;
  requirement_sqft: number;
  source_updated_at: string;
  description: ReturnType<typeof recordedText>;
};

/** Same public result shape as assess_shortlist. Only the synthetic facts below
 * are assessed; this is deliberately not a second implementation of the engine. */
export function fixtureAssessment(
  lead: Lead,
  warehouses: FixtureWarehouse[],
  args: Record<string, unknown>,
) {
  const source_path = `/api/v1/crm/opportunities/${lead.id}`;
  const recorded: Record<string, unknown> = {
    city: lead.city,
    area_sqft: { kind: 'exact', value: lead.requirement_sqft },
  };
  const overrides: Record<string, unknown> = {
    ...(args.city !== undefined ? { city: args.city } : {}),
    ...(args.micromarket !== undefined ? { micromarket: args.micromarket } : {}),
    ...(args.area_min_sqft !== undefined || args.area_max_sqft !== undefined
      ? {
          area_sqft: {
            kind: 'explicit_bounds',
            min: args.area_min_sqft ?? null,
            max: args.area_max_sqft ?? null,
          },
        }
      : {}),
    ...Object.fromEntries(
      [
        ['dock_count', 'docks_min'],
        ['clear_height_ft', 'clear_height_min_ft'],
        ['power_kva', 'power_min_kva'],
        ['move_in_by', 'move_in_by'],
      ]
        .filter(([, argument]) => args[argument!] !== undefined)
        .map(([field, argument]) => [field, args[argument!]]),
    ),
  };
  const fields = [
    'city',
    'micromarket',
    'area_sqft',
    'budget',
    'lease_duration',
    'move_in_by',
    'dock_count',
    'clear_height_ft',
    'power_kva',
  ];
  const requirements = fields.map((field) => ({
    field,
    status: field in overrides || field in recorded ? 'needs_confirmation' : 'missing',
    source:
      field in overrides ? 'employee_override' : field in recorded ? 'crm_record' : 'not_recorded',
    recorded_value: recorded[field] ?? null,
    effective_value: overrides[field] ?? recorded[field] ?? null,
    override_differs_from_record:
      field in overrides &&
      JSON.stringify(overrides[field]) !== JSON.stringify(recorded[field] ?? null),
    reason:
      field in overrides
        ? 'Employee-supplied criterion for this request; the CRM was not changed.'
        : field in recorded
          ? 'Recorded requirement; confirm with the client.'
          : 'Not recorded in a structured field.',
    follow_up_question: `Confirm ${field.replaceAll('_', ' ')} if relevant to this decision.`,
  }));
  return {
    lead: {
      id: lead.id,
      source_path,
      source_updated_at: lead.source_updated_at,
      last_polled_at: lead.source_updated_at,
    },
    requirement_context: {
      name: lead.name,
      company_name: null,
      description: lead.description,
      industry_verticals: ['OTHER'],
      field_evidence: Object.fromEntries(
        [
          'name',
          'company_name',
          'city',
          'micro_market',
          'requirement_sqft',
          'budget',
          'lease_duration',
          'occupancy_timelines',
          'industry_verticals',
        ].map((field) => {
          const value =
            field === 'name'
              ? lead.name
              : field === 'city'
                ? lead.city
                : field === 'requirement_sqft'
                  ? String(lead.requirement_sqft)
                  : field === 'industry_verticals'
                    ? 'OTHER'
                    : null;
          return [
            field,
            {
              state: value === null ? 'missing' : 'parsed',
              source: value === null ? null : recordedText(value),
            },
          ];
        }),
      ),
      source_path,
      source_updated_at: lead.source_updated_at,
      last_polled_at: lead.source_updated_at,
      notes: {
        status: 'not_loaded',
        tool: 'read_crm_lead_context',
        source_path: `${source_path}/context?section=notes`,
      },
    },
    requirements,
    candidates: warehouses.map((row) => {
      const area = requirements.find((item) => item.field === 'area_sqft')!.effective_value as {
        value?: number;
        min?: number;
        max?: number;
      };
      const areaMatch = row.total_space_sqft.some(
        (value) => value >= (area.min ?? area.value ?? 0) && value <= (area.max ?? Infinity),
      );
      const cityMatch =
        row.city === requirements.find((item) => item.field === 'city')!.effective_value;
      const checks = [
        {
          field: 'city',
          state: cityMatch ? 'meets_recorded_requirement' : 'conflict',
          requirement: overrides.city ?? lead.city,
          evidence: row.city,
          reason: 'Comparison with the effective location.',
          verification_question: 'Confirm the accepted location with the client.',
        },
        {
          field: 'area_sqft',
          state: row.total_space_sqft.length
            ? areaMatch
              ? 'meets_recorded_requirement'
              : 'conflict'
            : 'unknown',
          requirement: area,
          evidence: row.total_space_sqft,
          reason: 'One offered area option must meet the bounds; options are not added.',
          verification_question:
            'Confirm one contiguous usable offered area and client acceptance.',
        },
      ];
      return {
        id: row.id,
        source_path: `/api/v1/warehouses/${row.id}`,
        source_updated_at: row.updated_at,
        source_timestamp_semantics:
          'Listing update timestamp; not a site verification or live availability check.',
        recorded_availability: row.availability,
        recorded_status: null,
        checks,
        check_counts: Object.fromEntries(
          ['meets_recorded_requirement', 'conflict', 'possible', 'unknown'].map((state) => [
            state,
            checks.filter((check) => check.state === state).length,
          ]),
        ),
        verification_required: true,
        source_verification_required: row.verification_required,
        verification_questions: checks.map((check) => check.verification_question),
        source_uncertain_fields: Object.entries(row.field_evidence)
          .filter(([, evidence]) => evidence.kind !== 'exact')
          .map(([field, evidence]) => ({ field, evidence })),
      };
    }),
    guidance: [
      'Read the narrative requirement_context before searching. Structured checks do not cover every requirement or gate provisional recommendations.',
      'Missing structured values are unknown, not failed requirements. Recorded matches are not verified suitability, compliance, availability or client acceptance.',
      'Notes have not been loaded; use the separately authorized notes tool when relevant. Explicit overrides apply only to this assessment and do not modify the CRM.',
    ],
  };
}
