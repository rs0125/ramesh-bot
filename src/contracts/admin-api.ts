/** Worker-owned v1 HTTP contract. Consumers maintain their own types and runtime validation. */
export type BotState =
  | 'stopped'
  | 'connecting'
  | 'pairing'
  | 'connected'
  | 'reconnecting'
  | 'disconnecting'
  | 'error';
export type BotAction = 'connect' | 'disconnect' | 'reconnect';
export interface BotEvent {
  at: string;
  level: 'info' | 'error';
  message: string;
}
export interface BotStatus {
  scheduling?: {
    toolsEnabled: boolean;
    schedulerEnabled: boolean;
    scheduler: {
      running: boolean;
      lastTickAt: string | null;
      lastSuccessAt: string | null;
      lastError: boolean;
    } | null;
  };
  state: BotState;
  qr: string | null;
  updatedAt: string;
  startedAt: string;
  metrics: {
    received: number;
    replied: number;
    duplicates: number;
    errors: number;
    dropped: number;
  };
  events: BotEvent[];
}

export interface Conversation {
  chatId: string;
  name: string;
  isGroup: boolean;
  lastMessage: string;
  lastMessageAt: string;
}
export interface InboxMessage {
  id: string;
  chatId: string;
  text: string;
  senderId: string | null;
  senderName: string;
  direction: 'inbound' | 'outbound';
  source: 'whatsapp' | 'assistant' | 'admin' | 'automation';
  mentionsBot: boolean;
  at: string;
  status: string;
  kind: string;
}
export interface InboxPage {
  messages: InboxMessage[];
  nextCursor: string | null;
}
export interface ConversationPage {
  conversations: Conversation[];
  nextCursor: string | null;
  groupRepliesRequireMention: boolean;
}
