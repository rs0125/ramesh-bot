/** Public fictional outcomes; no production customer data or prescribed call sequence. */
import type { ConversationCase } from './conversation-cases.js';
import { ContextEngineError } from '../src/modules/context-engine/context.types.js';

const broad = (state: Parameters<NonNullable<ConversationCase['setup']>>[0]) => {
  state.warehouseCount = 75;
};
const largest =
  'Review all accessible warehouses in Bengaluru and give me the one with the largest recorded area, its warehouse ID, one caveat and the number of unique listings reviewed.';

export const PAGINATION_CASES: ConversationCase[] = [
  {
    id: 'pagination-bounded-pool',
    category: 'supply',
    generic: true,
    turns: [
      'Review the 60 newest warehouses in Bengaluru by their creation date. From those 60, shortlist the five largest by recorded area with IDs, areas and one caveat each. State how many unique listings you reviewed.',
    ],
    setup: broad,
    expectation:
      'Review 60 distinct newest listings, then rank within that pool: IDs 160,159,158,157,156, with areas 85000,84000,83000,82000,81000 sqft. Do not include older ID175 just because it is bigger. Preserve unverified specifications/availability. No claim of ranking all inventory.',
    contains: [/\b160\b/, /\b156\b/, /\b60\b/],
    excludes: [/\b175\b/],
    maxReplyChars: 3200,
  },
  {
    id: 'pagination-late-best',
    category: 'supply',
    generic: true,
    turns: [largest],
    setup: broad,
    expectation:
      'Inspect the complete 75-row matching set and identify ID175, 100000 sqft, as the largest recorded area, with current availability unconfirmed. Do not stop after a plausible first-page winner.',
    contains: [/\b175\b/, /\b75\b/],
    maxReplyChars: 2200,
  },
  {
    id: 'pagination-overlap',
    category: 'supply',
    generic: true,
    turns: [largest],
    setup(state) {
      broad(state);
      state.warehousePageOverlap = true;
    },
    expectation:
      'The source repeats boundary rows. Count 75 unique listings rather than summed page lengths, choose ID175 with 100000 sqft, retain uncertainty and do not present duplicates as additional options.',
    contains: [/\b175\b/, /\b75\b/],
    maxReplyChars: 2200,
  },
  {
    id: 'pagination-empty-continuation',
    category: 'supply',
    generic: true,
    turns: [largest],
    setup(state) {
      broad(state);
      state.mutate = (result, tool, args) => {
        if (tool === 'search_warehouses' && args.cursor === undefined) {
          result.data.items = [];
          result.data.nextCursor = 'fixture:0';
          Object.assign(result.data.query_context as object, { returned_count: 0, has_more: true });
        }
      };
    },
    expectation:
      'Continue past the empty first page because it has a cursor. Inspect 75 unique rows and report ID175, 100000 sqft, with uncertainty. Empty initial output is not no matches.',
    contains: [/\b175\b/, /\b75\b/],
    maxReplyChars: 2200,
  },
  {
    id: 'pagination-interrupted',
    category: 'supply',
    generic: true,
    turns: [largest],
    setup(state) {
      broad(state);
      state.mutate = (_result, tool, args) => {
        if (tool === 'search_warehouses' && args.cursor !== undefined)
          throw new ContextEngineError('UNAVAILABLE');
      };
    },
    expectation:
      'Retain useful first-page work and name the largest of the rows actually returned, explicitly provisional within an incomplete review because later reads failed. Do not report zero warehouses, a global winner or all 75 inspected.',
    maxReplyChars: 2200,
  },
  {
    id: 'pagination-cycle',
    category: 'supply',
    generic: true,
    turns: [largest],
    setup(state) {
      broad(state);
      state.mutate = (result, tool, args) => {
        if (tool === 'search_warehouses' && args.cursor !== undefined) {
          result.data.nextCursor = args.cursor;
          Object.assign(result.data.query_context as object, { has_more: true });
        }
      };
    },
    expectation:
      'A repeated continuation prevents full traversal. Return a useful provisional best among the unique rows obtained and explain partial coverage, without changing page size to loop or claiming a complete inventory review.',
    maxReplyChars: 2200,
  },
];
