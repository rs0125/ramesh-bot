/** Provider presentation only: definitions and capability membership come from discovery. */
import { isDeepStrictEqual } from 'node:util';
import type OpenAI from 'openai';
import type { ToolSessionRequest } from '../../modules/assistant/assistant.types.js';

type Binding = { name: string; namespace?: string; definition: OpenAI.Responses.FunctionTool };
export class OpenAIToolCatalog {
  readonly bindings: Binding[] = [];
  private readonly namespaces = new Map<string, string>();

  constructor(
    tools: ToolSessionRequest['tools'],
    readonly mode: 'eager' | 'deferred',
  ) {
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      throw new Error('AMBIGUOUS_TOOL_CATALOGUE');
    const counts = new Map<string, number>();
    for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      let namespace: string | undefined;
      if (mode === 'deferred' && tool.discovery?.loading === 'deferred') {
        const { capability, description } = tool.discovery;
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(capability) || !description || description.length > 512)
          throw new Error('INVALID_TOOL_DISCOVERY');
        const count = counts.get(capability) ?? 0;
        // Bounded groups; membership is generated, never a second business-tool registry.
        namespace = `ce_${capability}_${Math.floor(count / 8) + 1}`;
        counts.set(capability, count + 1);
        if (this.namespaces.has(namespace) && this.namespaces.get(namespace) !== description)
          throw new Error('AMBIGUOUS_TOOL_CAPABILITY');
        this.namespaces.set(namespace, description);
      }
      this.bindings.push({
        name: tool.name,
        ...(namespace ? { namespace } : {}),
        definition: {
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: structuredClone(tool.inputSchema),
          strict: false,
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
    if (!binding || !allowed.includes(binding.name)) throw new Error('UNAVAILABLE_MODEL_TOOL');
    return binding;
  }

  validateSearchTools(tools: OpenAI.Responses.Tool[], allowed: readonly string[]) {
    const check = (
      tool: OpenAI.Responses.Tool | OpenAI.Responses.NamespaceTool.Function,
      namespace?: string,
    ) => {
      if (tool.type !== 'function') throw new Error('UNEXPECTED_SEARCH_TOOL');
      const binding = this.resolve(tool.name, namespace, allowed);
      if (!isDeepStrictEqual(tool.parameters, binding.definition.parameters))
        throw new Error('CHANGED_SEARCH_SCHEMA');
    };
    for (const tool of tools) {
      if (tool.type === 'namespace') for (const child of tool.tools) check(child, tool.name);
      else check(tool);
    }
  }
}
