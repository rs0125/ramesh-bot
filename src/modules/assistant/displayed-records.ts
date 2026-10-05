/** Persist displayed identities separately from mutable search pages and historical prose. */
import type { ToolEvidence } from './tool-evidence.js';

export interface DisplayedWarehouseRecord {
  kind: 'warehouse';
  id: number;
  position: number;
  /** Stable local list identity; positions are relative to this displayed group. */
  group?: string;
  /** Source-backed reference only. Recall must authorize it before returning it. */
  subject?: { kind: 'crm_lead'; id: string };
}

/** Only entity IDs in successful accepted warehouse evidence establish a reference. */
export function warehouseEvidenceIds(evidence: readonly ToolEvidence[]): Set<number> {
  const ids = new Set<number>();
  for (const entry of evidence) {
    const rows =
      entry.tool === 'search_warehouses'
        ? entry.result.data.items
        : entry.tool === 'read_warehouse'
          ? [entry.result.data]
          : entry.tool === 'assess_shortlist'
            ? entry.result.data.candidates
            : [];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const id = row && typeof row === 'object' && !Array.isArray(row) ? row.id : undefined;
      if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 2147483647)
        ids.add(id);
    }
  }
  return ids;
}

/** Legacy labels identify lookup targets, never authority; callers must freshly authorize every ID. */
export function displayedWarehouseLabels(reply: string): DisplayedWarehouseRecord[] {
  const selected = new Map<string, DisplayedWarehouseRecord>();
  // Explicit ID labels only: arbitrary numbers, dimensions, UUID prefixes, source text,
  // and tool arguments are not displayed warehouse identities.
  const headings = [
    ...reply.matchAll(
      /^\s*[*_]{0,2}([1-9]\d{0,2})[.)][*_]{0,2}\s+[*_]{0,2}(?:warehouse\s+)?ID(?:\s*:\s*|\s+)([1-9]\d{0,9})(?![\w-]|\.\d)/gimu,
    ),
  ];
  const grouped = new Set(headings.map((match) => Number(match[1]))).size !== headings.length;
  let group = 1;
  let previous = 0;
  const matches = headings.length
    ? headings
    : [...reply.matchAll(/\bID(?:\s*:\s*|\s+)([1-9]\d{0,9})(?![\w-]|\.\d)/giu)];
  for (const match of matches) {
    const id = Number(match[headings.length ? 2 : 1]);
    const position = headings.length ? Number(match[1]) : selected.size + 1;
    if (grouped && position <= previous) group++;
    previous = position;
    const key = `${group}:${id}`;
    if (id <= 2147483647 && position <= 100 && !selected.has(key))
      selected.set(key, {
        kind: 'warehouse',
        id,
        position,
        ...(grouped ? { group: `group-${group}` } : {}),
      });
    if (selected.size >= 100) break;
  }
  return [...selected.values()];
}

/** Failed legacy references leave ordinal gaps; fresh visibility never renumbers history. */
export function displayedWarehousePositions(reply: string, evidence: readonly ToolEvidence[]) {
  const permitted = warehouseEvidenceIds(evidence);
  return displayedWarehouseLabels(reply).filter((record) => permitted.has(record.id));
}

export function displayedWarehouseRecords(
  reply: string,
  evidence: readonly ToolEvidence[],
): DisplayedWarehouseRecord[] {
  const records = displayedWarehousePositions(reply, evidence);
  const subjects = new Map<string, { id: string; labels: Set<string> }>();
  for (const entry of evidence) {
    const data = entry.result.data;
    const rows =
      entry.tool === 'search_crm_leads' || entry.tool === 'crm_briefing'
        ? (data.items ?? data.priorities)
        : entry.tool === 'read_crm_lead'
          ? [data]
          : entry.tool === 'assess_shortlist' && data.lead && data.requirement_context
            ? [{ ...(data.requirement_context as object), ...(data.lead as object) }]
            : [];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        typeof row.id !== 'string' ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(row.id)
      )
        continue;
      const subject = subjects.get(row.id) ?? { id: row.id, labels: new Set<string>() };
      for (const label of [row.name, row.company_name])
        if (typeof label === 'string' && label.trim())
          subject.labels.add(label.trim().toLocaleLowerCase());
      subjects.set(row.id, subject);
    }
  }
  // A heading can bind a group only when it names exactly one admitted CRM entity.
  // Arbitrary headings remain structural group IDs, never source facts or grants.
  const lines = reply.split('\n');
  const headings: Array<{ index: number; subject: { kind: 'crm_lead'; id: string } }> = [];
  for (const [index, line] of lines.entries()) {
    const label = line
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[*_]+|[*_:]+$/g, '')
      .trim()
      .toLocaleLowerCase();
    const matching = [...subjects.values()].filter((item) => item.labels.has(label));
    if (matching.length === 1)
      headings.push({ index, subject: { kind: 'crm_lead', id: matching[0]!.id } });
  }
  if (!headings.length) return records;
  // Bind only when the named sections account for the complete displayed lists.
  // An unmatched heading or another ordinal reset inside a section makes its
  // subject ambiguous; keep the original groups without guessing a CRM link.
  if (displayedWarehouseLabels(lines.slice(0, headings[0]!.index).join('\n')).length)
    return records;
  const sections = headings.map((heading, index) => {
    const section = lines.slice(heading.index + 1, headings[index + 1]?.index);
    const ambiguousHeading = section.some(
      (line) =>
        /^\s*(?:#{1,6}\s+.+|\*\*[^*]+\*\*\s*:?|__[^_]+__\s*:?|[^.!?:]{1,100}:)\s*$/.test(line) &&
        displayedWarehouseLabels(line).length === 0,
    );
    return {
      heading,
      ambiguousHeading,
      records: displayedWarehousePositions(section.join('\n'), evidence),
    };
  });
  if (sections.some((section) => section.ambiguousHeading || section.records.some((r) => r.group)))
    return records;
  return sections
    .flatMap((section, index) =>
      section.records.map((record) => ({
        ...record,
        ...(headings.length > 1 ? { group: `group-${index + 1}` } : {}),
        subject: section.heading.subject,
      })),
    )
    .slice(0, 100);
}
