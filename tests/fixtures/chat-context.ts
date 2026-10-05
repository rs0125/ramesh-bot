/** Synthetic conversation, clock and identity. No API, database or transport. */
import {
  ChatContext,
  contextScope,
  type ContextEntry,
  type ContextScope,
  type ContextSnapshot,
  type ContextState,
} from '../../src/modules/assistant/chat-context.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import type { ChatMessage, ModelRequest } from '../../src/modules/assistant/assistant.types.js';

export const CONTEXT_DAY = 86400000;
export const contextId = (n: number) => String(n).padStart(12, '0');
export const CONTEXT_CHAT = '20000000000@s.whatsapp.net';
export function contextFixture() {
  let now = Date.now(),
    reply = 'Synthetic reply.';
  const original = contextScope('synthetic', CONTEXT_CHAT, {
    employeeId: 1,
    phoneE164: '+20000000000',
  });
  let actor: ContextScope | null = original;
  let snapshot: (ContextSnapshot & { owner: string }) | undefined;
  const entries: ContextEntry[] = [],
    requests: ModelRequest[] = [];
  const store = {
    async load(scope: ContextScope) {
      return snapshot?.owner === scope.owner ? structuredClone(snapshot) : null;
    },
    async save(scope: ContextScope, revision: number, state: ContextState) {
      if (((await this.load(scope))?.revision ?? 0) !== revision) return false;
      snapshot = structuredClone({ owner: scope.owner, revision: revision + 1, state });
      return true;
    },
  };
  const model = {
    async complete(request: ModelRequest) {
      requests.push(request);
      if (request.stage !== 'context') return { text: reply, inputTokens: 0, outputTokens: 0 };
      const body = JSON.parse(request.messages[0]!.content);
      return {
        text: JSON.stringify({
          notes: body.previous.notes.length
            ? body.previous.notes.map(
                ({ kind, text, sources }: { kind: string; text: string; sources: string[] }) => ({
                  kind,
                  text,
                  sources,
                }),
              )
            : [
                {
                  kind: 'objective',
                  text: 'Temporary original objective.',
                  sources: [body.messages[0].id],
                },
              ],
        }),
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
  const create = () =>
    new ChatContext({
      store,
      model,
      now: () => now,
      resolve: async () => actor,
      source: {
        async anchor(message) {
          return { before: message.messageId, start: contextId(Number(message.messageId) - 1) };
        },
        async page(_message, after, before, floor) {
          const eligible = entries.filter(
            (entry) => entry.id > after && entry.id < before && entry.id >= floor,
          );
          return { entries: structuredClone(eligible.slice(0, 128)), more: eligible.length > 128 };
        },
      },
    });
  const context = create();
  const service = new AssistantService(
    { model: 'synthetic-no-api', timeoutMs: 10000 },
    model,
    undefined,
    undefined,
    undefined,
    undefined,
    { conversationContext: context },
  );
  const turn = (n: number, text: string) =>
    [
      {
        chatId: CONTEXT_CHAT,
        messageId: contextId(n),
        text,
        sentAtMs: Date.now(),
        fromMe: false,
        isGroup: false,
        mentionsBot: false,
      },
      {
        runId: contextId(n),
        key: { remoteJid: CONTEXT_CHAT },
        commandMessages: [{ id: contextId(n), text, receivedAtMs: now, forwarded: false }],
      },
      AbortSignal.timeout(10000),
    ] as const;
  return {
    context,
    create,
    service,
    store,
    entries,
    requests,
    original,
    turn,
    now: () => now,
    add: (n: number, message: ChatMessage, at = now) =>
      entries.push({ ...message, id: contextId(n), at }),
    advance: (days: number) => {
      now += days * CONTEXT_DAY;
    },
    reply: (text: string) => {
      reply = text;
    },
    revoke: () => {
      actor = null;
    },
    reassign: (employeeId = 2, email?: string) => {
      actor = contextScope('synthetic', CONTEXT_CHAT, {
        employeeId,
        phoneE164: '+20000000000',
        email,
      });
    },
  };
}
