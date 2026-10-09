/** Application-owned presentation contracts. Tool metadata selects code; it cannot supply code. */
import { z } from 'zod';

export const PRESENTATION_META_KEY = 'wareongo/presentation-v1';
const metadataSchema = z
  .object({ adapter: z.string().min(1).max(80), renderer: z.string().min(1).max(80) })
  .strict();

/** Keep identity and paging alongside visible text so rendering never changes ordinal meaning. */
export interface ListPresentation {
  kind: 'list';
  heading: string;
  items: Array<{ id: string; version?: number; text: string }>;
  emptyText: string;
  footer?: string;
  page: { selectionId?: string; nextCursor: string | null };
}

// Add future document kinds here, with a renderer and a domain adapter. Rendering a
// document is deliberately separate from proving that it answers the entire request.
export type PresentationDocument = ListPresentation;
export interface PresentationAdapter {
  id: string;
  owner: string;
  tool: string;
  renderer: string;
  /** Validate the successful result AND its arguments. Undefined means normal graph fallback. */
  adapt(argumentsValue: unknown, result: unknown): PresentationDocument | undefined;
}
export interface PresentationRenderer {
  id: string;
  kind: PresentationDocument['kind'];
  render(document: PresentationDocument): string;
}
export interface RenderedToolPresentation {
  adapter: string;
  renderer: string;
  document: PresentationDocument;
  text: string;
}

/** Pure and order-preserving; used by normal replies and by storage's page-size calculation. */
export function renderListPresentation(document: ListPresentation): string {
  const body = document.items.length
    ? `${document.heading}\n${document.items.map((item, index) => `${index + 1}. ${item.text}`).join('\n')}`
    : document.emptyText;
  return body + (document.footer ? `${document.items.length ? '\n' : ' '}${document.footer}` : '');
}
export const listRenderer: PresentationRenderer = {
  id: 'list-v1',
  kind: 'list',
  render: renderListPresentation,
};

/**
 * Registration is local application code, never remote catalogue data or model output.
 * The caller supplies owner from the authenticated executor family, NOT from _meta.
 * Binding each adapter to owner + tool prevents another tool from borrowing a trusted
 * renderer by copying its metadata. Even a valid presentation grants no read, write,
 * completion or delivery authority; those checks remain with the owning runtime.
 */
export class ToolPresentationRegistry {
  private readonly adapters: Map<string, PresentationAdapter>;
  private readonly renderers: Map<string, PresentationRenderer>;
  constructor(adapters: PresentationAdapter[], renderers: PresentationRenderer[] = [listRenderer]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.renderers = new Map(renderers.map((renderer) => [renderer.id, renderer]));
    if (this.adapters.size !== adapters.length || this.renderers.size !== renderers.length)
      throw new Error('Duplicate presentation registration');
    for (const adapter of adapters)
      if (!this.renderers.has(adapter.renderer))
        throw new Error('Unregistered presentation renderer');
  }

  present(input: {
    owner: string;
    tool: {
      name: string;
      _meta?: Record<string, unknown>;
    };
    argumentsValue: unknown;
    result: unknown;
    maxCharacters: number;
  }): RenderedToolPresentation | undefined {
    const parsed = metadataSchema.safeParse(input.tool._meta?.[PRESENTATION_META_KEY]);
    if (!parsed.success) return undefined;
    const { adapter: adapterId, renderer: rendererId } = parsed.data;
    const adapter = this.adapters.get(adapterId);
    const renderer = this.renderers.get(rendererId);
    if (
      !adapter ||
      !renderer ||
      adapter.owner !== input.owner ||
      adapter.tool !== input.tool.name ||
      adapter.renderer !== rendererId ||
      !Number.isSafeInteger(input.maxCharacters) ||
      input.maxCharacters < 1
    )
      return undefined;
    // Unknown schemas, unsupported versions and malformed data lose the optimization;
    // they must never become an empty-list success or a partially rendered answer.
    try {
      const document = adapter.adapt(input.argumentsValue, input.result);
      if (!document || document.kind !== renderer.kind) return undefined;
      const text = renderer.render(document);
      if (!text.trim() || text.length > input.maxCharacters) return undefined;
      return { adapter: adapterId, renderer: rendererId, document, text };
    } catch {
      return undefined;
    }
  }
}
