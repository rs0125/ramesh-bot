/** Inspect privacy wrappers before SDK normalization removes their provenance. */
import { normalizeMessageContent, type WAMessage } from '@whiskeysockets/baileys';

const containers = [
  'ephemeralMessage',
  'documentWithCaptionMessage',
  'editedMessage',
  'associatedChildMessage',
  'groupStatusMessage',
  'groupStatusMessageV2',
] as const;

export function persistableMessageContent(content: WAMessage['message']) {
  let current = content;
  // Baileys normalizes at most five wrappers. Extra depth is rejected rather than
  // silently trusting malformed/cyclic input or a future unbounded wrapper chain.
  for (let depth = 0; depth < 8; depth++) {
    if (
      current?.viewOnceMessage ||
      current?.viewOnceMessageV2 ||
      current?.viewOnceMessageV2Extension ||
      current?.imageMessage?.viewOnce === true ||
      current?.audioMessage?.viewOnce === true ||
      current?.videoMessage?.viewOnce === true ||
      current?.extendedTextMessage?.viewOnce === true
    )
      throw new Error('VIEW_ONCE_MEDIA_UNSUPPORTED');
    const container = containers.map((name) => current?.[name]).find(Boolean);
    if (!container) return normalizeMessageContent(content);
    current = container.message;
  }
  throw new Error('MESSAGE_WRAPPER_DEPTH_EXCEEDED');
}
