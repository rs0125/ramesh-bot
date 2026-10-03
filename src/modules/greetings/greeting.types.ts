/** Domain contracts: greeting code has no dependency on Baileys or Prisma. */
import type { NativeLocation } from '../messaging/native-location.js';

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
  readonly senderName?: string;
  readonly chatName?: string;
  readonly kind?: string;
  readonly forwarded?: boolean;
  readonly location?: NativeLocation;
  readonly batchMessageIds?: readonly string[];
}

export interface GreetingRepository {
  /** Atomically claims a message. Returns false if another attempt already owns it. */
  claim(key: GreetingKey): Promise<boolean>;
  markSent(key: GreetingKey): Promise<void>;
  /** Retains the claim: a network error does not prove the provider failed to send. */
  markFailed(key: GreetingKey): Promise<void>;
}

export type Reply = (text: string) => Promise<void>;
/** Supplied only by the transport after decoding the saved original message, never by a model. */
export interface TrustedReplyContext {
  readonly runId: string;
  /** Transport-owned lease; never accepted from chat input or a model argument. */
  readonly checkpointLease?: { readonly leaseToken: string };
  /** Immutable original message members; only their own text/direct voice may authorize commands. */
  readonly commandMessages?: readonly {
    readonly id: string;
    readonly text: string;
    readonly receivedAtMs: number;
    readonly forwarded: boolean;
  }[];
  /** Decoded native pins, bound to original transport members; labels never grant write intent. */
  readonly locationMessages?: readonly {
    readonly id: string;
    readonly messageId: string;
    readonly receivedAtMs: number;
    readonly forwarded: boolean;
    readonly location: NativeLocation;
  }[];
  readonly mediaContext?: string;
  readonly key: { remoteJid?: string | null; participant?: string | null; fromMe?: boolean | null };
  readonly record?: (
    kind: 'tool_started' | 'tool_succeeded' | 'tool_failed',
    value: unknown,
  ) => Promise<void>;
}
export interface PreparedReply {
  text: string;
  /** Opaque, validated by the business module and encrypted separately for delivery preflight. */
  businessEvidence?: unknown;
  /** Called only after the transport accepts the reply. Never performs network work. */
  onSent?: () => void;
}
export type PrepareReply = (
  message: GreetingCandidate,
  signal?: AbortSignal,
  trusted?: TrustedReplyContext,
) => Promise<PreparedReply>;
/** False means the pending reply was cancelled before sending. */
export type BeforeReply = (signal?: AbortSignal) => Promise<boolean>;
export type GreetingOutcome = 'ignored' | 'duplicate' | 'sent';
