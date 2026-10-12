/** Exact STT input retained with its original message, independently of expiring audio. */
export interface VoiceInput {
  version: 1;
  echo?: { state: 'SENDING' | 'SENT' | 'UNCERTAIN'; at: string };
}

/** Split only the presentation, preserving every character of the saved/model input. */
export function voiceInputReplies(text: string): string[] {
  const parts: string[] = [];
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(offset + 15000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts.map(
    (part, index) =>
      `${parts.length > 1 ? `Transcript (${index + 1}/${parts.length})\n` : ''}_"${part}"_`,
  );
}
