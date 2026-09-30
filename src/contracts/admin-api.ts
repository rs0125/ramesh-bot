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
