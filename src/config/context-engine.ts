export interface ContextEngineConfig {
  endpoint: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export function loadContextEngineConfig(
  env: NodeJS.ProcessEnv = process.env,
): ContextEngineConfig | undefined {
  if (!env.CONTEXT_MCP_URL?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(env.CONTEXT_MCP_URL.trim());
  } catch {
    throw new Error('Invalid CONTEXT_MCP_URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['/mcp', '/mcp/ramesh'].includes(url.pathname)
  )
    throw new Error(
      'CONTEXT_MCP_URL must be an HTTPS /mcp or /mcp/ramesh endpoint (HTTP is allowed only on loopback)',
    );
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  return {
    endpoint: url.href,
    timeoutMs: integer('CONTEXT_MCP_TIMEOUT_MS', 30000, 1000, 60000),
    maxResponseBytes: integer('CONTEXT_MCP_MAX_RESPONSE_BYTES', 1048576, 16384, 4194304),
  };
}
