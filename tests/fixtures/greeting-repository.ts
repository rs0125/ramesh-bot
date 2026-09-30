/** In-memory claims let pacing tests assert sends and cancellation without a database. */
import type {
  GreetingKey,
  GreetingRepository,
} from '../../src/modules/greetings/greeting.types.js';

export class MemoryGreetingRepository implements GreetingRepository {
  readonly claims = new Map<string, 'CLAIMED' | 'SENT' | 'FAILED'>();
  private key(key: GreetingKey) {
    return JSON.stringify([key.chatId, key.messageId]);
  }
  async claim(key: GreetingKey) {
    const id = this.key(key);
    if (this.claims.has(id)) return false;
    this.claims.set(id, 'CLAIMED');
    return true;
  }
  async markSent(key: GreetingKey) {
    this.claims.set(this.key(key), 'SENT');
  }
  async markFailed(key: GreetingKey) {
    this.claims.set(this.key(key), 'FAILED');
  }
}
