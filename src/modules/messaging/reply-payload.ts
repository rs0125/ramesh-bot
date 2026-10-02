/** Versioned encrypted queue payload; transcript bytes never belong in the receipt journal. */
import { validVoiceReference, type VoiceReplyReference } from '../media/voice-reply.js';
import type { OutboundAutomationMedia } from '../../contracts/outbound-automation.js';

export interface OutboundMediaMetadata {
  mimeType: OutboundAutomationMedia['mimeType'];
  fileName: string;
  byteLength: number;
  sha256: string;
}
interface DecodedReply {
  text: string;
  voice?: VoiceReplyReference;
  automation?: { media?: OutboundMediaMetadata };
}

export function encodeAutomationReply(text: string, media?: OutboundMediaMetadata) {
  return { version: 3, kind: 'automation', text, ...(media ? { media } : {}) };
}
export function encodeReply(text: string, business: boolean, voice?: VoiceReplyReference) {
  if (voice) return { version: 2, kind: business ? 'business' : 'conversation', text, voice };
  return business ? { version: 1, kind: 'business', text } : text;
}
export function decodeReply(value: unknown, kind: 'business' | 'conversation'): DecodedReply {
  if (kind === 'conversation' && typeof value === 'string') return { text: value };
  if (!value || typeof value !== 'object') throw new Error('INVALID_REPLY_PAYLOAD');
  const v = value as {
    version?: number;
    kind?: string;
    text?: unknown;
    voice?: unknown;
    media?: unknown;
  };
  if (v.version === 3) {
    if (
      kind !== 'conversation' ||
      v.kind !== 'automation' ||
      typeof v.text !== 'string' ||
      v.voice !== undefined ||
      Object.keys(v).some((key) => !['version', 'kind', 'text', 'media'].includes(key))
    )
      throw new Error('INVALID_REPLY_PAYLOAD');
    if (v.media !== undefined) {
      const media = v.media as OutboundMediaMetadata;
      if (
        !media ||
        typeof media !== 'object' ||
        Array.isArray(media) ||
        !['image/jpeg', 'image/png', 'application/pdf'].includes(media.mimeType) ||
        typeof media.fileName !== 'string' ||
        !media.fileName ||
        media.fileName.length > 255 ||
        /[\\/\x00-\x1f\x7f]/.test(media.fileName) ||
        !Number.isSafeInteger(media.byteLength) ||
        media.byteLength < 1 ||
        media.byteLength > 8 * 1024 * 1024 ||
        typeof media.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(media.sha256) ||
        Object.keys(media).some(
          (key) => !['mimeType', 'fileName', 'byteLength', 'sha256'].includes(key),
        )
      )
        throw new Error('INVALID_REPLY_PAYLOAD');
    }
    if (
      v.text.length >
        (v.media && (v.media as OutboundMediaMetadata).mimeType !== 'application/pdf'
          ? 1024
          : 4000) ||
      (!v.text.trim() && !v.media)
    )
      throw new Error('INVALID_REPLY_PAYLOAD');
    return {
      text: v.text,
      automation: { ...(v.media ? { media: v.media as OutboundMediaMetadata } : {}) },
    };
  }
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
