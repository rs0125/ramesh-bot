/** Authenticated write discovery is separate from read evidence and supplies no user authorization. */
import { z } from 'zod';
import type { ContextToolDefinition } from './context.types.js';
import { TOOL_NAME, READ_CONTRACT_KEY } from './read-contract.js';

export const WRITE_CONTRACT_KEY = 'wareongo/context-write-v1';
const reserved = new Set([
  'get_context',
  'write_history',
  'write_sources',
  '_source_message_ids',
  'recall_business_context',
  'calculate',
  'web_search',
  'read_webpage',
  'personal_apply',
  'personal_list',
  'personal_history',
  'personal_occurrences',
  'personal_recall',
]);
const contractSchema = z
  .object({
    requiredScopes: z
      .array(z.string().regex(/^(?:[a-z][a-z0-9_.-]{0,63}:(?:read|write)|mail:drafts)$/))
      .min(1)
      .max(32)
      .refine(
        (scopes) =>
          new Set(scopes).size === scopes.length &&
          scopes.some((scope) => scope.endsWith(':write') || scope === 'mail:drafts'),
      ),
    sourceFamily: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    effect: z.enum(['create', 'update', 'delete', 'compensate']),
    // Explicit tool policy permitting employee-owned journal redisclosure. Omission grants none.
    auditHistory: z.literal('actor_scoped').optional(),
    compensates: z.string().regex(TOOL_NAME).optional(),
    originalOperationArgument: z
      .string()
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/)
      .optional(),
    coordinateArguments: z
      .object({
        latitude: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
        longitude: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
      })
      .strict()
      .optional(),
    idempotencyArgument: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
  })
  .strict();
export const writeBindingSchema = z
  .object({
    toolName: z.string().regex(TOOL_NAME),
    argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    employeeId: z.number().int().positive().safe(),
  })
  .strict();
export const writeResultSchema = z
  .object({
    operation_id: z.string().uuid(),
    outcome: z.enum([
      'created',
      'replayed',
      'rolled_back',
      'not_dispatched',
      'rejected',
      'outcome_unknown',
    ]),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
    message: z.string().min(1).max(2000),
    data: z.record(z.string(), z.unknown()).optional(),
    meta: writeBindingSchema.optional(),
  })
  .strict();
export function writeContract(tool: ContextToolDefinition) {
  const parsed = contractSchema.safeParse(tool._meta?.[WRITE_CONTRACT_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/** Bound the schemas before AJV sees them; no remote refs, open objects or header extensions. */
function closedSchema(schema: Record<string, unknown>): boolean {
  if (schema.type !== 'object' || schema.additionalProperties !== false || !schema.properties)
    return false;
  if (Buffer.byteLength(JSON.stringify(schema)) > 64_000) return false;
  let nodes = 0;
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 4000 || depth > 24) return false;
    if (!value || typeof value !== 'object') return true;
    if (Array.isArray(value)) return value.every((child) => visit(child, depth + 1));
    const item = value as Record<string, unknown>;
    if ('$ref' in item || '$dynamicRef' in item || ('$async' in item && item.$async !== false))
      return false;
    if (
      (item.type === 'object' || (Array.isArray(item.type) && item.type.includes('object'))) &&
      item.additionalProperties !== false
    )
      return false;
    if (Object.keys(item).some((key) => /^x[-_].*header/i.test(key))) return false;
    return Object.values(item).every((child) => visit(child, depth + 1));
  };
  return visit(schema, 0);
}
export function contextWriteDescriptor(tool: ContextToolDefinition): boolean {
  if (
    !TOOL_NAME.test(tool.name) ||
    reserved.has(tool.name) ||
    tool.name.startsWith('personal_') ||
    tool.annotations?.readOnlyHint !== false ||
    tool.annotations.idempotentHint !== true ||
    typeof tool.annotations.destructiveHint !== 'boolean' ||
    tool._meta?.[READ_CONTRACT_KEY] !== undefined ||
    !tool.outputSchema ||
    !closedSchema(tool.inputSchema) ||
    !closedSchema(tool.outputSchema)
  )
    return false;
  const contract = writeContract(tool);
  if (!contract || (contract.effect === 'delete' && tool.annotations.destructiveHint !== true))
    return false;
  const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
  if ('_source_message_ids' in properties) return false;
  const coordinates = contract.coordinateArguments;
  if (
    coordinates &&
    (coordinates.latitude === coordinates.longitude ||
      [coordinates.latitude, coordinates.longitude].some(
        (name) =>
          properties[name]?.type !== 'number' ||
          !Array.isArray(tool.inputSchema.required) ||
          !tool.inputSchema.required.includes(name),
      ))
  )
    return false;
  const operation = properties[contract.idempotencyArgument];
  if (
    !operation ||
    operation.type !== 'string' ||
    operation.format !== 'uuid' ||
    !Array.isArray(tool.inputSchema.required) ||
    !tool.inputSchema.required.includes(contract.idempotencyArgument)
  )
    return false;
  if (contract.effect === 'compensate') {
    const original =
      contract.originalOperationArgument && properties[contract.originalOperationArgument];
    if (
      !contract.compensates ||
      !original ||
      original.type !== 'string' ||
      original.format !== 'uuid' ||
      !tool.inputSchema.required.includes(contract.originalOperationArgument)
    )
      return false;
  } else if (contract.compensates || contract.originalOperationArgument) return false;
  const required = tool.outputSchema.required;
  return (
    Array.isArray(required) &&
    ['operation_id', 'outcome', 'code', 'message', 'meta'].every((name) => required.includes(name))
  );
}
export function admittedWriteTool(tool: ContextToolDefinition, scopes: readonly string[]): boolean {
  return (
    contextWriteDescriptor(tool) &&
    writeContract(tool)!.requiredScopes.every((scope) => scopes.includes(scope))
  );
}
