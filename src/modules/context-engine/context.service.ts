/** Thin domain services for future agents. Nothing imports these into the chat graph yet. */
import type { ContextReadTool, ContextSender, ContextToolGateway } from './context.types.js';

export type ReadFilters = Record<
  string,
  string | number | boolean | string[] | number[] | undefined
>;
export type LeadContextSection = 'notes' | 'tasks' | 'company' | 'stage_history';

export class ContextEngineServices {
  constructor(private readonly gateway: ContextToolGateway) {}

  forSender(sender: ContextSender) {
    const identity = Object.freeze({ ...sender });
    const read = (
      tool: ContextReadTool,
      input: Record<string, unknown> = {},
      signal?: AbortSignal,
    ) => this.gateway.call(identity, tool, input, signal);
    return {
      discover: (signal?: AbortSignal) => this.gateway.discover(identity, signal),
      context: (signal?: AbortSignal) => read('get_context', {}, signal),
      crm: {
        filters: (input: ReadFilters = {}, signal?: AbortSignal) =>
          read('crm_filters', input, signal),
        search: (input: ReadFilters = {}, signal?: AbortSignal) =>
          read('search_crm_leads', input, signal),
        readLead: (id: string, signal?: AbortSignal) => read('read_crm_lead', { id }, signal),
        leadContext: (
          id: string,
          section: LeadContextSection,
          page: { limit?: number; cursor?: string } = {},
          signal?: AbortSignal,
        ) => read('read_crm_lead_context', { ...page, id, section }, signal),
        summary: (input: ReadFilters = {}, signal?: AbortSignal) =>
          read('crm_summary', input, signal),
        briefing: (signal?: AbortSignal) => read('crm_briefing', {}, signal),
        assessShortlist: (
          leadId: string,
          warehouseIds: number[] = [],
          criteria: ReadFilters = {},
          signal?: AbortSignal,
        ) =>
          read(
            'assess_shortlist',
            {
              ...criteria,
              lead_id: leadId,
              ...(warehouseIds.length ? { warehouse_ids: warehouseIds } : {}),
            },
            signal,
          ),
      },
      supply: {
        filters: (input: ReadFilters = {}, signal?: AbortSignal) =>
          read('warehouse_filters', input, signal),
        search: (input: ReadFilters = {}, signal?: AbortSignal) =>
          read('search_warehouses', input, signal),
        readWarehouse: (id: number, signal?: AbortSignal) => read('read_warehouse', { id }, signal),
        summary: (input: ReadFilters = {}, signal?: AbortSignal) =>
          read('warehouse_summary', input, signal),
      },
      knowledge: {
        search: (
          input: { q?: string; limit?: number; cursor?: string } = {},
          signal?: AbortSignal,
        ) => read('search_knowledge', input, signal),
        readPage: (id: string, signal?: AbortSignal) => read('read_knowledge', { id }, signal),
      },
    };
  }
}
