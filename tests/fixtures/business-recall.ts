/** Refresh-test helper: select the advertised latest handle explicitly, as a caller must. */
import type { businessRecall } from '../../src/modules/assistant/business-recall.js';
import type { ChatMessage } from '../../src/modules/assistant/assistant.types.js';
import { historyTurnId } from '../../src/modules/assistant/tool-history-recall.js';
import { historicalDeliverySchema } from '../../src/modules/messaging/delivery-evidence.js';

export function recallTurnId(reply: NonNullable<ChatMessage['protectedReply']>) {
  return historyTurnId({
    text: reply.text,
    receipt: historicalDeliverySchema.parse(reply.receipt),
  });
}

export function executeRecall(
  recall: ReturnType<typeof businessRecall>,
  args: string,
  signal: AbortSignal,
) {
  return recall.execute(
    JSON.stringify({
      turn_id: recall.targets.at(-1)?.turn_id ?? `turn-${'0'.repeat(24)}`,
      ...JSON.parse(args),
    }),
    signal,
  );
}
