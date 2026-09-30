/** Domain contracts: greeting code has no dependency on Baileys or Prisma. */
export interface GreetingKey {
  readonly chatId: string;
  readonly messageId: string;
}

/** Trigger metadata plus optional conversation input populated by the WhatsApp mapper. */
export interface GreetingCandidate extends GreetingKey {
  readonly sentAtMs: number;
  readonly fromMe: boolean;
  readonly isGroup: boolean;
  readonly mentionsBot: boolean;
  readonly text?: string;
  readonly senderId?: string;
}

export interface GreetingRepository {
  /** Atomically claims a message. Returns false if another attempt already owns it. */
  claim(key: GreetingKey): Promise<boolean>;
  markSent(key: GreetingKey): Promise<void>;
  /** Retains the claim: a network error does not prove the provider failed to send. */
  markFailed(key: GreetingKey): Promise<void>;
}

export type Reply = (text: string) => Promise<void>;
export interface PreparedReply {
  text: string;
  /** Called only after the transport accepts the reply. Never performs network work. */
  onSent?: () => void;
}
export type PrepareReply = (
  message: GreetingCandidate,
  signal?: AbortSignal,
) => Promise<PreparedReply>;
/** False means the pending reply was cancelled before sending. */
export type BeforeReply = (signal?: AbortSignal) => Promise<boolean>;
export type GreetingOutcome = 'ignored' | 'duplicate' | 'sent';
