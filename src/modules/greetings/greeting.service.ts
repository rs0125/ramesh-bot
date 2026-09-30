/** Coordinates eligibility, persistent deduplication, and one reply per message. */
import { selectGreetingTarget } from './greeting.policy.js';
import type {
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
  ) {}

  /** The adapter supplies reply(), binding the destination to the triggering message. */
  async handle(message: GreetingCandidate, reply: Reply): Promise<GreetingOutcome> {
    const key = selectGreetingTarget(message, this.now(), this.maxMessageAgeMs);
    if (!key) return 'ignored';
    if (!(await this.repository.claim(key))) return 'duplicate';

    try {
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
