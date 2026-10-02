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
  return (
    text
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

/** Mechanical chat layout checks belong in code, independently of semantic model review. */
export function chatLayoutIssues(text: string): string[] {
  return [
    ...STOCK_PHRASES.filter((phrase) => phrase.test(text)).map(
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
