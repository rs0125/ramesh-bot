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
/** Best-effort validation of dates claimed in legacy prose. Never insert facts or
 * require missing display metadata here. Structured cards render by record ID. */
function recordBlocks(reply: string, evidence: readonly ToolEvidence[]) {
  const facts = dealDisplayFacts(evidence);
  const records = new Map(nativeCrmRecords(evidence).map((row) => [row.id, row]));
  const aliases = facts.map((row) => ({
    row,
    names: [
      ...new Set(
        [row.label, records.get(row.internal_id)?.name]
          .filter(
            (label): label is string =>
              typeof label === 'string' && !!label.trim() && label !== 'Unnamed enquiry',
          )
          .map((label) => label.trim()),
      ),
    ],
  }));
  // A full unique requirement name is as precise as a unique company label.
  // Duplicate company names cannot bind dates across separate enquiries.
  const labels = aliases
    .map(({ row, names }) => ({
      row,
      names: names.filter(
        (name) =>
          aliases.filter((other) =>
            other.names.some((label) => label.toLowerCase() === name.toLowerCase()),
          ).length === 1,
      ),
    }))
    .map(({ row, names }) => ({
      row,
      names,
      patterns: names.map(
        (name) =>
          new RegExp(
            `(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
            'iu',
          ),
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
    const body = plain.replace(/^(?:#{1,6}\s+)?(?:[-•]\s+|\d+[.)]\s+)?/, '');
    if (
      /^(?:contact|call|email|ask|check|draft|review|confirm|prepare|schedule|complete|follow\s*up|send)\b/i.test(
        body,
      )
    )
      continue;
    const matches = labels.filter(({ patterns }) =>
      patterns.some((pattern) => pattern.test(plain)),
    );
    if (matches.length !== 1) continue;
    const { row, names, patterns } = matches[0]!;
    const isList = /^\s*(?:[-*•]\s+|\d+[.)]\s+|#{1,6}\s+)/.test(line);
    // A client mentioned inside a warehouse caveat is not a CRM record entry.
    // Admit a label at the start, after an explicit record field, or after a due date.
    const startsWithRecord = patterns.some((pattern) => {
      const match = pattern.exec(body);
      if (!match) return false;
      const prefix = body
        .slice(0, match.index)
        .trim()
        .replace(/[“‘"']$/, '')
        .trim();
      return (
        !prefix ||
        /^(?:(?:CRM\s+)?(?:lead|deal)|client|company|RFQ|requirement)\s*[:·]$/i.test(prefix) ||
        /^(?:\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:\s+\d{4})?|\d{4}-\d{2}-\d{2})\s*[:·|–-]$/i.test(
          prefix,
        )
      );
    });
    const isHeading = names.some(
      (name) =>
        body
          .replace(/^(?:(?:CRM\s+)?(?:lead|deal)|client|company|RFQ|requirement)\s*[:·]\s*/i, '')
          .replace(/:$/, '')
          .trim()
          .replace(/^[“”‘’"']|[“”‘’"']$/g, '')
          .trim()
          .toLowerCase() === name.toLowerCase(),
    );
    if ((isList && startsWithRecord) || isHeading) entries.push({ index, row });
  }
  const metadataLine = (line: string) =>
    /^(?:[-•]\s+|\d+[.)]\s+)?(?:Created|Last updated)\s*[:·]/i.test(
      line.replace(/[*_]/g, '').trim(),
    );
  const sectionHeading = (line: string) =>
    !metadataLine(line) &&
    (/^\s*(?:#{1,6}\s+|\d+[.)]\s+)/.test(line) ||
      /^\s*(?:\*{1,2}[^*]+\*{1,2}|_{1,2}[^_]+_{1,2})\s*$/.test(line));
  return {
    lines,
    entries: entries.map((entry, index) => {
      let end = entries[index + 1]?.index ?? lines.length;
      // Legacy prose does not carry record IDs or block boundaries. Never bind a
      // date from another section/paragraph to the last mentioned CRM company.
      // Blank space immediately before explicit date metadata still belongs to
      // this record; ambiguous distant dates remain for evidence-based review.
      for (let cursor = entry.index + 1; cursor < end; cursor++) {
        const line = lines[cursor]!;
        if (sectionHeading(line)) {
          end = cursor;
          break;
        }
        if (!line.trim()) {
          const next = lines.slice(cursor + 1, end).find((value) => value.trim());
          if (!next || !metadataLine(next)) {
            end = cursor;
            break;
          }
        }
      }
      return { ...entry, body: lines.slice(entry.index, end).join('\n') };
    }),
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
function sameDate(value: string, expected: string, nativeInstant?: unknown): boolean {
  if (expected === 'Not recorded') return value.toLowerCase() === 'not recorded';
  // A correct native time is useful detail, not a date-format violation. Validate
  // the supplied IST time against this record's timestamp, at its shown precision.
  const timed =
    /^(.*?)[,\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(am|pm)?\s*(?:IST|\(IST\))$/i.exec(
      value,
    );
  if (timed) {
    const [, day, hour, minute, second, fraction, period] = timed;
    let hours = Number(hour);
    if (
      !sameDate(day!, expected) ||
      hours > (period ? 12 : 23) ||
      (period && hours < 1) ||
      Number(minute) > 59 ||
      Number(second ?? 0) > 59 ||
      typeof nativeInstant !== 'string'
    )
      return false;
    if (period) hours = (hours % 12) + (period.toLowerCase() === 'pm' ? 12 : 0);
    const actual = Date.parse(
      `${day} ${hours}:${minute}:${second ?? '00'}${fraction ? `.${fraction}` : ''} +05:30`,
    );
    const recorded = Date.parse(nativeInstant);
    const precision = fraction ? 10 ** (3 - fraction.length) : second === undefined ? 60000 : 1000;
    return (
      Number.isFinite(actual) &&
      Number.isFinite(recorded) &&
      Math.floor(actual / precision) === Math.floor(recorded / precision)
    );
  }
  // These are calendar labels, not instants. ISO date-only strings parse as UTC,
  // while human labels otherwise inherit the host timezone.
  const actual = Date.parse(`${value.replace(/\s*(?:\(IST\)|IST)$/i, '')} UTC`);
  return Number.isFinite(actual) && actual === Date.parse(`${expected} UTC`);
}
export function dealDisplayIssues(
  reply: string,
  evidence: readonly ToolEvidence[],
  knownInternalIds: Iterable<string> = [],
) {
  const issues: string[] = [];
  const nativeRecords = new Map(nativeCrmRecords(evidence).map((row) => [row.id, row]));
  const internalIds = new Set([...knownInternalIds, ...internalCrmReferences(evidence)]);
  const shown = reply.toLowerCase();
  if ([...internalIds].some((id) => id.length > 0 && shown.includes(id.toLowerCase())))
    issues.push(
      'Remove internal deal UUIDs and API paths; use company/requirement labels. Keep warehouse IDs.',
    );
  for (const { row, body } of recordBlocks(reply, evidence).entries) {
    const native = nativeRecords.get(row.internal_id);
    for (const [field, expected, nativeField] of [
      ['Created', row.created, 'source_created_at'],
      ['Last updated', row.last_updated, 'source_updated_at'],
    ]) {
      const shown = displayedDate(body, field!);
      if (shown && !sameDate(shown, expected!, native?.[nativeField!]))
        issues.push(`For ${row.label}, use ${field}: ${expected} from native CRM dates.`);
    }
  }
  return issues;
}
