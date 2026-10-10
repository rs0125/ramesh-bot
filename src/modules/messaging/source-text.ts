/**
 * Whether an excerpt was written by the user in a source message. Same rule as Context
 * Engine's hasSourceExcerpt (tests/fixtures/source-text-vectors.json is shared): layout,
 * letter case, Unicode composition and curly quotes are harmless; spelling, punctuation,
 * numbers and units must match, and an excerpt never starts or ends inside a word or number.
 */
const layout = (value: string) =>
  value
    .normalize('NFC')
    .replace(/[‘’]/gu, "'")
    .replace(/[“”]/gu, '"')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();

export function containsUserText(source: string, excerpt: string): boolean {
  const full = layout(source);
  const part = layout(excerpt);
  if (!part) return false;
  for (let start = full.indexOf(part); start !== -1; start = full.indexOf(part, start + 1)) {
    const before = full.slice(0, start);
    const after = full.slice(start + part.length);
    if (/[\p{L}\p{N}_]$/u.test(before) && /^[\p{L}\p{N}_]/u.test(part)) continue;
    if (/[\p{L}\p{N}_]$/u.test(part) && /^[\p{L}\p{N}_]/u.test(after)) continue;
    if (/\d[.,]$/.test(before) && /^\d/.test(part)) continue;
    if (/\d$/.test(part) && /^[.,]\d/.test(after)) continue;
    return true;
  }
  return false;
}
