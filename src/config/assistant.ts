/** OpenAI settings shared by the worker, local playground, and opt-in live evaluations. */
import { loadUsagePolicy, type UsagePolicy } from './usage.js';
import type { UsageMeter } from '../modules/usage/usage-meter.js';
export interface AssistantConfig {
  apiKey: string;
  sttApiKey?: string;
  transcriptionModel?: string;
  /** Optional server-only credential for public web search and page reading. */
  tavilyApiKey?: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  toolReasoningEffort?: 'low' | 'medium' | 'high';
  usagePolicy?: UsagePolicy;
  /** Runtime dependency shared by text, judges and media; never serialized into provider requests. */
  usageMeter?: UsageMeter;
}

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';
/** GPT-6.1 Sol requires at least low, including simple formatting. */
export function effectiveReasoningEffort(model: string, requested: ReasoningEffort) {
  return /^gpt-6\.1-sol(?:-|$)/.test(model) && requested === 'none' ? 'low' : requested;
}

export function loadAssistantConfig(
  env: NodeJS.ProcessEnv = process.env,
): AssistantConfig | undefined {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const model = env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra';
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new Error('Invalid OPENAI_MODEL');
  const transcriptionModel = env.OPENAI_TRANSCRIBE_MODEL?.trim() || 'gpt-4o-transcribe';
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(transcriptionModel))
    throw new Error('Invalid OPENAI_TRANSCRIBE_MODEL');
  const toolReasoningEffort = env.AGENT_TOOL_REASONING_EFFORT?.trim() || 'medium';
  const tavilyApiKey = env.TAVILY_API_KEY?.trim() || undefined;
  if (tavilyApiKey && (tavilyApiKey.length > 512 || /\s/.test(tavilyApiKey)))
    throw new Error('Invalid TAVILY_API_KEY');
  if (!['low', 'medium', 'high'].includes(toolReasoningEffort))
    throw new Error('AGENT_TOOL_REASONING_EFFORT must be low, medium or high');
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${name} must be between ${min} and ${max}`);
    return value;
  };
  return {
    apiKey,
    sttApiKey: env.OPENAI_STT_API_KEY?.trim() || apiKey,
    transcriptionModel,
    tavilyApiKey,
    model,
    usagePolicy: loadUsagePolicy(env),
    toolReasoningEffort: toolReasoningEffort as 'low' | 'medium' | 'high',
    timeoutMs: integer('AGENT_TIMEOUT_MS', 45_000, 1000, 300_000),
    maxOutputTokens: integer('AGENT_MAX_OUTPUT_TOKENS', 800, 128, 8000),
  };
}
