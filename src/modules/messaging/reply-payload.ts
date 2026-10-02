/** Versioned encrypted queue payload; transcript bytes never belong in the receipt journal. */
import { validVoiceReference, type VoiceReplyReference } from '../media/voice-reply.js';
export function encodeReply(text: string, business: boolean, voice?: VoiceReplyReference) {
  if (voice) return { version: 2, kind: business ? 'business' : 'conversation', text, voice };
  return business ? { version: 1, kind: 'business', text } : text;
}
export function decodeReply(value: unknown, kind: 'business' | 'conversation') {
  if (kind === 'conversation' && typeof value === 'string') return { text: value };
  if (!value || typeof value !== 'object') throw new Error('INVALID_REPLY_PAYLOAD');
  const v = value as { version?: number; kind?: string; text?: unknown; voice?: unknown };
  if (
    v.kind !== kind ||
    typeof v.text !== 'string' ||
    (v.version !== 1 && v.version !== 2) ||
    (v.version === 1 && (kind !== 'business' || v.voice !== undefined)) ||
    (v.voice !== undefined && !validVoiceReference(v.voice))
  )
    throw new Error('INVALID_REPLY_PAYLOAD');
  return { text: v.text, ...(v.voice ? { voice: v.voice as VoiceReplyReference } : {}) };
}
