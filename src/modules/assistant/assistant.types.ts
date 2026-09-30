/** Small model port: the graph knows nothing about OpenAI credentials or WhatsApp sends. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentStage = 'converser' | 'formatter' | 'judge';

export interface ModelRequest {
  stage: AgentStage;
  instructions: string;
  messages: ChatMessage[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export interface ModelResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  responseId?: string;
}

export interface TextModel {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResult>;
}

export interface StageMetric {
  stage: AgentStage;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentTrace {
  runId: string;
  model: string;
  promptVersion: string;
  durationMs: number;
  stages: StageMetric[];
  outcome: 'completed' | 'unavailable' | 'input_rejected';
}
