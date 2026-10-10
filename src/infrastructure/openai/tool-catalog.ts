/** Provider presentation only: definitions and capability membership come from discovery. */
import { isDeepStrictEqual } from 'node:util';
import type OpenAI from 'openai';
import type { ModelToolCall, ToolSessionRequest } from '../../modules/assistant/assistant.types.js';
import { strictToolSchema } from './strict-tool-schema.js';
import { GateRejection } from '../../modules/assistant/failure.js';

type Binding = {
  name: string;
  namespace?: string;
  definition: OpenAI.Responses.FunctionTool;
  decode(value: unknown): unknown;
  errors(value: unknown): Array<{ path: string; rule: string }>;
};
export type DecodedArguments =
  | { ok: true; json: string }
  | { ok: false; invalid: NonNullable<ModelToolCall['invalid']> };

export class OpenAIToolCatalog {
  readonly bindings: Binding[] = [];
  /** Tools the provider's strict subset cannot express. One such tool must not disable the rest. */
  readonly dropped: string[] = [];
  private readonly namespaces = new Map<string, string>();

  constructor(
    tools: ToolSessionRequest['tools'],
    readonly mode: 'eager' | 'deferred',
  ) {
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      throw new GateRejection('AMBIGUOUS_TOOL_CATALOGUE');
    const counts = new Map<string, number>();
    for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      let codec: ReturnType<typeof strictToolSchema>;
      try {
        codec = strictToolSchema(tool.inputSchema);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'UNSUPPORTED_STRICT_TOOL_SCHEMA')
          throw error;
        this.dropped.push(tool.name);
        continue;
      }
      let namespace: string | undefined;
      if (mode === 'deferred' && tool.discovery?.loading === 'deferred') {
        const { capability, description } = tool.discovery;
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(capability) || !description || description.length > 512)
          throw new GateRejection('INVALID_TOOL_DISCOVERY');
        const count = counts.get(capability) ?? 0;
        // Bounded groups; membership is generated, never a second business-tool registry.
        namespace = `ce_${capability}_${Math.floor(count / 8) + 1}`;
        counts.set(capability, count + 1);
        if (this.namespaces.has(namespace) && this.namespaces.get(namespace) !== description)
          throw new GateRejection('AMBIGUOUS_TOOL_CAPABILITY');
        this.namespaces.set(namespace, description);
      }
      this.bindings.push({
        name: tool.name,
        decode: codec.decode,
        errors: codec.errors,
        ...(namespace ? { namespace } : {}),
        definition: {
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: codec.schema,
          strict: true,
          ...(namespace ? { defer_loading: true } : {}),
        },
      });
    }
    // Preserve the current eager catalogue order for caching and backwards compatibility.
    if (mode === 'eager')
      this.bindings.sort(
        (a, b) =>
          tools.findIndex((t) => t.name === a.name) - tools.findIndex((t) => t.name === b.name),
      );
  }

  render(allowed?: readonly string[]): OpenAI.Responses.Tool[] {
    const bindings =
      this.mode === 'deferred' && allowed
        ? this.bindings.filter((b) => allowed.includes(b.name))
        : this.bindings;
    const result: OpenAI.Responses.Tool[] = bindings
      .filter((b) => !b.namespace)
      .map((b) => b.definition);
    for (const [name, description] of this.namespaces) {
      const tools = bindings.filter((b) => b.namespace === name).map((b) => b.definition);
      if (tools.length) result.push({ type: 'namespace', name, description, tools });
    }
    if (result.some((tool) => tool.type === 'namespace')) result.push({ type: 'tool_search' });
    return result;
  }

  resolve(name: string, namespace: string | undefined, allowed: readonly string[]) {
    const binding = this.bindings.find((b) => b.name === name && b.namespace === namespace);
    if (!binding || !allowed.includes(binding.name))
      throw new GateRejection('UNAVAILABLE_MODEL_TOOL');
    return binding;
  }

  /**
   * Strict decoding. The provider enforces structure; constraints outside its subset are
   * checked here. A violation goes back to the model as a correctable tool error.
   */
  arguments(
    name: string,
    namespace: string | undefined,
    allowed: readonly string[],
    raw: string,
  ): DecodedArguments {
    const binding = this.resolve(name, namespace, allowed);
    const invalid = (errors: Array<{ path: string; rule: string }>): DecodedArguments => ({
      ok: false,
      invalid: { code: 'INVALID_ARGUMENTS', errors },
    });
    if (Buffer.byteLength(raw) > 100_000)
      return invalid([{ path: '/', rule: 'arguments exceed 100000 bytes' }]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return invalid([{ path: '/', rule: 'arguments are not valid JSON' }]);
    }
    try {
      return { ok: true, json: JSON.stringify(binding.decode(parsed)) };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'INVALID_STRICT_TOOL_ARGUMENTS')
        throw error;
      const errors = binding.errors(parsed);
      return invalid(errors.length ? errors : [{ path: '/', rule: 'does not match the schema' }]);
    }
  }

  validateSearchTools(tools: OpenAI.Responses.Tool[], allowed: readonly string[]) {
    const check = (
      tool: OpenAI.Responses.Tool | OpenAI.Responses.NamespaceTool.Function,
      namespace?: string,
    ) => {
      if (tool.type !== 'function') throw new GateRejection('UNEXPECTED_SEARCH_TOOL');
      const binding = this.resolve(tool.name, namespace, allowed);
      // Hosted search may omit this optional echo. The request declaration stays
      // strict, and returned parameters must still match the exact strict schema.
      if (
        tool.strict === false ||
        !isDeepStrictEqual(tool.parameters, binding.definition.parameters)
      )
        throw new GateRejection('CHANGED_SEARCH_SCHEMA');
    };
    for (const tool of tools) {
      if (tool.type === 'namespace') for (const child of tool.tools) check(child, tool.name);
      else check(tool);
    }
  }
}
