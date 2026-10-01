/** Runs the graph within a deadline; keeps conversation context out of transport and prompts out of logs. */
import { createHash, randomUUID } from 'node:crypto';
import type { AssistantConfig } from '../../config/assistant.js';
import type { GreetingCandidate, PreparedReply } from '../greetings/greeting.types.js';
import type { AgentTrace, ChatMessage, TextModel } from './assistant.types.js';
import { buildAssistantGraph } from './assistant.graph.js';
import { ConversationMemory } from './conversation-memory.js';
import { PROMPT_VERSION } from './prompts.js';

export interface AssistantReply extends PreparedReply {
  trace: AgentTrace;
  draft?: string;
}
export const UNAVAILABLE_REPLY = "I'm having trouble replying right now. Try again in a bit.";

export class AssistantService {
  private readonly graph;
  constructor(
    private readonly modelConfig: Pick<AssistantConfig, 'model' | 'timeoutMs'>,
    model: TextModel,
    private readonly memory = new ConversationMemory(),
    private readonly observe: (trace: AgentTrace) => void = () => {},
    private readonly readHistory?: (message: GreetingCandidate) => Promise<ChatMessage[]>,
  ) {
    this.graph = buildAssistantGraph(model);
  }

  private key(message: GreetingCandidate): string | undefined {
    return createHash('sha256').update(message.chatId).digest('hex');
  }

  /** Local development fallback; production reads the durable inbox instead. */
  observeMessage(message: GreetingCandidate) {
    if (this.readHistory || message.fromMe || !message.text) return;
    const key = this.key(message);
    if (key) this.memory.observe(key, this.input(message));
  }

  private input(message: GreetingCandidate): string {
    return message.isGroup
      ? JSON.stringify({
          sender: message.senderName ?? message.senderId ?? 'Unknown sender',
          senderId: message.senderId,
          text: message.text,
        })
      : (message.text?.trim() ?? '');
  }

  clear(message: GreetingCandidate) {
    const key = this.key(message);
    if (key) this.memory.clear(key);
  }

  async prepare(message: GreetingCandidate, signal?: AbortSignal): Promise<AssistantReply> {
    signal?.throwIfAborted();
    const started = Date.now();
    const trace: AgentTrace = {
      runId: randomUUID(),
      model: this.modelConfig.model,
      promptVersion: PROMPT_VERSION,
      durationMs: 0,
      stages: [],
      outcome: 'completed',
    };
    const finish = (reply: Omit<AssistantReply, 'trace'>): AssistantReply => {
      trace.durationMs = Date.now() - started;
      this.observe(trace);
      return { ...reply, trace };
    };
    const input = message.text?.trim() ?? '';
    if (!input || input.length > 6000) {
      trace.outcome = 'input_rejected';
      return finish({
        text: input
          ? 'That message is a bit long. Can you split it into smaller parts?'
          : 'Could you send that as text?',
      });
    }
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException('Assistant timed out', 'TimeoutError')),
      this.modelConfig.timeoutMs,
    );
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const key = this.key(message);
    try {
      const history = this.readHistory
        ? await this.readHistory(message)
        : key
          ? this.memory.get(key)
          : [];
      combined.throwIfAborted();
      const result = await this.graph.invoke(
        {
          input: this.input(message),
          history,
          audience: message.isGroup ? 'group' : 'dm',
        },
        { signal: combined, recursionLimit: 4 },
      );
      combined.throwIfAborted();
      trace.stages = result.stages;
      let remembered = false;
      return finish({
        text: result.reply,
        draft: result.draft,
        onSent: () => {
          if (!remembered && key) {
            this.memory.remember(key, this.input(message), result.reply);
            remembered = true;
          }
        },
      });
    } catch {
      signal?.throwIfAborted();
      trace.outcome = 'unavailable';
      return finish({ text: UNAVAILABLE_REPLY });
    } finally {
      clearTimeout(timer);
    }
  }
}
