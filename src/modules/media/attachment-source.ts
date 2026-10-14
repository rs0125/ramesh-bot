/** Read the exact retained attachment for a message, without extracting again or widening ownership. */
import { mediaOwner } from './media.service.js';
import type { MediaRecord, MediaStore } from './media.types.js';

export type AttachmentKind = 'audio' | 'image' | 'document' | 'video';
export interface AttachmentSource {
  kind: AttachmentKind;
  state: MediaRecord['state'] | 'unavailable';
  text?: string;
  truncated?: true;
  expiresAt?: number;
}
export function attachmentKind(kind: string): AttachmentKind | undefined {
  return ['audio', 'image', 'document', 'video'].includes(kind)
    ? (kind as AttachmentKind)
    : undefined;
}
export async function readAttachmentSource(
  store: Pick<MediaStore, 'findSource' | 'get'>,
  source: { accountId: string; chatId: string; senderId: string; messageId: string; kind: string },
): Promise<AttachmentSource | undefined> {
  const kind = attachmentKind(source.kind);
  if (!kind) return undefined;
  const unavailable: AttachmentSource = { kind, state: 'unavailable' };
  const owner = mediaOwner(source.accountId, source.chatId, source.senderId);
  const id = await store.findSource?.(owner, source.messageId);
  if (!id) return unavailable;
  const record = (await store.get(owner, [id])).find(
    (item) =>
      item.id === id &&
      item.owner === owner &&
      item.source === source.messageId &&
      item.expiresAt.getTime() > Date.now() &&
      (item.kind === kind || (!item.kind && ['pending', 'processing'].includes(item.state))),
  );
  if (!record) return unavailable;
  return {
    kind,
    state: record.state,
    expiresAt: record.expiresAt.getTime(),
    ...(record.state === 'ready' && record.text !== undefined ? { text: record.text } : {}),
    ...(record.truncated ? { truncated: true } : {}),
  };
}
