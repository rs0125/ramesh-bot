/** Structured, per-turn grading: a later success cannot erase an earlier failure. */
import { z } from 'zod';
export const CRITERIA = ['continuity', 'grounded', 'formatting', 'usefulness'] as const;
const criterion = z.enum(CRITERIA);
export const verdictSchema = z
  .object({
    turns: z
      .array(
        z
          .object({
            turn: z.number().int().positive(),
            continuity: z.boolean(),
            grounded: z.boolean(),
            formatting: z.boolean(),
            usefulness: z.boolean(),
            findings: z
              .array(
                z
                  .object({
                    criterion,
                    claim: z.string().min(1).max(600),
                    evidence: z.string().min(1).max(1000),
                  })
                  .strict(),
              )
              .max(8),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export function parseVerdict(text: string, turnCount: number) {
  const parsed = verdictSchema.parse(JSON.parse(text));
  if (
    parsed.turns.length !== turnCount ||
    new Set(parsed.turns.map((t) => t.turn)).size !== turnCount ||
    parsed.turns.some((t) => t.turn < 1 || t.turn > turnCount)
  )
    throw new Error('INVALID_JUDGE_TURNS');
  for (const turn of parsed.turns) {
    for (const key of CRITERIA) {
      const found = turn.findings.some((f) => f.criterion === key);
      if (found === turn[key]) throw new Error('INVALID_JUDGE_FINDINGS');
    }
  }
  return {
    ...(Object.fromEntries(
      CRITERIA.map((key) => [key, parsed.turns.every((t) => t[key])]),
    ) as Record<(typeof CRITERIA)[number], boolean>),
    turns: parsed.turns.sort((a, b) => a.turn - b.turn),
    reasons: parsed.turns.flatMap((t) =>
      t.findings.map((f) => `Turn ${t.turn} ${f.criterion}: ${f.claim} Evidence: ${f.evidence}`),
    ),
  };
}

/** Display converted instants as deterministic judge context, never reinterpret a source's calendar. */
export function evidenceClocks(evidence: unknown) {
  const times = new Set<string>();
  const visit = (value: unknown) => {
    if (
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value))
    )
      times.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(evidence);
  const format = (instant: string, timezone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'long',
      hourCycle: 'h23',
    }).format(new Date(instant));
  return [...times].slice(0, 80).map((instant) => ({
    instant,
    utc: format(instant, 'UTC'),
    ist: format(instant, 'Asia/Kolkata'),
  }));
}
