/** Coordinates eligibility, persistent deduplication, and one reply per message. */
import { selectGreetingTarget } from './greeting.policy.js';
import type {
  BeforeReply,
  GreetingCandidate,
  GreetingOutcome,
  GreetingRepository,
  Reply,
} from './greeting.types.js';

export class GreetingService {
  constructor(
    private readonly repository: GreetingRepository,
    private readonly maxMessageAgeMs: number,
    private readonly now: () => number = Date.now,
    private readonly waitBeforeReply: BeforeReply = async () => true,
  ) {}

  /** The adapter supplies reply(), binding the destination to the triggering message. */
  async handle(
    message: GreetingCandidate,
    reply: Reply,
    signal?: AbortSignal,
  ): Promise<GreetingOutcome> {
    if (signal?.aborted) return 'ignored';
    const key = selectGreetingTarget(message, this.now(), this.maxMessageAgeMs);
    if (!key) return 'ignored';
    if (!(await this.repository.claim(key))) return 'duplicate';

    try {
      // Claim first so duplicate events never occupy another delay or send slot.
      // Cancelled/expired claims stay retained, preventing stale replay after reconnect.
      if (
        !(await this.waitBeforeReply(signal)) ||
        signal?.aborted ||
        !selectGreetingTarget(message, this.now(), this.maxMessageAgeMs)
      )
        return 'ignored';
      await reply('hello');
    } catch (sendError) {
      try {
        await this.repository.markFailed(key);
      } catch (storageError) {
        throw new AggregateError(
          [sendError, storageError],
          'Reply failed and its failure could not be recorded',
        );
      }
      throw sendError;
    }
    // A failed status write after sending leaves CLAIMED, preventing an unsafe resend.
    await this.repository.markSent(key);
    return 'sent';
  }
}
