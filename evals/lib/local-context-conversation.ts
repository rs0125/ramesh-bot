/** A seed transcript lives only in the caller's private local evaluation directory. */
import type { ChatMessage } from '../../src/modules/assistant/assistant.types.js';
import type { ContextEntry, ContextSource } from '../../src/modules/assistant/chat-context.js';
import type {
  GreetingCandidate,
  TrustedReplyContext,
} from '../../src/modules/greetings/greeting.types.js';
import { randomUUID } from 'node:crypto';

export class LocalContextConversation implements ContextSource {
  readonly entries: ContextEntry[] = [];
  private sequence = 0;
  constructor(readonly chatId: string) {}
  add(message: ChatMessage) {
    const id = String(++this.sequence).padStart(12, '0');
    this.entries.push({ ...structuredClone(message), id });
    return id;
  }
  request(text: string) {
    const id = this.add({ role: 'user', content: text });
    const candidate: GreetingCandidate = {
      chatId: this.chatId,
      senderId: this.chatId,
      messageId: id,
      text,
      sentAtMs: Date.now(),
      isGroup: false,
      fromMe: false,
      mentionsBot: false,
    };
    const trusted: TrustedReplyContext = {
      runId: randomUUID(),
      key: { remoteJid: this.chatId, fromMe: false },
      commandMessages: [{ id, text, receivedAtMs: Date.now(), forwarded: false }],
    };
    return { candidate, trusted };
  }
  async anchor(message: GreetingCandidate) {
    return {
      before: message.messageId,
      start: String(Number(message.messageId) - 1).padStart(12, '0'),
    };
  }
  async page(_message: GreetingCandidate, after: string, before: string) {
    const entries = this.entries.filter((item) => item.id > after && item.id < before);
    return { entries: structuredClone(entries.slice(0, 128)), more: entries.length > 128 };
  }
  filler(turns: number) {
    for (let i = 0; i < turns; i++) {
      this.add({
        role: 'user',
        content: `Unrelated chat ${i + 1}: explain the difference between a note and a reminder in one sentence.`,
      });
      this.add({
        role: 'assistant',
        content:
          'A note stores information; a reminder prompts you at a chosen time. No reminder has been created.',
      });
    }
  }
}
