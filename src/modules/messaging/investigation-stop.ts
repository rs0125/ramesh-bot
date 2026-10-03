/** Direct transport command only. Models and retrieved text cannot choose cancellation targets. */
import { z } from 'zod';
import type { GreetingCandidate } from '../greetings/greeting.types.js';

export const storedInvestigationStopSchema = z
  .object({
    version: z.literal(1),
    cancelledRunIds: z.array(z.uuid()),
    alreadySending: z.number().int().nonnegative(),
    preservedOutcomes: z.number().int().nonnegative(),
    replyQueued: z.boolean(),
  })
  .strict();

export interface InvestigationStopResult {
  duplicate: boolean;
  cancelledRunIds: string[];
  alreadySending: number;
  preservedOutcomes: number;
  /** Always returned by the repository; optional only for callers constructing display fixtures. */
  replyQueued?: boolean;
}

export function isInvestigationStop(message: GreetingCandidate): boolean {
  if (
    message.fromMe ||
    message.kind !== 'text' ||
    message.forwarded !== false ||
    message.batchMessageIds ||
    !message.text
  )
    return false;
  if (
    message.isGroup &&
    (!message.mentionsBot || !message.senderId || message.senderId === message.chatId)
  )
    return false;
  const text = message.text.trim();
  return (
    /^stop[.!]?$/i.test(text) ||
    (message.isGroup && /^(?:@\d+\s+stop[.!]?|stop[.!]?\s+@\d+)$/i.test(text))
  );
}

/** Fixed acknowledgement describes only the durable outcome, never a model's promise. */
export function renderInvestigationStop(result: InvestigationStopResult): string {
  const parts: string[] = [];
  if (result.cancelledRunIds.length) parts.push('Stopped your pending work.');
  if (result.preservedOutcomes)
    parts.push(
      'I kept the results of saved changes and published confirmations; those were not cancelled.',
    );
  if (result.alreadySending)
    parts.push("A reply is already sending or its delivery is uncertain, so I can't withdraw it.");
  return parts.join(' ') || 'There is no pending investigation for me to stop.';
}
