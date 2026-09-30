/** OpenAI settings shared by the worker, local playground, and opt-in live evaluations. */
export interface AssistantConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export function loadAssistantConfig(
  env: NodeJS.ProcessEnv = process.env,
): AssistantConfig | undefined {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const model = env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra';
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new Error('Invalid OPENAI_MODEL');
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${name} must be between ${min} and ${max}`);
    return value;
  };
  return {
    apiKey,
    model,
    timeoutMs: integer('AGENT_TIMEOUT_MS', 45_000, 1000, 120_000),
    maxOutputTokens: integer('AGENT_MAX_OUTPUT_TOKENS', 800, 128, 2000),
  };
}
