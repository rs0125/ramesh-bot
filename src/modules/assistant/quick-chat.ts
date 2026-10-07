/** Exact social turns only. Agreement, selections and retry/undo commands need normal context. */
export function quickChatReply(input: string): string | undefined {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/[!.]+$/, '')
    .trim();
  if (['hi', 'hello', 'hey', 'hi ramesh', 'hello ramesh', 'hey ramesh', 'namaste'].includes(text))
    return 'Hi! How can I help?';
  if (['thanks', 'thank you', 'thanks ramesh', 'thank you ramesh', 'shukriya'].includes(text))
    return "You're welcome.";
  return undefined;
}
