/** Domain contracts: greeting code has no dependency on Baileys or Prisma. */
export interface GreetingKey {
  readonly chatId: string;
  readonly messageId: string;
}

/** Minimal metadata needed for the greeting policy; message text stays in the adapter. */
export interface GreetingCandidate extends GreetingKey {
  readonly sentAtMs: number;
  readonly fromMe: boolean;
  readonly isGroup: boolean;
  readonly mentionsBot: boolean;
}

export interface GreetingRepository {
  /** Atomically claims a message. Returns false if another attempt already owns it. */
  claim(key: GreetingKey): Promise<boolean>;
  markSent(key: GreetingKey): Promise<void>;
  /** Retains the claim: a network error does not prove the provider failed to send. */
  markFailed(key: GreetingKey): Promise<void>;
}

export type Reply = (text: string) => Promise<void>;
/** False means the pending reply was cancelled before sending. */
export type BeforeReply = (signal?: AbortSignal) => Promise<boolean>;
export type GreetingOutcome = 'ignored' | 'duplicate' | 'sent';
