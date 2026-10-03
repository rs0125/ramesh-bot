/** Transcripts are a delivery projection of expiring media, never model-generated text. */
import { MAX_MEDIA_ITEMS, type MediaStore } from './media.types.js';

/** Answer/storage limit. Delivery may add a separately bounded voice projection. */
export const MAX_REPLY_CHARACTERS = 16000;
export const MAX_VOICE_PREFIX_RESERVE = 2048;
export const MAX_VOICE_REPLY_CHARACTERS = MAX_REPLY_CHARACTERS + MAX_VOICE_PREFIX_RESERVE;
const VOICE_LABEL_ALLOWANCE = 120;
const MIN_TRANSCRIPT_EXCERPT = 128;
export interface VoiceReplyReference {
  owner: string;
  ids: string[];
}
export interface VoiceTranscript {
  text?: string;
  excerpt?: boolean;
}
export function validVoiceReference(value: unknown): value is VoiceReplyReference {
  if (!value || typeof value !== 'object') return false;
  const v = value as VoiceReplyReference;
  return (
    /^[a-f0-9]{64}$/.test(v.owner) &&
    Array.isArray(v.ids) &&
    v.ids.length > 0 &&
    v.ids.length <= MAX_MEDIA_ITEMS &&
    new Set(v.ids).size === v.ids.length &&
    v.ids.every((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id))
  );
}
function prefix(items: VoiceTranscript[]) {
  return items
    .map((item, index) => {
      const label = items.length > 1 ? `Voice note ${index + 1}\n` : '';
      if (item.text === undefined) return `${label}Voice transcript unavailable or expired.`;
      return `${label}${item.excerpt ? 'Transcript excerpt (message limit):\n' : ''}_"${item.text}"_`;
    })
    .join('\n\n');
}
export async function renderVoiceReply(
  responseText: string,
  reference?: VoiceReplyReference,
  store?: MediaStore,
): Promise<{ text: string; responseText: string; transcripts: VoiceTranscript[] }> {
  if (typeof responseText !== 'string' || responseText.length > MAX_REPLY_CHARACTERS)
    throw new Error('INVALID_REPLY_SIZE');
  if (!reference) return { text: responseText, responseText, transcripts: [] };
  if (!validVoiceReference(reference)) throw new Error('INVALID_VOICE_REFERENCE');
  const rows = store ? await store.get(reference.owner, reference.ids) : [];
  // Normally keep the complete projection within the existing answer limit. An exact
  // receipt/proposal can already occupy that limit, so reserve a small independent
  // envelope for labels and a useful excerpt. Never truncate the authoritative answer
  // or retry an immutable answer that cannot fit its own transcript prefix.
  const prefixBudget = Math.max(
    MAX_REPLY_CHARACTERS - responseText.length,
    Math.min(
      MAX_VOICE_PREFIX_RESERVE,
      (VOICE_LABEL_ALLOWANCE + MIN_TRANSCRIPT_EXCERPT) * reference.ids.length + 2,
    ),
  );
  const perNote = Math.floor(
    (prefixBudget - VOICE_LABEL_ALLOWANCE * reference.ids.length - 2) / reference.ids.length,
  );
  const transcripts = reference.ids.map((id): VoiceTranscript => {
    const row = rows.find((r) => r.id === id);
    if (!row || row.kind !== 'audio' || row.state !== 'ready' || !row.text) return {};
    let text = row.text.slice(0, perNote);
    // Avoid leaving a dangling surrogate in a clipped Unicode transcript.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return { text, ...(row.truncated || text.length < row.text.length ? { excerpt: true } : {}) };
  });
  const text = `${prefix(transcripts)}\n\n${responseText}`;
  if (text.length > MAX_VOICE_REPLY_CHARACTERS) throw new Error('VOICE_REPLY_SIZE_LIMIT');
  return { text, responseText, transcripts };
}
