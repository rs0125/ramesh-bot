/** Pure eligibility rules. Time is supplied by the caller for deterministic tests. */
import type { GreetingCandidate, GreetingKey } from './greeting.types.js';

export function selectGreetingTarget(
  message: GreetingCandidate,
  now: number,
  maxMessageAgeMs: number,
): GreetingKey | null {
  if (message.fromMe || (message.isGroup && !message.mentionsBot)) return null;
  const age = now - message.sentAtMs;
  // Small forward clock skew is tolerated; offline/history messages are not greeted.
  if (!Number.isFinite(age) || age < -60_000 || age > maxMessageAgeMs) return null;
  return { chatId: message.chatId, messageId: message.messageId };
}
