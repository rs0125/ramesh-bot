/** Local fallback: bounded incoming context and replies accepted by the transport. */
import type { ChatMessage } from './assistant.types.js';
import { historyRequest } from './business-history.js';
export const MAX_HISTORY_MESSAGES = 32;
export const MAX_HISTORY_CHARACTERS = 48000;

/** Keep a neutral marker until protected history passes current owner authorization. */
export const PRIVATE_HISTORY_REPLY =
  '[A protected reply was delivered for this request. Its historical text and tool activity require current owner authorization.]';

export class ConversationMemory {
  private readonly entries = new Map<string, { messages: ChatMessage[]; expiresAt: number }>();
  constructor(
    private readonly now = Date.now,
    private readonly ttlMs = 30 * 60_000,
    private readonly capacity = 200,
  ) {}

  get(key: string): ChatMessage[] {
    const entry = this.entries.get(key);
    if (!entry) return [];
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return [];
    }
    return entry.messages.map((message) => ({ ...message }));
  }

  remember(
    key: string,
    input: string,
    reply: string,
    protectedReply?: ChatMessage['protectedReply'],
  ) {
    this.append(key, [
      { role: 'user' as const, content: input },
      {
        role: 'assistant' as const,
        content: reply,
        ...(protectedReply ? { protectedReply, businessRequest: historyRequest(input) } : {}),
      },
    ]);
  }

  observe(key: string, input: string) {
    this.append(key, [{ role: 'user', content: input.slice(0, 6000) }]);
  }

  private append(key: string, additions: ChatMessage[]) {
    const messages = [...this.get(key), ...additions].slice(-MAX_HISTORY_MESSAGES);
    while (
      messages.reduce((size, message) => size + message.content.length, 0) > MAX_HISTORY_CHARACTERS
    )
      messages.splice(0, 2);
    this.entries.delete(key);
    this.entries.set(key, { messages, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.capacity)
      this.entries.delete(this.entries.keys().next().value!);
  }

  clear(key: string) {
    this.entries.delete(key);
  }
}
