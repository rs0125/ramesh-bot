/** Presentation metadata comes from native CRM fields, never mirror ingestion clocks. */
import type { ToolEvidence } from './tool-evidence.js';
import { internalCrmReferences, nativeCrmRecords } from './record-identity.js';
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});
function date(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? dateFormat.format(new Date(value))
    : 'Not recorded';
}
export function dealDisplayFacts(evidence: readonly ToolEvidence[]) {
  return nativeCrmRecords(evidence).map((row) => ({
    internal_id: row.id,
    label: row.company_name || row.name || 'Unnamed enquiry',
    created: date(row.source_created_at),
    last_updated: date(row.source_updated_at),
  }));
}
/** Recognize unambiguous record entries, including compact due-date/name bullets.
 * Never infer identity from a shortened/duplicate name or turn a task/draft into a card. */
function recordBlocks(reply: string, evidence: readonly ToolEvidence[]) {
  const facts = dealDisplayFacts(evidence);
  const unique = facts.filter(
    (row) =>
      row.label !== 'Unnamed enquiry' &&
      facts.filter((other) => String(other.label).toLowerCase() === String(row.label).toLowerCase())
        .length === 1,
  );
  const labels = unique.map((row) => ({
    row,
    pattern: new RegExp(
      `(?<![\\p{L}\\p{N}])${String(row.label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
      'iu',
    ),
  }));
  const lines = reply.split('\n');
  const entries: Array<{ index: number; row: (typeof facts)[number] }> = [];
  let draftSection = false;
  for (const [index, line] of lines.entries()) {
    const plain = line.replace(/[*_]/g, '').trim();
    if (/^(?:#{1,6}\s*)?(?:message\s+)?draft\b/i.test(plain)) draftSection = true;
    else if (/^#{1,6}\s+/.test(plain)) draftSection = false;
    if (draftSection || /^>/.test(plain)) continue;
    const body = plain.replace(/^(?:[-•]\s+|\d+[.)]\s+|#{1,6}\s+)/, '');
    if (
      /^(?:contact|call|email|ask|check|draft|review|confirm|prepare|schedule|complete|follow\s*up|send)\b/i.test(
        body,
      )
    )
      continue;
    const matches = labels.filter(({ pattern }) => pattern.test(plain));
    if (matches.length !== 1) continue;
    const { row } = matches[0]!;
    const isList = /^\s*(?:[-*•]\s+|\d+[.)]\s+|#{1,6}\s+)/.test(line);
    const isHeading =
      body.replace(/:$/, '').trim().toLowerCase() === String(row.label).toLowerCase();
    if (isList || isHeading) entries.push({ index, row });
  }
  return {
    lines,
    entries: entries.map((entry, index) => ({
      ...entry,
      body: lines.slice(entry.index, entries[index + 1]?.index ?? lines.length).join('\n'),
    })),
  };
}
function displayedDate(body: string, field: string) {
  return new RegExp(
    `\\b${field}\\s*[:·]\\s*([^\\n·•|;]*?)(?=\\bLast updated\\s*[:·]|\\.\\s+(?=[A-Za-z])|\\n|[·•|;]|$)`,
    'i',
  )
    .exec(body.replace(/[*_]/g, ''))?.[1]
    ?.trim()
    .replace(/[,.;]$/, '')
    .trim();
}
function sameDate(value: string, expected: string) {
  if (expected === 'Not recorded') return value.toLowerCase() === 'not recorded';
  // These are calendar labels, not instants. ISO date-only strings parse as UTC,
  // while human labels otherwise inherit the host timezone.
  const actual = Date.parse(`${value.replace(/\s*(?:\(IST\)|IST)$/i, '')} UTC`);
  return Number.isFinite(actual) && actual === Date.parse(`${expected} UTC`);
}
/** Add only missing metadata from validated native fields; never manufacture or overwrite a fact. */
export function withDealDates(reply: string, evidence: readonly ToolEvidence[]) {
  const { lines, entries } = recordBlocks(reply, evidence);
  for (const { index, row, body } of entries.reverse()) {
    const missing = [
      ...(!displayedDate(body, 'Created') ? [`Created: ${row.created}`] : []),
      ...(!displayedDate(body, 'Last updated') ? [`Last updated: ${row.last_updated}`] : []),
    ];
    if (missing.length) lines.splice(index + 1, 0, missing.join(' · '));
  }
  return lines.join('\n');
}
export function dealDisplayIssues(
  reply: string,
  evidence: readonly ToolEvidence[],
  knownInternalIds: Iterable<string> = [],
) {
  const issues: string[] = [];
  const internalIds = new Set([...knownInternalIds, ...internalCrmReferences(evidence)]);
  const shown = reply.toLowerCase();
  if ([...internalIds].some((id) => id.length > 0 && shown.includes(id.toLowerCase())))
    issues.push(
      'Remove internal deal UUIDs and API paths; use company/requirement labels. Keep warehouse IDs.',
    );
  for (const { row, body } of recordBlocks(reply, evidence).entries) {
    for (const [field, expected] of [
      ['Created', row.created],
      ['Last updated', row.last_updated],
    ]) {
      const shown = displayedDate(body, field!);
      if (!shown || !sameDate(shown, expected!))
        issues.push(`For ${row.label}, use ${field}: ${expected} from native CRM dates.`);
    }
  }
  return issues;
}
