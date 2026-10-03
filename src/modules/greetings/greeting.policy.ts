/** Pure eligibility rules. Time is supplied by the caller for deterministic tests. */
import type { GreetingCandidate, GreetingKey } from './greeting.types.js';
import { GROUP_REPLIES_REQUIRE_MENTION } from '../../config/group-policy.js';

export function selectGreetingTarget(
  message: GreetingCandidate,
  now: number,
  maxMessageAgeMs: number,
  requireGroupMention = GROUP_REPLIES_REQUIRE_MENTION,
): GreetingKey | null {
  if (message.fromMe || (message.isGroup && requireGroupMention && !message.mentionsBot))
    return null;
  const age = now - message.sentAtMs;
  // Small forward clock skew is tolerated; stale messages are not greeted,
  // while recent deliveries received during a reconnect remain eligible.
  if (!Number.isFinite(age) || age < -60_000 || age > maxMessageAgeMs) return null;
  return { chatId: message.chatId, messageId: message.messageId };
}
