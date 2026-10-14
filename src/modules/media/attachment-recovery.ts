/** Application-owned recovery advice, separate from untrusted extracted content. */
import type { MediaRecord } from './media.types.js';

export function attachmentRecovery(
  state: MediaRecord['state'] | 'unavailable',
  incomplete = false,
) {
  if (state === 'pending' || state === 'processing')
    return {
      action: 'wait_for_processing',
      guidance:
        'Processing must finish before content is readable. Ask the user to retry shortly; no resend is needed.',
    };
  if (state !== 'ready')
    return {
      action: 'replace_source',
      guidance: 'Resend the unavailable attachment or paste its text.',
    };
  if (incomplete)
    return {
      action: 'complete_source',
      guidance:
        'Only part of the extraction is available. Ask for the complete text or a complete replacement.',
    };
  return undefined;
}
