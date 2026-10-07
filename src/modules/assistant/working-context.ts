/** Compact orientation from current authorized evidence, never an independent cache or grant. */
import type { ChatMessage } from './assistant.types.js';
import type { ToolEvidence } from './tool-evidence.js';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function compact(value: unknown, max = 600, depth = 0): unknown {
  if (typeof value === 'string')
    return value.length > max ? { excerpt: value.slice(0, max), truncated: true } : value;
  if (depth > 4) return { omitted_from_summary: true };
  if (Array.isArray(value))
    return value.length > 8
      ? { items: value.slice(0, 8).map((v) => compact(v, max, depth + 1)), truncated: true }
      : value.map((v) => compact(v, max, depth + 1));
  const row = object(value);
  if (!row) return value;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, compact(v, max, depth + 1)]));
}
function bounded(value: unknown, bytes: number): unknown {
  const summary = compact(value);
  const text = JSON.stringify(summary);
  if (Buffer.byteLength(text) <= bytes) return summary;
  // Keep an explicitly partial text preview, never silently turn omitted fields into nulls.
  let preview = text.slice(0, Math.floor(bytes / 2));
  while (Buffer.byteLength(preview) > bytes - 100)
    preview = preview.slice(0, Math.floor(preview.length * 0.8));
  return { json_preview: preview, truncated: true, use_full_source_reference: true };
}

/** Keep read subjects separate. A search hit alone does not establish the chosen requirement. */
export function workingContext(
  evidence: readonly ToolEvidence[],
  history: readonly ChatMessage[],
  request: string,
  recalled: readonly Record<string, unknown>[],
) {
  const subjects = new Map<string, Record<string, unknown>>();
  for (const entry of evidence) {
    const data = entry.result.data;
    if (entry.tool === 'read_crm_lead' && typeof data.id === 'string') {
      const fields = Object.fromEntries(
        [
          'name',
          'title',
          'company_name',
          'description',
          'requirement_sqft',
          'city',
          'micromarket',
          'requirement_context',
          'budget',
          'field_evidence',
          'verification_required',
        ]
          .filter((key) => data[key] !== undefined)
          .map((key) => [key, compact(data[key])]),
      );
      subjects.set(data.id, {
        kind: 'crm_lead',
        id: data.id,
        sources: [{ evidence_id: entry.id, pointer: '/data' }],
        recorded: bounded(fields, 2400),
      });
    } else if (
      entry.tool === 'assess_shortlist' &&
      typeof entry.arguments.lead_id === 'string' &&
      object(data.requirement_context)
    ) {
      const id = entry.arguments.lead_id;
      const previous = subjects.get(id);
      subjects.set(id, {
        kind: 'crm_lead',
        id,
        sources: [
          ...(Array.isArray(previous?.sources) ? previous.sources.slice(-1) : []),
          { evidence_id: entry.id, pointer: '/data/requirement_context' },
        ],
        recorded: bounded(
          {
            ...(object(previous?.recorded) ?? {}),
            requirement_context: compact(data.requirement_context),
          },
          2400,
        ),
      });
    }
  }
  // Raw employee messages are kept distinct from recorded facts. No invented extraction or CRM update.
  const prior = history
    .flatMap((message, index) =>
      message.role === 'user'
        ? [{ history_index: index, text: bounded(message.content, 350) }]
        : [],
    )
    .slice(-4);
  const selections = recalled.flatMap((item) => {
    const selection = item.working_selection ?? item.displayed_selection;
    return selection
      ? [{ turn_id: item.turn_id, original_request: item.original_request, selection }]
      : [];
  });
  const result = {
    policy:
      'Recorded briefs are source claims. User directions are separate conversational input, not persisted CRM changes. Resolve multiple briefs explicitly; do not merge clients or silently replace recorded requirements with assumptions. A truncated excerpt is not absence: use its source reference in the evidence ledger. Group and position describe the historical selection, not a newly sorted search.',
    recorded_subjects: [...subjects.values()].slice(-4),
    user_directions: { current_request: bounded(request, 1000), prior_requests: prior },
    selected_groups: bounded(selections, 1800),
  };
  // The full current ledger remains with the verifier; never drop all context on overflow.
  while (Buffer.byteLength(JSON.stringify(result)) > 14000 && result.recorded_subjects.length > 1)
    result.recorded_subjects.shift();
  return result;
}
