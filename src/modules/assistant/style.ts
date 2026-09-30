/** Final punctuation guard plus shared, transparent style checks for live evaluations. */
export const STOCK_PHRASES = [
  /\bgreat question\b/i,
  /\bcertainly\b/i,
  /\bas an ai(?: language model)?\b/i,
  /\bi['’]d be happy to\b/i,
  /\bdelve\b/i,
  /\bleverage\b/i,
  /\bit['’]s worth noting\b/i,
  /\bfeel free to\b/i,
  /\blet me know if you (?:need|have)\b/i,
];

export function finishReply(text: string): string {
  return text
    .replace(/[\u2012-\u2015]/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([,.!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function styleViolations(text: string): string[] {
  return [
    ...(/[\u2014\u2015]/.test(text) ? ['em_dash'] : []),
    ...(!text.trim() ? ['empty_reply'] : []),
    ...(text.length > 4000 ? ['reply_too_long'] : []),
    ...STOCK_PHRASES.filter((phrase) => phrase.test(text)).map(
      (phrase) => `stock_phrase:${phrase.source}`,
    ),
  ];
}
