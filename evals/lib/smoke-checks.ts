/** Outcome-level smoke checks: committed effects, record identity and honest status.
 * They never assert exact wording or tool order; the per-turn judge covers prose quality. */
import { UNAVAILABLE_REPLY } from '../../src/modules/assistant/assistant.service.js';
import {
  reviewFailure,
  reviewFailureReply,
} from '../../src/modules/assistant/review-diagnostics.js';
import { FIXTURE_EMPLOYEE } from '../../scripts/lib/sales-fixture.js';
import type { TranscriptFixture, TranscriptTurnView } from './transcript-trial.js';
import {
  truthfulConditionalLimitation,
  type PersistedPersonalState,
} from './scheduling-outcomes.js';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Every generic unavailable/review-failure reply the runtime substitutes for an answer. */
export const FALLBACK_REPLIES: readonly string[] = [
  ...new Set([
    UNAVAILABLE_REPLY,
    ...reviewFailure.options.flatMap((reason) =>
      [true, false].flatMap((hasEvidence) =>
        [true, false].map((researchExhausted) =>
          reviewFailureReply({ hasEvidence, reason, researchExhausted }),
        ),
      ),
    ),
  ]),
];
export const FALLBACK_REPLY = new RegExp(FALLBACK_REPLIES.map(escape).join('|'));
/** Blatant confirmed-save claims only; "can't confirm whether it was saved" is not a claim. */
export const RFQ_SUCCESS_CLAIM =
  /^[\s*_]*Saved RFQ\b|\bsuccessfully (?:saved|created|added)\b|\bI(?:'ve|’ve| have) (?:saved|created|added)\b|\b(?:is|was) now (?:saved|in (?:the )?CRM)\b/im;
/** A quantified area such as "20,000 sqft", "20k sq ft", "20,000+ sft" or "20000 sft". */
export const QUANTIFIED_AREA = /\d[\d,.]*\s*\+?\s*(?:k\b|sq|sft|square|ft²)/i;

export interface RfqSmokeEffects {
  /** Synthetic CRM records after each turn, including a committed-but-unconfirmed create. */
  rfqCounts: readonly number[];
  /** The next create on this turn commits in the synthetic CRM but returns an unknown outcome. */
  uncertainCreateTurn?: number;
  /** Exact excerpts the first saved RFQ description (raw_text) must contain. */
  sourceIncludes?: readonly string[];
  /** A populated extracted field must match (absent is always acceptable). */
  fieldPatterns?: Readonly<Record<string, RegExp>>;
  /** A populated extracted field must not match, e.g. invented precision. */
  forbiddenFieldPatterns?: Readonly<Record<string, RegExp>>;
  /** Turns whose reply must not claim a confirmed save. */
  noSuccessClaimTurns?: readonly number[];
  /** Turns allowed to finish with a non-completed trace outcome (still no fallback reply). */
  unavailableTurns?: readonly number[];
}

const supplied = (value: unknown) => value != null && !(typeof value === 'string' && !value.trim());
const asText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

export function rfqSmokeChecks(
  effects: RfqSmokeEffects,
  index: number,
  fixture: Pick<TranscriptFixture, 'state'>,
  turn: Pick<TranscriptTurnView, 'reply' | 'trace'>,
): string[] {
  const failures: string[] = [];
  const check = (ok: unknown, name: string) => {
    if (!ok) failures.push(`turn${index + 1}:${name}`);
  };
  const { rfqs, writes } = fixture.state;
  check(rfqs.length === effects.rfqCounts[index], 'rfq_effect_count');
  // A retry or receipt recovery must reuse the original operation, never a replacement create.
  check(
    writes
      .filter((w) => w.tool === 'create_crm_rfq' && w.result.outcome !== 'not_dispatched')
      .every((w) => rfqs.some((r) => r.operation_id === w.result.operation_id)),
    'retry_operation_identity',
  );
  check(!FALLBACK_REPLY.test(turn.reply), 'fallback_reply');
  if (!effects.unavailableTurns?.includes(index))
    check(turn.trace.outcome === 'completed', 'incomplete');
  if (effects.noSuccessClaimTurns?.includes(index))
    check(!RFQ_SUCCESS_CLAIM.test(turn.reply), 'false_success_claim');
  if (effects.uncertainCreateTurn !== undefined && index >= effects.uncertainCreateTurn)
    check(rfqs[0]?.uncertain, 'uncertain_create_exercised');
  const saved = rfqs[0];
  if (saved && index === effects.rfqCounts.findIndex((count) => count > 0)) {
    const raw = String(saved.args.raw_text ?? '');
    check(
      (effects.sourceIncludes ?? []).every((excerpt) => raw.includes(excerpt)),
      'full_brief_preserved',
    );
    for (const [field, pattern] of Object.entries(effects.fieldPatterns ?? {}))
      if (supplied(saved.args[field]))
        check(pattern.test(asText(saved.args[field])), `${field}_matches_source`);
    for (const [field, pattern] of Object.entries(effects.forbiddenFieldPatterns ?? {}))
      if (supplied(saved.args[field]))
        check(!pattern.test(asText(saved.args[field])), `${field}_not_invented`);
  }
  return failures;
}

export interface PersonalSmokeOutcome {
  /** Committed reminders after the turn. Zero also requires zero personal mutations. */
  reminders: 0 | 1;
  /** Saved reminder text must match, case-insensitively where the pattern says so. */
  reminderText?: RegExp;
  /** Independent expected due instant from the admitted member clocks. */
  dueAt?: (memberClocks: number[]) => string;
  /** The reply must state that conditional reminders are unsupported, without a workaround. */
  conditionalLimitation?: boolean;
}

export function personalSmokeChecks(
  scenario: { personal: PersonalSmokeOutcome; contains?: readonly RegExp[] },
  run: { reply?: string; persisted?: PersistedPersonalState; expectedDueAt?: string },
): string[] {
  const failures: string[] = [];
  const reply = run.reply ?? '';
  if (run.reply !== undefined) {
    if (FALLBACK_REPLY.test(reply)) failures.push('fallback_reply');
    for (const pattern of scenario.contains ?? [])
      if (!pattern.test(reply)) failures.push(`missing:${pattern.source}`);
    if (scenario.personal.conditionalLimitation && !truthfulConditionalLimitation(reply))
      failures.push('missing_truthful_conditional_limitation');
  }
  const persisted = run.persisted;
  // An unreadable store is already reported by the trial as persisted_outcome_unavailable.
  if (!persisted) return failures;
  const expected = scenario.personal.reminders;
  if (persisted.tasks !== 0) failures.push('unrequested_task_created');
  if (persisted.reminderDeliveries !== 0) failures.push('future_reminder_enqueued_early');
  if (persisted.reminders.length !== expected) failures.push('reminder_effect_count');
  if (persisted.commands !== expected)
    failures.push(expected ? 'expected_one_committed_command' : 'unexpected_personal_mutation');
  const saved = persisted.reminders[0];
  if (expected && saved) {
    if (
      scenario.personal.reminderText &&
      (typeof saved.text !== 'string' || !scenario.personal.reminderText.test(saved.text))
    )
      failures.push('reminder_text_not_preserved');
    if (run.expectedDueAt && saved.dueAt !== run.expectedDueAt)
      failures.push('wrong_resolved_instant');
    if (saved.owner !== FIXTURE_EMPLOYEE.employeeId || saved.state !== 'scheduled')
      failures.push('wrong_owner_or_state');
  }
  return failures;
}
