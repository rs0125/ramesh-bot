/** What review may conclude from a failed tool call: only outside actions are final. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { executionFailure } from '../../src/modules/assistant/answer-review.js';

test('only failures that need someone outside the chat are marked final for review', () => {
  // A GA4 access denial: no request from the chat can succeed until access is fixed.
  assert.deepEqual(
    executionFailure({
      ok: false,
      code: 'UNAVAILABLE',
      retryable: false,
      recovery: { sourceCode: 'ANALYTICS_SOURCE_DENIED', action: 'check_google_access' },
    }),
    { last_code: 'UNAVAILABLE', outside_action_required: 'check_google_access' },
  );
  assert.deepEqual(executionFailure({ ok: false, code: 'ACCESS_DENIED', retryable: false }), {
    last_code: 'ACCESS_DENIED',
    outside_action_required: 'access_denied',
  });
  // retryable=false only means "do not repeat unchanged": these can still be fixed in chat.
  for (const output of [
    { ok: false, code: 'INVALID_ARGUMENTS', retryable: false },
    { ok: false, code: 'RESPONSE_TOO_LARGE', retryable: false },
    { ok: false, code: 'UNAVAILABLE', retryable: false, recovery: { action: 'correct_query' } },
    { ok: false, code: 'RATE_LIMITED', retryable: true, recovery: { action: 'retry_later' } },
  ])
    assert.deepEqual(executionFailure(output), { last_code: output.code }, output.code);
  assert.deepEqual(executionFailure({ ok: true }), {});
});
