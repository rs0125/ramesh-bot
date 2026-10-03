/** Minimal original-message snapshot, captured by the scheduler from trusted transport storage. */
export type ReminderSourceQuote = {
  chatId: string;
  messageId: string;
} & (
  | { kind: 'text'; text: string }
  | { kind: 'audio'; text?: never }
  | { kind: 'image' | 'video' | 'document'; text?: string }
);

export function validReminderSourceQuote(value: unknown): value is ReminderSourceQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const quote = value as Record<string, unknown>;
  return (
    Object.keys(quote).every((key) => ['chatId', 'messageId', 'kind', 'text'].includes(key)) &&
    typeof quote.chatId === 'string' &&
    /^[1-9]\d{0,19}@(s\.whatsapp\.net|lid)$/.test(quote.chatId) &&
    typeof quote.messageId === 'string' &&
    quote.messageId.length > 0 &&
    quote.messageId.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(quote.messageId) &&
    ((quote.kind === 'text' &&
      typeof quote.text === 'string' &&
      quote.text.trim().length > 0 &&
      quote.text.length <= 32000) ||
      (quote.kind === 'audio' && quote.text === undefined) ||
      (['image', 'video', 'document'].includes(quote.kind as string) &&
        (quote.text === undefined ||
          (typeof quote.text === 'string' && quote.text.length <= 32000))))
  );
}
