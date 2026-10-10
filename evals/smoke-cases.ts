/**
 * Fixed 12-case smoke suite, run on Luna (agent and grader) after every SALES_PROMPT_VERSION
 * bump. One trial per case, no reruns of failures. Exact command, from the repository root:
 *
 *   TEST_MESSAGE_DATABASE_URL=<local ramesh_queue_test URL> \
 *     npx tsx evals/conversation-run.ts --suite smoke --max-trials 12 --max-usd 2
 *
 * `--max-trials 12` is required: the default allowance is three scenario executions.
 * Add `--list` to print the IDs without a key, model client, usage meter or database.
 * The local PostgreSQL URL follows docs/supabase-message-queue.md#verification; the fixture
 * refuses non-loopback hosts. A reviewed EVAL_USAGE_PRICES_JSON profile is also required.
 *
 * One runner composes three existing execution paths, chosen per case by `runner`:
 * - conversation: the conversation-run loop over the in-memory sales fixture (reads only).
 * - transcript: runTranscriptTrial over the synthetic CRM write fixture (RFQ effects).
 * - scheduling: the scheduling trial (personal tools need a leased row in a disposable
 *   local PostgreSQL queue), optionally composed with the sales fixture's CRM reads.
 *
 * Assertions are outcome-level: committed RFQ/reminder counts, saved record identity, no false
 * success claims and no generic fallback reply. Wording and tool order are left to the judge.
 * All data is fictional. Phone-like values are XXXX placeholders, never plausible numbers.
 */
import type { ConversationCase } from './conversation-cases.js';
import type { TranscriptCase } from './transcript-cases.js';
import {
  QUANTIFIED_AREA,
  type PersonalSmokeOutcome,
  type RfqSmokeEffects,
} from './lib/smoke-checks.js';
import { istInstant } from './lib/scheduling-outcomes.js';

export type SmokeConversationCase = ConversationCase & {
  runner: 'conversation';
  expectations: readonly string[];
};
export interface SmokeRfqCase extends TranscriptCase {
  runner: 'transcript';
  mode: 'rfq';
  category: 'crm';
  effects: RfqSmokeEffects;
}
export interface SmokePersonalCase {
  runner: 'scheduling';
  id: string;
  category: 'assistant' | 'crm';
  /** One admitted inbound turn. */
  turns: readonly [string];
  expectations: readonly [string];
  /** Compose the sales fixture's CRM reads with personal tools (mixed requests). */
  businessReads?: boolean;
  personal: PersonalSmokeOutcome;
  contains?: readonly RegExp[];
}
export type SmokeCase = SmokeConversationCase | SmokeRfqCase | SmokePersonalCase;

/** Cases that do not run in the conversation loop itself. */
export function isDelegatedSmokeCase(scenario: {
  id: string;
}): scenario is SmokeRfqCase | SmokePersonalCase {
  return (
    'runner' in scenario && (scenario.runner === 'transcript' || scenario.runner === 'scheduling')
  );
}

const conversation = (
  scenario: Omit<SmokeConversationCase, 'runner' | 'generic' | 'expectation'>,
): SmokeConversationCase => ({
  ...scenario,
  runner: 'conversation',
  // Generic: skip the deal-card checks the conversation runner applies to legacy cases.
  generic: true,
  expectation: scenario.expectations.join(' '),
});
const rfq = (scenario: Omit<SmokeRfqCase, 'runner' | 'mode' | 'category'>): SmokeRfqCase => ({
  ...scenario,
  runner: 'transcript',
  mode: 'rfq',
  category: 'crm',
});

/** Native IST calendar date in common renderings, e.g. "13 Sep", "Sep 13, 2026", "2026-09-13". */
const septemberDay = (day: number) =>
  new RegExp(
    `\\b${day}(?:st|nd|rd|th)?\\s+Sep(?:t(?:ember)?)?\\b|\\bSep(?:t(?:ember)?)?\\.?\\s+${day}(?:st|nd|rd|th)?\\b|\\b2026-09-${day}\\b|\\b${day}[/.-]0?9[/.-]2026\\b`,
    'i',
  );

const ORION_BRIEF = `Company: Fixture Orion Foods
POC: Fixture Contact
Industry: FMCG
Location: Chennai
Micro market: Sriperumbudur
Requirement: 40,000 sft
Use: ambient food distribution
Duration: Long term
Budget: market rate`;
const LOTUS_BRIEF =
  'Fixture Lotus Traders ko FMCG storage ke liye warehouse chahiye, 2 trucks ki parking zaroori hai. Location aur size baad mein bataunga.';
const HARBOR_BRIEF = `Company: Fixture Harbor Pharma
POC: Fixture Contact
Location: Hyderabad
Micro market: Shamshabad
Requirement: 15,000 sft
Use: pharma distribution with racking
Duration: 3 years`;
/** Deliberately non-dialable UAE-format placeholder. */
const FOREIGN_PHONE = '+971 5X XXX XXXX';
const ATLAS_BRIEF = `Company: Fixture Atlas Exports
POC: Fixture Contact, ${FOREIGN_PHONE}
Location: Pune
Requirement: at least 20,000 sqft
Use: export packaging and dispatch`;

export const SMOKE_CASES: readonly SmokeCase[] = [
  conversation({
    id: 'smoke-01-greeting',
    category: 'assistant',
    turns: ['Hi Ramesh, good morning! How are you doing today?'],
    noReads: true,
    expectations: [
      'Small talk only. Reply warmly and briefly as Ramesh, optionally offering help. No business lookups are needed; do not invent tasks, reminders, CRM facts or checks that were not performed.',
    ],
  }),
  conversation({
    id: 'smoke-02-crm-followups-today',
    category: 'crm',
    turns: ['What are my follow-ups today?'],
    contains: [/Acme/],
    excludes: [/Beacon/],
    expectations: [
      'Answer from current permitted CRM evidence. Fixture Acme Storage is the only follow-up due today (10:00 IST). Fixture Beacon Retail is due tomorrow and two enquiries are overdue; overdue items may be mentioned as overdue, but nothing else may be presented as due today. No invented follow-ups and no deal UUIDs.',
    ],
  }),
  conversation({
    id: 'smoke-03-warehouse-locality',
    category: 'supply',
    turns: ['Show me available warehouses in Chakan.'],
    contains: [/\b10[6-9]\b/],
    expectations: [
      'Search permitted inventory for the Chakan locality (Pune). The synthetic inventory has four Chakan warehouses, IDs 106 to 109. Show grounded options with IDs and recorded facts such as area, docks and clear height. Never present an unrecorded field as known; saying that key details such as rates need confirming is enough, without listing every field the records lack. Do not invent listings, present Hoskote/Bengaluru records as Chakan, or claim site verification.',
    ],
  }),
  conversation({
    id: 'smoke-04-compare-no-preference',
    category: 'supply',
    turns: [
      'I have shortlisted warehouses 106 and 108 in Chakan. I have no preference between them yet. Compare them for me.',
    ],
    contains: [/\b106\b/, /\b108\b/],
    expectations: [
      'Compare the two recorded warehouses with a real trade-off. Warehouse 108 is larger (33,000 vs 31,000 sq ft) with more docks and a higher clear height; several other details are not recorded for either. Flagging that unrecorded details need confirming is enough; do not fail the answer for leaving out any particular missing field. The user stated no requirement or preference, so a bigger number is not automatically better: do not declare a winner on size or dock count alone. Explain what the choice depends on (needed area, budget, throughput) or ask one focused question. No invented rent or compliance.',
    ],
  }),
  rfq({
    id: 'smoke-05-rfq-explicit-full-brief',
    provenance:
      'Synthetic smoke case: explicit save request carrying a complete brief; one direct create.',
    turns: [`Please add this to CRM as a new RFQ:\n${ORION_BRIEF}`],
    effects: {
      rfqCounts: [1],
      sourceIncludes: [ORION_BRIEF],
      fieldPatterns: {
        location: /Chennai|Sriperumbudur/i,
        city: /Chennai/i,
        micro_market: /Sriperumbudur/i,
        requirement: /40,?000|40\s*k\b/i,
        budget: /market rate/i,
        lease_duration: /LONG_TERM/,
      },
    },
    expectations: [
      'Explicit save request with a complete brief. Save exactly one new RFQ in this turn without a further confirmation or questions about optional fields. The full original brief becomes the description; any extracted fields must match it (Chennai, Sriperumbudur, 40,000 sft, long term, market rate). Report only the authoritative saved result, without claiming assignment, notifications or follow-up actions.',
    ],
  }),
  rfq({
    id: 'smoke-06-rfq-hinglish-incomplete',
    provenance:
      'Synthetic smoke case: Hinglish brief with location and size explicitly deferred, plus an explicit save request.',
    turns: [`Ek naya RFQ save kar do: ${LOTUS_BRIEF}`],
    effects: {
      rfqCounts: [1],
      sourceIncludes: [LOTUS_BRIEF],
      forbiddenFieldPatterns: { requirement: QUANTIFIED_AREA },
    },
    expectations: [
      'Explicit Hinglish save request. Location and size will be shared later, and that is acceptable: save exactly one RFQ now with the full original text as the description, without a questionnaire about missing optional fields. Do not invent a location, size or budget. Natural Hinglish or English replies are both fine; report only the authoritative saved result.',
    ],
  }),
  // depends on owner decision D2 (clarification rule): the first-turn offer may be a single
  // yes/no save question or name alternatives. Only no write on turn 1 and exactly one RFQ
  // after "yes" are asserted; revisit if D2 makes "yes" after alternatives ambiguous by design.
  rfq({
    id: 'smoke-07-rfq-save-offer-yes',
    provenance:
      'Synthetic smoke case: RFQ brief without an action request, then a bare yes to the save offer.',
    turns: [HARBOR_BRIEF, 'yes'],
    effects: {
      rfqCounts: [0, 1],
      sourceIncludes: [HARBOR_BRIEF],
      noSuccessClaimTurns: [0],
    },
    expectations: [
      'The user pasted an RFQ brief without asking for an action. Do not save anything yet and do not imply that anything was saved. Offer to save it as a new CRM requirement; the exact form of the offer is an open owner decision, so judge only that the offer is clear and does not start a questionnaire.',
      'Yes accepts the preceding save offer. Save exactly one RFQ with the full original brief as the description, without another confirmation or questions about optional fields, and report only the authoritative result.',
    ],
  }),
  rfq({
    id: 'smoke-08-rfq-bounded-foreign-retry',
    provenance:
      'Synthetic smoke case: bounded area, a foreign-format placeholder phone, an uncertain create receipt, then a bare retry.',
    turns: [`Save this as a new RFQ:\n${ATLAS_BRIEF}`, 'retry'],
    effects: {
      rfqCounts: [1, 1],
      uncertainCreateTurn: 0,
      sourceIncludes: ['at least 20,000 sqft', FOREIGN_PHONE],
      fieldPatterns: {
        requirement: /at least|min(?:imum)?|\+|≥|>=|or more|above|upwards/i,
        poc_phone: /^\s*(?:\+|00)\s*971/,
      },
      noSuccessClaimTurns: [0, 1],
    },
    expectations: [
      'Explicit save request. Save the RFQ with the full brief. The area is a lower bound ("at least 20,000 sqft"), so any extracted requirement keeps the bound rather than an exact 20,000. The contact number is a UAE-format placeholder: never convert it into or save it as an Indian number; it may remain only in the brief. This synthetic create returns an unknown outcome: say the result cannot be confirmed yet, without claiming success or proving that nothing was created.',
      'Retry refers to the uncertain request above. Reconcile the same operation rather than creating a replacement, and never report a duplicate save. If the outcome is still unknown, say so plainly and explain how it will be reconciled, without asking the user to send retry again.',
    ],
  }),
  {
    runner: 'scheduling',
    id: 'smoke-09-reminder-letter-case',
    category: 'assistant',
    turns: ['Remind me tomorrow at 5 pm to Call Ravi.'],
    personal: {
      reminders: 1,
      reminderText: /\bcall ravi\b/i,
      dueAt: (clocks) => istInstant(clocks.at(-1)!, 1, '17:00'),
    },
    expectations: [
      'Explicit reminder request. Save exactly one reminder for tomorrow at 5:00 pm IST to call Ravi; the saved text may differ from the message in letter case. Acknowledge the saved time. Do not refuse, ask for confirmation or create an extra task.',
    ],
  },
  {
    runner: 'scheduling',
    id: 'smoke-10-tasks-and-followups',
    category: 'crm',
    businessReads: true,
    turns: ['Show my task list and my follow-ups today.'],
    personal: { reminders: 0 },
    contains: [/Acme/, /\btasks?\b/i],
    expectations: [
      'Answer both parts in one reply. This synthetic owner has no open personal tasks, so say the task list is empty; an empty list is not a failure. From CRM, Fixture Acme Storage is the only follow-up due today. Do not create, complete or change tasks or reminders, and do not give a generic failure for either part.',
    ],
  },
  conversation({
    id: 'smoke-11-iso-date-answer',
    category: 'crm',
    turns: ['When was Fixture Beacon Retail created in CRM, and when was it last updated?'],
    contains: [septemberDay(13), septemberDay(29)],
    expectations: [
      'Deliver the answer itself, not a verification failure. The native CRM creation instant 2026-09-12T21:30Z is 13 Sep 2026 (about 03:00) in IST, and the last update is 29 Sep 2026 (19:00 IST). Do not shift the creation date to 12 Sep or substitute mirror or polling times.',
    ],
  }),
  {
    runner: 'scheduling',
    id: 'smoke-12-conditional-reminder',
    category: 'assistant',
    turns: [
      "Remind me tomorrow at 9 am to call the owner, but only if the owner hasn't replied by then.",
    ],
    personal: { reminders: 0, conditionalLimitation: true },
    expectations: [
      'Conditional reminders are not supported yet. Say so clearly and briefly. Do not save a reminder with the condition dropped, do not suggest a workaround such as another account, extra permission or later automatic checking, and do not say the reminder is set. Offering a plain reminder that is created only if the user explicitly accepts it is fine.',
    ],
  },
];
