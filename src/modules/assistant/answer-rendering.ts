/** CRM metadata is rendered from explicit record identities, never inferred from prose. */
import { z } from 'zod';
import { nativeCrmRecords } from './record-identity.js';
import { finishReply } from './style.js';
import type { ToolEvidence } from './tool-evidence.js';

export const answerBlocksSchema = z
  .object({
    answer_blocks: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('text'), text: z.string().max(12000) }).strict(),
          z
            .object({
              kind: z.literal('crm_record'),
              record_id: z.string().min(1).max(200),
              body: z.string().max(12000),
              include_time: z.boolean().default(false),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(60),
  })
  .strict();
export const answerContentSchema = z.union([z.string().max(12000), answerBlocksSchema]);
export type AnswerContent = z.infer<typeof answerContentSchema>;

export const ANSWER_RENDERING_CONTRACT = `For current CRM cards backed by read_crm_lead, search_crm_leads or crm_briefing evidence, return an internal JSON answer envelope: {"answer_blocks":[{"kind":"text","text":"Introduction or comparison prose"},{"kind":"crm_record","record_id":"exact ID from current CRM evidence","body":"Requirement, stage and other supported details; no Created:/Last updated: fields","include_time":false}]}. The application renders each crm_record block with its exact source name, native Created/Last updated dates in IST and your body. Set include_time=true when native timestamps are requested. Record IDs are internal bindings, never displayed. Do not add extra block fields, duplicate native date labels in body or use warehouse IDs as CRM bindings. Use text blocks for warehouses, caveats, drafts and ordinary mentions. Preserve record order and requested grouping. For other CRM/tool result shapes and answers without these current CRM cards, use ordinary prose; do not guess a supported card binding. Historical-only answers use prose labelled historical, never current CRM bindings. For action composition, additional_reply can contain this envelope instead of a string; never include or rewrite the application-owned receipt. Missing optional card metadata alone must not erase a useful answer; requested dates and every date actually claimed must still be supported.`;

export interface RenderedCrmRecord {
  record_id: string;
  label: string;
  created: string;
  last_updated: string;
}
/** Exact application-rendered names are source data, not model style choices. */
export function answerStyleText(text: string, records: readonly RenderedCrmRecord[]) {
  const headings = new Set(records.map((record) => finishReply(`*${record.label}*`)));
  return text
    .split('\n')
    .filter((line) => !headings.has(line.trim()))
    .join('\n');
}
const date = (value: unknown, includeTime: boolean) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return 'Not recorded';
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      ...(includeTime
        ? {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23' as const,
          }
        : {}),
    }).format(new Date(value)) + (includeTime ? ' IST' : '')
  );
};

export function renderAnswer(
  content: AnswerContent,
  evidence: readonly ToolEvidence[],
): {
  text: string;
  records: RenderedCrmRecord[];
  issues: string[];
} {
  const invalid = (issue: string) => ({ text: '', records: [], issues: [issue] });
  let candidate: unknown = content;
  if (typeof content === 'string') {
    if (content.trimStart().startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && 'answer_blocks' in parsed) candidate = parsed;
      } catch {
        if (/"answer_blocks"\s*:/.test(content))
          return invalid('The CRM answer envelope is malformed. Rebuild it from current evidence.');
      }
    }
    if (typeof candidate === 'string') return { text: candidate, records: [], issues: [] };
  }
  const parsed = answerBlocksSchema.safeParse(candidate);
  if (!parsed.success) return invalid('The CRM answer envelope has invalid fields or limits.');
  const sources = new Map(nativeCrmRecords(evidence).map((row) => [row.id, row]));
  const records: RenderedCrmRecord[] = [];
  const blocks: string[] = [];
  for (const block of parsed.data.answer_blocks) {
    if (block.kind === 'text') {
      blocks.push(block.text);
      continue;
    }
    const source = sources.get(block.record_id);
    if (!source)
      return invalid(
        'A CRM block refers to a record absent from current authorized evidence. Do not guess a replacement.',
      );
    if (/\b(?:Created|Last\s+updated)\s*[:·]/i.test(block.body.replace(/[*_]/g, '')))
      return invalid(
        'CRM block bodies must not override native date fields; the renderer owns those fields.',
      );
    const name = [source.name, source.company_name].find((v) => typeof v === 'string' && v.trim());
    const record = {
      record_id: block.record_id,
      label: typeof name === 'string' ? name.replace(/[\r\n*]+/g, ' ').trim() : 'Unnamed enquiry',
      created: date(source.source_created_at, block.include_time),
      last_updated: date(source.source_updated_at, block.include_time),
    };
    records.push(record);
    blocks.push(
      `*${record.label}*\nCreated: ${record.created} · Last updated: ${record.last_updated}\n${block.body}`.trim(),
    );
  }
  // A closing heading with nothing under it (for example "CRM timestamps (IST):") adds nothing.
  const last = parsed.data.answer_blocks.at(-1);
  if (last?.kind === 'text' && /^[^\n]{1,80}:$/.test(last.text.replace(/[*_]/g, '').trim()))
    blocks.pop();
  const text = blocks.filter(Boolean).join('\n\n');
  if (!text.trim() || text.length > 12000)
    return invalid('The rendered answer is empty or exceeds the reply limit.');
  return { text, records, issues: [] };
}
