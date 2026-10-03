/** Contracts from the authenticated Context Engine. They describe reads, never grant employee identity. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import {
  CONTEXT_READ_TOOLS,
  ContextEngineError,
  isContextReadTool,
  type ContextToolDefinition,
} from './context.types.js';

export const READ_CONTRACT_KEY = 'wareongo/context-read-v1';
export const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export const MAX_CATALOGUE_TOOLS = 64;
export const MAX_CATALOGUE_BYTES = 512_000;
export const MAX_GUIDANCE_BYTES = 64_000;
const reserved = new Set([
  'recall_business_context',
  'calculate',
  'web_search',
  'read_webpage',
  'write_history',
  'write_sources',
]);
const contract = z
  .object({
    requiredScopes: z.array(z.string().regex(/^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.-]*$/)).max(32),
    sourceFamily: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,63}$/)
      .optional(),
  })
  .strict();

export function readContract(tool: ContextToolDefinition) {
  const raw = tool._meta?.[READ_CONTRACT_KEY];
  if (raw !== undefined) {
    const parsed = contract.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }
  // Rolling deployment compatibility. This mapping cannot admit a new tool.
  if (!isContextReadTool(tool.name)) return undefined;
  const scope = CONTEXT_READ_TOOLS[tool.name];
  return { requiredScopes: scope ? [scope] : [], sourceFamily: scope?.split(':')[0] ?? 'context' };
}

export function contextReadDescriptor(tool: ContextToolDefinition) {
  if (
    !TOOL_NAME.test(tool.name) ||
    reserved.has(tool.name) ||
    tool.annotations?.readOnlyHint !== true ||
    tool._meta?.['wareongo/context-write-v1'] !== undefined ||
    tool.annotations.destructiveHint === true
  )
    return false;
  const metadata = readContract(tool);
  if (!metadata || (!isContextReadTool(tool.name) && !tool.outputSchema)) return false;
  return true;
}
export function admittedReadTool(tool: ContextToolDefinition, scopes: readonly string[]) {
  return (
    contextReadDescriptor(tool) &&
    readContract(tool)!.requiredScopes.every((scope) => scopes.includes(scope))
  );
}

export function canonicalJson(value: unknown): string {
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 40) throw new ContextEngineError('INVALID_ARGUMENTS');
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, visit(child, depth + 1)]),
      );
    return item;
  };
  return JSON.stringify(visit(value, 0));
}
export const argumentsSha256 = (args: Record<string, unknown>) =>
  createHash('sha256').update(canonicalJson(args)).digest('hex');
export const sameToolContract = (left: ContextToolDefinition, right: ContextToolDefinition) =>
  canonicalJson(left) === canonicalJson(right);

/** Validation is synchronous and isolated: schema $id values cannot poison another tool's validator. */
export function schemaAccepts(schema: Record<string, unknown>, value: unknown): boolean {
  const check = (item: unknown, depth: number): void => {
    if (depth > 40) throw new ContextEngineError('INVALID_RESPONSE');
    if (!item || typeof item !== 'object') return;
    if ('$async' in item && item.$async !== false) throw new ContextEngineError('INVALID_RESPONSE');
    for (const child of Object.values(item)) check(child, depth + 1);
  };
  check(schema, 0);
  try {
    return new AjvJsonSchemaValidator().getValidator(schema)(value).valid;
  } catch {
    throw new ContextEngineError('INVALID_RESPONSE');
  }
}

/** get_context is an orientation surface, not a way to inject arbitrary private records into chat. */
export function modelContext(data: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    'scopes',
    'read_only',
    'write_capabilities',
    'knowledge_discovery',
    'server_clock',
    'query_guidance',
    'constraints',
    'api_specification',
    'context_markdown',
  ];
  const projected = Object.fromEntries(
    allowed.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]),
  );
  if (Buffer.byteLength(JSON.stringify(projected)) > 32_000)
    throw new ContextEngineError('RESPONSE_TOO_LARGE');
  return structuredClone(projected);
}
