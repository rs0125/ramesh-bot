/** Source and delivery contracts shared by general read execution and saved-output reauthorization. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ContextEngineError,
  CONTEXT_READ_TOOLS,
  isContextReadTool,
  type ContextReadTool,
  type ContextEvidence,
  type ContextToolDefinition,
} from '../context-engine/context.types.js';
import {
  argumentsSha256,
  canonicalJson,
  schemaAccepts,
  TOOL_NAME,
} from '../context-engine/read-contract.js';
import { indiaDate } from './followups.js';
import { recordIdentity, recordIdentitySchema } from './record-identity.js';
import {
  ANALYTICS_CITATION_FIELDS,
  verifyAnalyticsEvidence,
  removeAnalyticsRetrievalClocks,
} from './analytics-evidence.js';

export const MAX_TOOL_CALLS = 24;
export const MAX_TOOL_RESULT_BYTES = 80_000;
export const MAX_RUN_EVIDENCE_BYTES = 200_000;
const instant = z.iso.datetime({ offset: true });
export const toolDeliverySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('context_tools'),
    employeeId: z.number().int().positive().safe(),
    localDate: z.iso.date(),
    preparedAt: instant,
    expiresAt: instant,
    checks: z
      .array(
        z
          .object({
            tool: z.string().regex(TOOL_NAME),
            arguments: z.record(z.string(), z.unknown()),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            records: recordIdentitySchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TOOL_CALLS),
  })
  .strict();
export type ToolDelivery = z.infer<typeof toolDeliverySchema>;
export interface ToolEvidence {
  id: string;
  tool: ContextReadTool;
  arguments: Record<string, unknown>;
  result: ContextEvidence;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
function invalid(): never {
  throw new ContextEngineError('INVALID_RESPONSE');
}
function sourcePath(tool: ContextReadTool, args: Record<string, unknown>) {
  switch (tool) {
    case 'analytics_capabilities':
      return '/api/v1/analytics/capabilities';
    case 'ga4_report':
      return '/api/v1/analytics/ga4';
    case 'search_console_report':
      return '/api/v1/analytics/search-console';
    case 'get_context':
      return '/api/v1/context';
    case 'search_knowledge':
      return `/api/v1/wiki/${args.q ? 'search' : 'pages'}`;
    case 'read_knowledge':
      return `/api/v1/wiki/pages/${encodeURIComponent(String(args.id))}`;
    case 'warehouse_filters':
      return '/api/v1/warehouses/filters';
    case 'search_warehouses':
      return '/api/v1/warehouses';
    case 'warehouse_summary':
      return '/api/v1/warehouses/summary';
    case 'read_warehouse':
      return `/api/v1/warehouses/${args.id}`;
    case 'crm_filters':
      return '/api/v1/crm/filters';
    case 'search_crm_leads':
      return '/api/v1/crm/opportunities';
    case 'crm_summary':
      return '/api/v1/crm/summary';
    case 'read_crm_lead':
      return `/api/v1/crm/opportunities/${args.id}`;
    case 'read_crm_lead_context':
      return `/api/v1/crm/opportunities/${args.id}/context`;
    case 'crm_briefing':
      return '/api/v1/crm/my-briefing';
    case 'assess_shortlist':
      return `/api/v1/crm/opportunities/${args.lead_id}/assessment`;
  }
}

export function verifyToolEvidence(
  tool: ContextReadTool,
  args: Record<string, unknown>,
  evidence: ContextEvidence,
  now = Date.now(),
  definition?: ContextToolDefinition,
): void {
  if (
    !TOOL_NAME.test(tool) ||
    !evidence.source_path.startsWith('/api/v1/') ||
    evidence.source_path.includes('\\')
  )
    invalid();
  const citation = new URL(evidence.source_path, 'https://context.invalid');
  if (
    citation.origin !== 'https://context.invalid' ||
    citation.pathname !== evidence.source_path.split(/[?#]/)[0] ||
    /%(?:2e|2f|5c)/i.test(citation.pathname) ||
    citation.hash
  )
    invalid();
  const bound = evidence.meta.toolName !== undefined || evidence.meta.argumentsSha256 !== undefined;
  if (
    (bound || !isContextReadTool(tool)) &&
    (evidence.meta.toolName !== tool || evidence.meta.argumentsSha256 !== argumentsSha256(args))
  )
    invalid();
  if (definition?.outputSchema && !schemaAccepts(definition.outputSchema, evidence)) invalid();
  const generated = Date.parse(evidence.meta.generatedAt);
  if (
    evidence.status !== 200 ||
    !evidence.meta.requestId ||
    !Number.isFinite(generated) ||
    Math.abs(now - generated) > 120_000
  )
    invalid();
  if (Buffer.byteLength(JSON.stringify(evidence)) > MAX_TOOL_RESULT_BYTES)
    throw new ContextEngineError('RESPONSE_TOO_LARGE');
  // New CE tools use their live output schema and request binding. Existing source-specific
  // checks remain compatibility semantics, not an admission list for future tools.
  if (!isContextReadTool(tool)) return;
  if (citation.pathname !== sourcePath(tool, args)) invalid();
  const expected = Object.entries(args).filter(
    ([name]) =>
      (CONTEXT_READ_TOOLS[tool] !== 'analytics:read' || ANALYTICS_CITATION_FIELDS.has(name)) &&
      !['id', 'lead_id', 'cursor'].includes(name) &&
      !(tool === 'search_warehouses' && name === 'response_format') &&
      tool !== 'assess_shortlist',
  );
  if (
    citation.searchParams.size !== expected.length ||
    expected.some(([name, value]) => citation.searchParams.get(name) !== String(value))
  )
    invalid();
  const data = evidence.data;
  if (CONTEXT_READ_TOOLS[tool] === 'analytics:read') {
    verifyAnalyticsEvidence(tool, args, data, now);
    return;
  }
  const query = object(data.query_context);
  if (query) {
    const asOf = Date.parse(String(query.as_of));
    if (
      query.timezone !== 'Asia/Kolkata' ||
      query.local_date !== indiaDate(now) ||
      !Number.isFinite(asOf) ||
      Math.abs(now - asOf) > 120_000
    )
      invalid();
    if (
      Array.isArray(data.items) &&
      (query.returned_count !== data.items.length || query.has_more !== (data.nextCursor !== null))
    )
      invalid();
    for (const name of ['sort', 'date_field', 'period'])
      if (args[name] !== undefined && query[name] !== args[name]) invalid();
    if (args.date_from !== undefined && query.date_from !== args.date_from) invalid();
    if (args.date_to !== undefined && query.date_to !== args.date_to) invalid();
    if (
      args.follow_up_status !== undefined &&
      object(query.follow_up)?.status !== args.follow_up_status
    )
      invalid();
  }
  if (tool === 'search_crm_leads' || tool === 'search_warehouses') {
    if (
      !query ||
      !Array.isArray(data.items) ||
      data.items.length > 25 ||
      !(data.nextCursor === null || typeof data.nextCursor === 'string')
    )
      invalid();
    if (args.limit !== undefined && data.items.length > Number(args.limit)) invalid();
    const ids = data.items.map((item) => object(item)?.id);
    if (ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) invalid();
  }
  if (tool === 'crm_summary' || tool === 'warehouse_summary') {
    if (
      !Number.isSafeInteger(data.total) ||
      Number(data.total) < 0 ||
      !Array.isArray(data.groups) ||
      !Number.isSafeInteger(data.other_count) ||
      Number(data.other_count) < 0
    )
      invalid();
    let sum = Number(data.other_count);
    for (const item of data.groups) {
      const count = object(item)?.count;
      if (!Number.isSafeInteger(count) || Number(count) < 0) invalid();
      sum += Number(count);
    }
    if (sum !== data.total) invalid();
  }
  if (CONTEXT_READ_TOOLS[tool] === 'crm:read') {
    if (!['all', 'created_or_assigned', 'created', 'assigned'].includes(String(data.access_scope)))
      invalid();
    if ((args.view === 'assigned' || args.view === 'created') && data.access_scope !== args.view)
      invalid();
    const consistency = object(data.read_consistency);
    if (
      consistency?.database_snapshot !== 'repeatable_read' ||
      consistency.lead_fields !== 'same_row' ||
      consistency.cross_request_snapshot !== false
    )
      invalid();
    const source = object(object(data.source_status)?.opportunities);
    const synced = Date.parse(String(source?.last_run_at));
    if (
      source?.status !== 'ok' ||
      !Number.isFinite(synced) ||
      now - synced > 30 * 60_000 ||
      now - synced < -60_000
    )
      throw new ContextEngineError('UNAVAILABLE');
  }
}

/** Ignore retrieval clocks, not record timestamps or business values. */
export function toolEvidenceFingerprint(evidence: ContextEvidence, tool?: ContextReadTool): string {
  const name =
    tool ?? (typeof evidence.meta.toolName === 'string' ? evidence.meta.toolName : undefined);
  if (name !== undefined && !isContextReadTool(name)) {
    const value = structuredClone(evidence);
    const metadata: Record<string, unknown> = { ...value.meta };
    delete metadata.requestId;
    delete metadata.generatedAt;
    return createHash('sha256')
      .update(canonicalJson({ ...value, meta: metadata }))
      .digest('hex');
  }
  const data = structuredClone(evidence.data);
  if (evidence.source_path.startsWith('/api/v1/analytics/')) removeAnalyticsRetrievalClocks(data);
  delete data.source_status;
  delete data.source_fetched_at;
  delete data.as_of;
  const query = object(data.query_context);
  if (query) delete query.as_of;
  const clock = object(data.server_clock);
  if (clock) delete clock.as_of;
  const consistency = object(data.read_consistency);
  if (consistency) delete consistency.transaction_started_at;
  // A mirror poll may advance with identical business facts.
  const removePoll = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(removePoll)
      : object(value)
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(([key]) => key !== 'last_polled_at')
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, nested]) => [key, removePoll(nested)]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(removePoll(data)))
    .digest('hex');
}

export function toolDelivery(
  employeeId: number,
  evidence: readonly ToolEvidence[],
  now = Date.now(),
): ToolDelivery {
  const localDate = indiaDate(now);
  const midnight = Date.parse(`${localDate}T00:00:00+05:30`) + 86_400_000;
  return toolDeliverySchema.parse({
    version: 1,
    kind: 'context_tools',
    employeeId,
    localDate,
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(now + 300_000, midnight)).toISOString(),
    checks: evidence.map((item) => {
      const records = recordIdentity(item.tool, item.result);
      return {
        tool: item.tool,
        arguments: item.arguments,
        fingerprint: toolEvidenceFingerprint(item.result, item.tool),
        ...(records ? { records } : {}),
      };
    }),
  });
}
