/** Small model port: the graph knows nothing about OpenAI credentials or WhatsApp sends. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Server-only envelope. Never serialize into model history; recall requires fresh scoped reads. */
  protectedReply?: { text: string; receipt: unknown };
}

export type AgentStage =
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
  text: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  responseId?: string;
}

export interface TextModel {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResult>;
  startToolSession?(request: ToolSessionRequest): ToolModelSession;
}

export interface ToolSessionRequest {
  instructions: string;
  messages: ChatMessage[];
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
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
  ): Promise<ModelResult & { calls: ModelToolCall[] }>;
  accept(callId: string, output: unknown): void;
  /** Continue the current task after a failed independent review; never resets tool budgets. */
  revise?(feedback: string): void;
}

export interface StageMetric {
  stage: AgentStage;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface AgentTrace {
  runId: string;
  model: string;
  promptVersion: string;
  durationMs: number;
  stages: StageMetric[];
  outcome: 'completed' | 'unavailable' | 'input_rejected';
  limitedBy?: 'research_deadline';
  failureCode?: 'DEADLINE_EXCEEDED' | 'RUN_FAILED';
  usage?: import('../usage/usage.types.js').UsageSummary;
  usageUnavailable?: boolean;
}
