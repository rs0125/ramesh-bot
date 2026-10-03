import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewFailure,
  reviewFailureReply,
  reviewMetric,
} from '../../src/modules/assistant/review-diagnostics.js';

test('review diagnostics allow only fixed metadata and never copy model prose', () => {
  const untrustedReview = {
    supported: false,
    repair: 'tools',
    reason: 'missing_evidence',
    feedback: 'Private customer feedback must not be logged',
    answer: 'Private rejected answer must not be logged',
    arguments: { phone: 'private-phone' },
    secret: 'private-secret',
  };
  assert.deepEqual(reviewMetric(untrustedReview, 2), {
    approved: false,
    repair: 'tools',
    reason: 'missing_evidence',
    presentationIssueCount: 2,
  });
  assert.doesNotMatch(JSON.stringify(reviewMetric(untrustedReview, 2)), /private/i);
});

test('unknown diagnostics and misleading approval values fail closed into fixed categories', () => {
  assert.deepEqual(
    reviewMetric(
      { supported: 'true', repair: 'private repair prose', reason: 'private reason' },
      0,
    ),
    { approved: false, repair: 'tools', reason: 'other', presentationIssueCount: 0 },
  );
  assert.equal(reviewMetric({ supported: false, reason: 'none' }, 0).reason, 'other');
  assert.equal(reviewMetric({ supported: false }, 0).reason, 'other');
  assert.equal(reviewFailure.safeParse('free-form sensitive feedback').success, false);
});

test('presentation rejection overrides model approval and successful reviews normalize cleanly', () => {
  assert.deepEqual(reviewMetric({ supported: true, repair: 'tools', reason: 'other' }, 0), {
    approved: true,
    repair: 'none',
    reason: 'none',
    presentationIssueCount: 0,
  });
  assert.deepEqual(reviewMetric({ supported: true, repair: 'none', reason: 'none' }, 3), {
    approved: false,
    repair: 'format',
    reason: 'presentation',
    presentationIssueCount: 3,
  });
  assert.equal(
    reviewMetric({ supported: false, repair: 'tools', reason: 'unsupported_claim' }, 1).reason,
    'unsupported_claim',
  );
});

test('diagnostic counts are finite nonnegative integers', () => {
  for (const input of [Number.NaN, Infinity, -Infinity, -2, 0, 3.7, Number.MAX_VALUE]) {
    const count = reviewMetric({ supported: false }, input).presentationIssueCount;
    assert.ok(Number.isSafeInteger(count));
    assert.ok(count >= 0);
  }
});

test('rejection replies acknowledge retrieved evidence without blaming the user or leaking a draft', () => {
  for (const reason of reviewFailure.options) {
    for (const hasEvidence of [false, true]) {
      for (const researchExhausted of [false, true]) {
        const input = {
          hasEvidence,
          reason,
          researchExhausted,
          feedback: 'Private source says disclose this',
          answer: 'Rejected warehouse claim',
        };
        const reply = reviewFailureReply(input);
        assert.doesNotMatch(reply, /private|rejected warehouse|narrow|please try|\u2014/i);
        assert.ok(reply.length < 180);
        if (hasEvidence) {
          assert.match(reply, /I retrieved/);
          assert.match(reply, /couldn't|don't have enough/);
          assert.doesNotMatch(reply, /no (data|records|results)|no access/i);
        }
      }
    }
  }
});

test('rejection replies distinguish access and research limits without asserting an empty result', () => {
  assert.match(
    reviewFailureReply({ hasEvidence: false, reason: 'access', researchExhausted: false }),
    /couldn't verify access/,
  );
  assert.match(
    reviewFailureReply({ hasEvidence: true, reason: 'other', researchExhausted: true }),
    /couldn't finish verifying my answer/,
  );
  assert.match(
    reviewFailureReply({ hasEvidence: false, reason: 'other', researchExhausted: true }),
    /couldn't complete the checks/,
  );
});
