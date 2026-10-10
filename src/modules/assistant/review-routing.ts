/**
 * What happens after an answer review, as an ordered decision table. The first matching rule
 * wins. Inputs are computed by the graph from its counters, budgets and deadline, so this table
 * stays pure and every path is unit-tested by name.
 */
export type ReviewNext =
  | 'finish'
  | 'verifier'
  | 'planner'
  | 'evidence_repair'
  | 'revise'
  | 'formatter';

export interface ReviewRoutingState {
  approved: boolean;
  /** Completed review passes before this decision (the allowance is two). */
  repairs: number;
  /** The reviewer supplied an exact patch that still needs its own review. */
  reviewPatched: boolean;
  /** A rejected direct or personal-only route that can be widened to all tools. */
  narrowed: boolean;
  repairKind: 'none' | 'format' | 'evidence' | 'tools';
  evidenceRepairs: number;
  /** Research is still allowed: not exhausted, before the deadline, tools and steps remain. */
  canResearch: boolean;
  /** The worker session can continue in place (not a clarification plan). */
  canRevise: boolean;
}

export interface ReviewRoute {
  name: string;
  when: (state: ReviewRoutingState) => boolean;
  next: ReviewNext;
}

export const REVIEW_ROUTES: readonly ReviewRoute[] = [
  {
    name: 'approved, or review passes used up',
    when: (s) => s.approved || s.repairs >= 2,
    next: 'finish',
  },
  { name: 'review the reviewer patch', when: (s) => s.reviewPatched, next: 'verifier' },
  { name: 'widen a narrowed route', when: (s) => s.narrowed, next: 'planner' },
  {
    name: 'correct from existing evidence',
    when: (s) => s.repairKind === 'evidence' && s.evidenceRepairs < 1,
    next: 'evidence_repair',
  },
  {
    name: 'evidence correction already used',
    when: (s) => s.repairKind === 'evidence',
    next: 'finish',
  },
  {
    name: 'research more in the same session',
    when: (s) => s.repairKind !== 'format' && s.canResearch && s.canRevise,
    next: 'revise',
  },
  {
    name: 'research more with a new plan',
    when: (s) => s.repairKind !== 'format' && s.canResearch,
    next: 'planner',
  },
  { name: 'fix wording only', when: (s) => s.repairKind === 'format', next: 'formatter' },
  {
    name: 'research ended: correct from evidence',
    when: (s) => s.evidenceRepairs < 1,
    next: 'evidence_repair',
  },
  { name: 'nothing left to try', when: () => true, next: 'finish' },
];

export function afterReview(state: ReviewRoutingState): ReviewRoute {
  return REVIEW_ROUTES.find((route) => route.when(state))!;
}
