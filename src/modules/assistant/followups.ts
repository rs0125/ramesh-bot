/** Fixed assigned-only CRM query, evidence verification and factual rendering. No model or transport. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ContextEngineError, type ContextEvidence } from '../context-engine/context.types.js';

export const FOLLOWUPS_QUERY = Object.freeze({
  view: 'assigned',
  follow_up_status: 'today',
  sort: 'follow_up_asc',
  limit: 10,
});
const instant = z.iso.datetime({ offset: true });
const source = z.object({
  status: z.enum(['ok', 'error', 'unknown']),
  last_run_at: instant.nullable(),
});
const lead = z.object({
  id: z.uuid(),
  name: z.string().max(256).nullable(),
  stage: z.string().max(80).nullable(),
  next_follow_up: instant,
  verification_required: z.boolean(),
});
const page = z.object({
  items: z.array(lead).max(FOLLOWUPS_QUERY.limit),
  nextCursor: z.string().min(1).max(2048).nullable(),
  access_scope: z.enum(['assigned', 'all']),
  source_status: z.object({ opportunities: source }),
  activity_status: z.object({ status: z.enum(['current', 'degraded']) }),
  read_consistency: z.object({
    database_snapshot: z.literal('repeatable_read'),
    lead_fields: z.literal('same_row'),
    cross_request_snapshot: z.literal(false),
  }),
  query_context: z.object({
    as_of: instant,
    timezone: z.literal('Asia/Kolkata'),
    local_date: z.iso.date(),
    sort: z.literal('follow_up_asc'),
    returned_count: z.number().int().nonnegative(),
    has_more: z.boolean(),
    follow_up: z.object({
      status: z.literal('today'),
      timezone: z.literal('Asia/Kolkata'),
      start_at: instant,
      end_before: instant,
    }),
  }),
});

export interface FollowupsFacts {
  localDate: string;
  items: z.infer<typeof lead>[];
  hasMore: boolean;
  activityDegraded: boolean;
  retrievedAt: string;
  sourceSyncedAt: string;
  sourcePath: string;
  requestId: string;
}

export const followupsDeliverySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('assigned_followups_today'),
    employeeId: z.number().int().positive(),
    localDate: z.iso.date(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    preparedAt: instant,
    expiresAt: instant,
  })
  .strict();
export type FollowupsDelivery = z.infer<typeof followupsDeliverySchema>;
export type ReplyLanguage = 'en' | 'hi_latn' | 'hi';

export function indiaDate(now: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function verifyFollowups(evidence: ContextEvidence, now = Date.now()): FollowupsFacts {
  const invalid = () => new ContextEngineError('INVALID_RESPONSE');
  try {
    const citation = new URL(evidence.source_path, 'https://context.invalid');
    if (
      citation.origin !== 'https://context.invalid' ||
      citation.pathname !== '/api/v1/crm/opportunities'
    )
      throw invalid();
    for (const [key, value] of Object.entries(FOLLOWUPS_QUERY))
      if (citation.searchParams.get(key) !== String(value)) throw invalid();
    if (
      citation.searchParams.size !== Object.keys(FOLLOWUPS_QUERY).length ||
      citation.hash ||
      [...citation.searchParams.keys()].some((key) => !Object.hasOwn(FOLLOWUPS_QUERY, key))
    )
      throw invalid();
    const data = page.parse(evidence.data);
    const query = data.query_context;
    const start = Date.parse(`${query.local_date}T00:00:00+05:30`);
    const end = start + 86_400_000;
    const asOf = Date.parse(query.as_of);
    const generated = Date.parse(evidence.meta.generatedAt);
    const synced = data.source_status.opportunities.last_run_at;
    if (
      evidence.status !== 200 ||
      !evidence.meta.requestId ||
      query.local_date !== indiaDate(now) ||
      Math.abs(now - asOf) > 120_000 ||
      !Number.isFinite(generated) ||
      Math.abs(now - generated) > 120_000 ||
      Date.parse(query.follow_up.start_at) !== start ||
      Date.parse(query.follow_up.end_before) !== end ||
      query.returned_count !== data.items.length ||
      query.has_more !== (data.nextCursor !== null) ||
      new Set(data.items.map((item) => item.id)).size !== data.items.length ||
      data.items.some(
        (item) => Date.parse(item.next_follow_up) < start || Date.parse(item.next_follow_up) >= end,
      )
    )
      throw invalid();
    if (
      data.source_status.opportunities.status !== 'ok' ||
      !synced ||
      asOf - Date.parse(synced) > 30 * 60_000 ||
      asOf - Date.parse(synced) < -60_000
    )
      throw new ContextEngineError('UNAVAILABLE');
    return {
      localDate: query.local_date,
      items: data.items,
      hasMore: query.has_more,
      activityDegraded: data.activity_status.status === 'degraded',
      retrievedAt: evidence.meta.generatedAt,
      sourceSyncedAt: synced,
      sourcePath: evidence.source_path,
      requestId: evidence.meta.requestId,
    };
  } catch (error) {
    if (error instanceof ContextEngineError) throw error;
    throw invalid();
  }
}

export function followupsFingerprint(facts: FollowupsFacts): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        date: facts.localDate,
        items: facts.items,
        hasMore: facts.hasMore,
        activityDegraded: facts.activityDegraded,
      }),
    )
    .digest('hex');
}

export function followupsDelivery(
  employeeId: number,
  facts: FollowupsFacts,
  now: number,
): FollowupsDelivery {
  const end = Date.parse(`${facts.localDate}T00:00:00+05:30`) + 86_400_000;
  return {
    version: 1,
    kind: 'assigned_followups_today',
    employeeId,
    localDate: facts.localDate,
    fingerprint: followupsFingerprint(facts),
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(now + 300_000, end)).toISOString(),
  };
}

const label = (value: string) =>
  value
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

export function renderFollowups(facts: FollowupsFacts, language: ReplyLanguage): string {
  const count = facts.items.length;
  const intro =
    language === 'hi_latn'
      ? count
        ? `Aaj (${facts.localDate}, IST) aapke assigned follow-ups:`
        : `Aaj (${facts.localDate}, IST) ke liye koi assigned follow-up nahi mila.`
      : language === 'hi'
        ? count
          ? `आज (${facts.localDate}, IST) आपके असाइन किए गए फ़ॉलो-अप:`
          : `आज (${facts.localDate}, IST) के लिए कोई असाइन किया गया फ़ॉलो-अप नहीं मिला।`
        : count
          ? `Your assigned follow-ups for today (${facts.localDate}, IST):`
          : `No assigned follow-ups found for today (${facts.localDate}, IST).`;
  const lines = facts.items.map(
    (item, index) =>
      `${index + 1}. ${label(item.name ?? 'Unnamed lead')} (${item.id})${item.stage ? `, ${label(item.stage)}` : ''}${item.verification_required ? ' *' : ''}`,
  );
  if (facts.hasMore)
    lines.push(
      language === 'en'
        ? `Showing the first ${count} results; more exist. This isn't the full list.`
        : language === 'hi_latn'
          ? `Pehle ${count} results dikh rahe hain; aur bhi hain. Yeh poori list nahi hai.`
          : `पहले ${count} नतीजे दिख रहे हैं; और भी हैं। यह पूरी सूची नहीं है।`,
    );
  if (facts.items.some((item) => item.verification_required))
    lines.push(
      language === 'en'
        ? '* Some recorded lead details need verification.'
        : language === 'hi_latn'
          ? '* In leads ki kuch recorded details verify karni hain.'
          : '* इन लीड्स की कुछ दर्ज जानकारी की पुष्टि करनी है।',
    );
  if (facts.activityDegraded)
    lines.push(
      language === 'en'
        ? 'Recent notes or tasks may be incomplete; this list uses the recorded follow-up dates.'
        : language === 'hi_latn'
          ? 'Recent notes ya tasks adhure ho sakte hain; list recorded follow-up dates par based hai.'
          : 'हाल के नोट्स या टास्क अधूरे हो सकते हैं; सूची दर्ज फ़ॉलो-अप तारीखों पर आधारित है।',
    );
  return [intro, ...lines].join('\n');
}
