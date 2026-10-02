/** Ordered, lease-fenced model response replay; this interface never caches tool results. */
export interface AgentCheckpointMetadata {
  requestTimeMs: number;
  startedAtMs: number;
  deadlineAtMs: number;
}

export interface AgentCheckpointSession {
  readonly metadata: Readonly<AgentCheckpointMetadata>;
  read<T>(sequence: number, request: unknown): Promise<T | undefined>;
  save(sequence: number, request: unknown, response: unknown): Promise<void>;
  consume(resource: 'tool' | 'web' | 'bytes', amount: number): Promise<boolean>;
  policy<T>(key: string, update?: (current: T | undefined) => T): Promise<T | undefined>;
}

/** Caller must retry/release its queue job instead of converting failed persistence into a reply. */
export class CheckpointError extends Error {
  constructor() {
    super('CHECKPOINT_OPERATION_FAILED');
    this.name = 'CheckpointError';
  }
}

export interface AgentCheckpointBegin {
  jobId: string;
  leaseToken: string;
  /** Trusted conversation/sender, employee identity, environment and model/prompt context. */
  binding: unknown;
  requestTimeMs: number;
  startedAtMs?: number;
  deadlineAtMs: number;
}

export interface AgentCheckpointStore {
  begin(input: AgentCheckpointBegin): Promise<AgentCheckpointSession>;
}
