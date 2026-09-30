/** Bounded, short-lived context. Only replies accepted by the transport are remembered. */
import type { ChatMessage } from './assistant.types.js';

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

  remember(key: string, input: string, reply: string) {
    const messages: ChatMessage[] = [
      ...this.get(key),
      { role: 'user' as const, content: input },
      { role: 'assistant' as const, content: reply },
    ].slice(-12);
    while (messages.reduce((size, message) => size + message.content.length, 0) > 16_000)
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
