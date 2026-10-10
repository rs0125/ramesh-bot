/** Final WhatsApp formatting/punctuation guards and shared style checks. */
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

/** WhatsApp bold uses one asterisk per side. Leave literal code/URLs alone and
 * do not guess at unmatched markers, escaped text or arithmetic expressions.
 * Apply only to generated answer text, before exact voice transcripts are added.
 */
export function whatsappBold(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|``[^\n]*?``|`[^`\n]*`|(?:https?:\/\/|www\.)[^\s]+)/gi)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            /(?<![\p{L}\p{N}_*\\])\*\*([^\s*](?:[^*\n]*[^\s*])?)(?<!\\)\*\*(?![\p{L}\p{N}_*])/gu,
            '*$1*',
          ),
    )
    .join('');
}

export function finishReply(text: string): string {
  return (
    whatsappBold(text)
      // En/figure dashes normally denote ranges, including 25 Sep–1 Oct and 9 am–5 pm.
      .replace(/[\u2012\u2013]/g, '-')
      .replace(/(?<=\d)\s*[\u2014\u2015]\s*(?=\d)/g, '-')
      .replace(/[\u2012-\u2015]/g, ', ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ +([,.!?])/g, '$1')
      .replace(/,\s*,/g, ',')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export function styleViolations(text: string, maximumCharacters = 4000): string[] {
  return [
    ...(/[\u2014\u2015]/.test(text) ? ['em_dash'] : []),
    ...(!text.trim() ? ['empty_reply'] : []),
    ...(text.length > maximumCharacters ? ['reply_too_long'] : []),
    ...STOCK_PHRASES.filter((phrase) => phrase.test(text)).map(
      (phrase) => `stock_phrase:${phrase.source}`,
    ),
  ];
}

/**
 * Quoted material is the user's or a source's wording, not generated phrasing: a CRM note
 * that says "leverage" is data. Remove quotes, italic transcripts and quote blocks before
 * the stock-phrase check. Layout checks still see the full text.
 */
export function withoutQuotedText(text: string): string {
  return text
    .replace(/^>.*$/gm, '')
    .replace(/"[^"\n]{1,500}"/g, '""')
    .replace(/“[^”\n]{1,500}”/g, '“”')
    .replace(/(?<![\p{L}\p{N}_])_[^_\n]{1,500}_(?![\p{L}\p{N}_])/gu, '__');
}

/** Mechanical chat layout checks belong in code, independently of semantic model review. */
export function chatLayoutIssues(text: string): string[] {
  const generated = withoutQuotedText(text);
  return [
    ...STOCK_PHRASES.filter((phrase) => phrase.test(generated)).map(
      (phrase) =>
        `Rephrase the stock wording matching ${phrase.source} naturally while preserving its facts.`,
    ),
    ...(/^\s*\|.*\|\s*$/m.test(text)
      ? [
          'Replace the table with short labelled bullets. No tables, including narrow tables, in a WhatsApp reply.',
        ]
      : []),
    ...(/```/.test(text)
      ? ['Remove code fences and present the answer as ordinary chat text.']
      : []),
  ];
}
