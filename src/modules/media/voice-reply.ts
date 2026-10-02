/** Transcripts are a delivery projection of expiring media, never model-generated text. */
import { MAX_MEDIA_ITEMS, type MediaStore } from './media.types.js';
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
  if (!reference) return { text: responseText, responseText, transcripts: [] };
  if (!validVoiceReference(reference)) throw new Error('INVALID_VOICE_REFERENCE');
  const rows = store ? await store.get(reference.owner, reference.ids) : [];
  // Leave room for numbered labels and explicit failure/excerpt notices within the transport bound.
  const perNote = Math.max(
    0,
    Math.floor(
      (16000 - responseText.length - 120 * reference.ids.length - 2) / reference.ids.length,
    ),
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
  if (text.length > 16000) throw new Error('VOICE_REPLY_SIZE_LIMIT');
  return { text, responseText, transcripts };
}
