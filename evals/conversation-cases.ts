/** Behavioral scenarios derived from the reported failure and claudeconvo.md, with synthetic clients. */
import type { createSalesFixture } from '../scripts/lib/sales-fixture.js';
import type { ToolCheck } from './lib/tool-contracts.js';
import type { ContextReadTool } from '../src/modules/context-engine/context.types.js';
export type FixtureState = ReturnType<typeof createSalesFixture>['state'];
export const INITIAL_DEALS = 'Show the two latest new deals in RFQ Received that I can access.';
export const SHORTLIST =
  'give me 5 most appropriate warehouses per warehouse ID please\n\nand tell pros and cons';
export interface ConversationCase {
  id: string;
  turns: string[];
  expectation: string;
  supply?: boolean;
  ownerQuestions?: boolean;
  ordinal?: boolean;
  revoke?: boolean;
  change?: boolean;
  filler?: number;
  category?: 'assistant' | 'crm' | 'supply' | 'knowledge' | 'analytics' | 'boundaries';
  generic?: boolean;
  setup?: (state: FixtureState) => void;
  beforeTurn?: (index: number, state: FixtureState) => void;
  toolChecks?: ToolCheck[];
  traceChecks?: Array<{
    turn: number;
    name?: ContextReadTool | 'recall_business_context';
    phase?: 'executed' | 'proposed';
    min?: number;
    max?: number;
  }>;
  noReads?: boolean;
  allowedReads?: ContextReadTool[];
  contains?: RegExp[];
  excludes?: RegExp[];
  maxReplyChars?: number;
  group?: boolean;
  unavailableTurns?: number[];
}
export const CONVERSATION_CASES: ConversationCase[] = [
  {
    id: 'warehouse-provisional-brief-and-ordinal',
    generic: true,
    category: 'supply',
    setup: (state) => {
      state.messyWarehouseFacts = true;
    },
    turns: [
      'Find three suitable warehouses for Fixture Acme Storage using its full CRM requirement, with practical pros and cons. Missing paperwork should become a question, not exclude a candidate.',
      'Compare the second and third options you showed. Which would you visit first, and what should I ask each owner? Keep it short.',
    ],
    expectation:
      'Return a useful provisional shortlist based on the recorded distribution-hub narrative, not just area. Fully compliant has no defined checklist and is not established by a fire flag. The follow-up resolves the actual displayed second and third records and preserves their order. Recommend a visit with reasons supported by those records; never swap fire evidence between IDs, sum separate area options, invent acres, or withhold an otherwise useful answer for optional missing washroom/gate facts. Optional unknowns may be grouped into relevant owner questions. No writes or claims of live site verification.',
  },
  {
    id: 'warehouse-explicit-brief-correction',
    generic: true,
    category: 'supply',
    setup: (state) => {
      state.messyWarehouseFacts = true;
    },
    turns: [
      'Find three warehouse options for Fixture Acme Storage, keeping missing specifications as things to investigate.',
      'Correction: for this search I can accept 27,000 to 29,000 sq ft, and the use is indoor sports. Keep budget unspecified. Revise the recommendation and separate these changes from the CRM brief.',
    ],
    expectation:
      'Complete both turns with qualified, useful recommendations. Preserve the original recorded 25,000 sq ft distribution-hub brief while treating the new area range and indoor-sports use as explicit user overrides for this task. Do not claim the CRM was updated, infer a budget, silently combine offered-space options, or declare indoor-sports permissions confirmed. Explain material layout/use checks and retain plausible candidates with unknown specs instead of demanding a complete questionnaire.',
  },
  {
    id: 'warehouse-grouped-client-selection',
    generic: true,
    category: 'supply',
    setup: (state) => {
      state.messyWarehouseFacts = true;
    },
    turns: [
      'Give me two provisional warehouse options each for Fixture Acme Storage and Fixture Beacon Retail. Keep their CRM briefs and shortlists separate and number each list.',
      'Compare the second Acme option with the first Beacon option for their respective needs. Give one next action for each.',
    ],
    expectation:
      'Complete a separate two-item group per client, then preserve the exact historical group and ordinal bindings even if the same warehouse appears in both groups. Do not silently merge client narratives or substitute records by current search order. Use supported fields and label material unknowns. If a detail/assessment was never called, do not say it timed out; report only recorded execution limitations. Preserve useful partial evidence rather than replacing it with a generic verification failure.',
  },
  {
    id: 'deal-cards',
    turns: [INITIAL_DEALS],
    expectation:
      'Show Beacon then Acme by native creation date. Each deal has its name, Created and Last updated, without any deal UUID. Beacon created 13 Sep IST, Acme 1 Sep, both updated 29 Sep. Mark recorded requirements unconfirmed.',
  },
  {
    id: 'reported-shortlist',
    turns: [INITIAL_DEALS, SHORTLIST],
    supply: true,
    expectation:
      'Interpret the follow-up as five warehouse options for each of the two listed deals. Keep both deal names, dates and five distinct warehouse IDs per deal, with grounded pros and cons. Missing budget/fire/availability remain unknown, no generic intake restart and no invented CRM UUID in the answer.',
  },
  {
    id: 'ordinal-reference',
    turns: [
      INITIAL_DEALS,
      'For the second deal only, give me five warehouse options with pros and cons.',
    ],
    supply: true,
    ordinal: true,
    expectation:
      'Resolve the second listed deal as Acme, recall and search supply, and give options for Acme only. Do not ask which deal or require its ID. Preserve dates, warehouse IDs and specific pros/cons.',
  },
  {
    id: 'intervening-chat',
    turns: [
      INITIAL_DEALS,
      'Thanks. By the way, are you a bot?',
      'Now shortlist five warehouses for each of those deals, with pros and cons.',
    ],
    supply: true,
    expectation:
      'Ordinary intervening chat does not erase the two-deal selection. Show five distinct warehouse IDs for each deal, specific pros/cons and native CRM dates. Do not ask for already-known city/area/IDs.',
  },
  {
    id: '32-message-window',
    turns: [
      INITIAL_DEALS,
      'Back to those deals. Give five warehouse options for each, with pros and cons.',
    ],
    supply: true,
    filler: 14,
    expectation:
      'The original business answer is still within the last 32 messages after 14 ordinary turns. Recall both selected deals; give five options and pros/cons for each without restarting intake.',
  },
  {
    id: 'use-correction-owner-questions',
    turns: [
      INITIAL_DEALS,
      'For the second deal only, shortlist five warehouses with pros and cons.',
      'Correction: this client needs a regional EV spare-parts distribution hub, not a customer-facing showroom. No battery charging here. Give a short set of questions for the client, then owner questions separately for each shortlisted warehouse ID.',
    ],
    supply: true,
    ownerQuestions: true,
    expectation:
      'Keep Acme and the same shortlisted warehouse IDs. Accept distribution hub/no charging as user requirements, distinguish them from CRM facts. Focus on truck access, throughput, usable area, power needs and terms. Client questions and owner questions must be separate; owner questions are tied to the IDs and recorded unknowns. Do not invent battery charging, legal compliance, client identity or external research. No repetitive generic questionnaire.',
  },
  {
    id: 'revoked-history',
    turns: [INITIAL_DEALS, 'Show those deals again.'],
    revoke: true,
    expectation:
      'After the employee becomes inactive, withhold the previous private names and facts, explain missing access briefly, and make no business reads. Old conversation history is not a permission grant.',
  },
  {
    id: 'changed-history',
    turns: [INITIAL_DEALS, 'Show those deals again with the latest created and updated dates.'],
    change: true,
    expectation:
      'The fresh CRM page now contains only Beacon. Do not replay the obsolete Acme selection, claim both remain accessible or invent its latest dates. Show current permitted results, clearly explain the old selection changed if needed, and keep correct native dates.',
  },
];
