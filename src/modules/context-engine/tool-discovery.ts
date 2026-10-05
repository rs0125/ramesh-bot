/** Generic presentation metadata. Tool names and capability membership remain server-owned. */
import { z } from 'zod';
import type { ContextToolDefinition } from './context.types.js';
import type { ToolSessionRequest } from '../assistant/assistant.types.js';

const discoverySchema = z
  .object({
    capability: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    description: z.string().min(1).max(512),
    loading: z.enum(['eager', 'deferred']),
  })
  .strict();

export function toolDiscovery(
  tool: ContextToolDefinition,
): ToolSessionRequest['tools'][number]['discovery'] {
  const raw = tool._meta?.['wareongo/tool-discovery-v1'];
  if (raw !== undefined) return discoverySchema.parse(raw);
  // Older first-party servers remain usable without a parallel name registry.
  const contract =
    tool._meta?.['wareongo/context-read-v1'] ?? tool._meta?.['wareongo/context-write-v1'];
  if (
    contract &&
    typeof contract === 'object' &&
    'sourceFamily' in contract &&
    typeof contract.sourceFamily === 'string' &&
    /^[a-z][a-z0-9_]{0,31}$/.test(contract.sourceFamily)
  ) {
    return {
      capability: contract.sourceFamily,
      description: `Context Engine ${contract.sourceFamily} tools.`,
      loading: 'deferred',
    };
  }
  return undefined;
}

/** Planners need names for their plan contract, but need not receive every parameter schema. */
export function planningToolDefinitions(
  tools: ToolSessionRequest['tools'],
  mode: 'eager' | 'deferred' = 'eager',
) {
  return mode === 'eager'
    ? tools
    : tools.map((tool) =>
        tool.discovery?.loading === 'deferred'
          ? {
              name: tool.name,
              description: tool.description?.slice(0, 240),
              capability: tool.discovery.capability,
            }
          : tool,
      );
}
