/** Fixed failure metadata only: never retain provider bodies, prompts or headers. */
import type { AgentStage } from './assistant.types.js';

export interface ModelFailure {
  stage: AgentStage;
  code:
    | 'INVALID_SCHEMA'
    | 'REQUEST_REJECTED'
    | 'ACCESS_DENIED'
    | 'RATE_LIMITED'
    | 'UNAVAILABLE'
    | 'INVALID_RESPONSE'
    | 'INVALID_JSON'
    | 'SCHEMA_MISMATCH'
    | 'AMBIGUOUS_OUTPUT'
    | 'REFUSAL'
    | 'INCOMPLETE_RESPONSE'
    | 'CONTEXT_BUDGET';
  httpStatus?: number;
  /** Counts only, so concatenation/phase anomalies are diagnosable without private text. */
  outputShape?: {
    messages: number;
    commentaryMessages: number;
    finalMessages: number;
    textParts: number;
    refusals: number;
  };
}

export class ModelFailureError extends Error {
  constructor(
    readonly details: ModelFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ModelFailureError';
  }
}
