/** Small model port: the graph knows nothing about OpenAI credentials or WhatsApp sends. */
import type { ReviewMetric } from './review-diagnostics.js';
/** One model response can propose a small batch of independent authenticated reads. */
export const MAX_READ_BATCH = 3;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Server-only receipt. Same-employee business history projects text/activity separately from live evidence. */
  protectedReply?: { text: string; receipt: unknown };
  /** Server-owned association with the user request that produced this protected answer. */
  businessRequest?: string;
  /** Identities only, never serialized; recall reauthorizes and refreshes every record. */
  businessReferences?: import('./chat-context.js').RememberedSelection;
}

export type AgentStage =
  | 'context'
  | 'converser'
  | 'planner'
  | 'formatter'
  | 'judge'
  | 'worker'
  | 'executor'
  | 'verifier';

export interface ModelRequest {
  stage: AgentStage;
  instructions: string;
  messages: ChatMessage[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}

export interface ModelResult {
  model?: string;
  /** Successful Responses calls, including search continuations; excludes replay and SDK retries. */
  responseCalls?: number;
  text: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  responseId?: string;
}

export interface TextModel {
  readonly toolLoadingMode?: 'eager' | 'deferred';
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResult>;
  startToolSession?(request: ToolSessionRequest): ToolModelSession;
}

export interface ToolSessionRequest {
  instructions: string;
  messages: ChatMessage[];
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    /** Namespaced application hints; never executable templates or authorization grants. */
    _meta?: Record<string, unknown>;
    /** Presentation hint from the authenticated catalogue, never an authorization grant. */
    discovery?: {
      capability: string;
      description: string;
      loading: 'eager' | 'deferred';
    };
    annotations?: {
      readOnlyHint: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  }>;
}
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}
/** Provider continuation state is private to one run, never shared between employees. */
export interface ToolModelSession {
  next(
    remainingCalls: number,
    signal: AbortSignal,
    /** Current callable subset of the original catalogue; exhausted families are excluded. */
    allowedToolNames?: readonly string[],
  ): Promise<ModelResult & { calls: ModelToolCall[] }>;
  accept(callId: string, output: unknown): void;
  /** Continue the current task after a failed independent review; never resets tool budgets. */
  revise?(feedback: string): void;
}

export interface StageMetric {
  model?: string;
  responseCalls?: number;
  stage: AgentStage;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  /** Allowlisted verdict metadata only; no reviewer feedback, answer text, or source values. */
  review?: ReviewMetric;
  /** Fixed diagnostics only; never include candidate text, source values or feedback. */
  answerRepair?: { kind: 'format' | 'evidence'; outcome: 'changed' | 'unchanged' | 'rejected' };
  /** Code-owned completion rule and registered IDs only; excludes source text and record IDs. */
  presentation?: { adapter: string; renderer: string; completion: 'personal_default_list' };
}

export interface AgentTrace {
  runId: string;
  model: string;
  modelRouting?: 'single' | 'split';
  promptVersion: string;
  durationMs: number;
  stages: StageMetric[];
  outcome: 'completed' | 'unavailable' | 'input_rejected';
  limitedBy?: 'research_deadline';
  failureCode?: 'DEADLINE_EXCEEDED' | 'RUN_FAILED';
  /** Safe provider category and failing stage, without the original error body. */
  modelFailure?: import('./model-failure.js').ModelFailure;
  usage?: import('../usage/usage.types.js').UsageSummary;
  usageUnavailable?: boolean;
  /** Completed native model responses reused without another provider call. */
  replayedSteps?: number;
}
