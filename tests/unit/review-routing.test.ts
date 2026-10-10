/** The post-review decision table: every rule is reachable, and the table matches the nested logic it replaced. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  afterReview,
  REVIEW_ROUTES,
  type ReviewRoutingState,
} from '../../src/modules/assistant/review-routing.js';

// The conditional edge as it stood before the table (sales.graph.ts at 6b15b2c).
function previous(s: ReviewRoutingState) {
  return s.approved || s.repairs >= 2
    ? 'finish'
    : s.reviewPatched
      ? 'verifier'
      : s.narrowed
        ? 'planner'
        : s.repairKind === 'evidence'
          ? s.evidenceRepairs < 1
            ? 'evidence_repair'
            : 'finish'
          : s.canResearch && s.repairKind !== 'format'
            ? s.canRevise
              ? 'revise'
              : 'planner'
            : s.repairKind === 'format'
              ? 'formatter'
              : s.evidenceRepairs < 1
                ? 'evidence_repair'
                : 'finish';
}

function* states(): Generator<ReviewRoutingState> {
  const bools = [false, true];
  for (const approved of bools)
    for (const repairs of [0, 1, 2])
      for (const reviewPatched of bools)
        for (const narrowed of bools)
          for (const repairKind of ['none', 'format', 'evidence', 'tools'] as const)
            for (const evidenceRepairs of [0, 1])
              for (const canResearch of bools)
                for (const canRevise of bools)
                  yield {
                    approved,
                    repairs,
                    reviewPatched,
                    narrowed,
                    repairKind,
                    evidenceRepairs,
                    canResearch,
                    canRevise,
                  };
}

test('the decision table matches the nested conditional for every input combination', () => {
  let count = 0;
  for (const state of states()) {
    assert.equal(afterReview(state).next, previous(state), JSON.stringify(state));
    count++;
  }
  assert.equal(count, 2 * 3 * 2 * 2 * 4 * 2 * 2 * 2);
});

test('every rule is reachable and named', () => {
  const reached = new Set<string>();
  for (const state of states()) reached.add(afterReview(state).name);
  assert.deepEqual([...reached].sort(), REVIEW_ROUTES.map((route) => route.name).sort());
});

const base: ReviewRoutingState = {
  approved: false,
  repairs: 0,
  reviewPatched: false,
  narrowed: false,
  repairKind: 'tools',
  evidenceRepairs: 0,
  canResearch: true,
  canRevise: true,
};

test('each rule names the path it takes', () => {
  const cases: Array<[Partial<ReviewRoutingState>, string, string]> = [
    [{ approved: true }, 'approved, or review passes used up', 'finish'],
    [{ repairs: 2 }, 'approved, or review passes used up', 'finish'],
    [{ reviewPatched: true }, 'review the reviewer patch', 'verifier'],
    [{ narrowed: true }, 'widen a narrowed route', 'planner'],
    [{ repairKind: 'evidence' }, 'correct from existing evidence', 'evidence_repair'],
    [{ repairKind: 'evidence', evidenceRepairs: 1 }, 'evidence correction already used', 'finish'],
    [{}, 'research more in the same session', 'revise'],
    [{ canRevise: false }, 'research more with a new plan', 'planner'],
    [{ repairKind: 'format' }, 'fix wording only', 'formatter'],
    [{ canResearch: false }, 'research ended: correct from evidence', 'evidence_repair'],
    [{ canResearch: false, evidenceRepairs: 1 }, 'nothing left to try', 'finish'],
  ];
  for (const [change, name, next] of cases) {
    const route = afterReview({ ...base, ...change });
    assert.deepEqual([route.name, route.next], [name, next], JSON.stringify(change));
  }
});
