import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { containsUserText } from '../../src/modules/messaging/source-text.js';

// Context Engine runs the same file against hasSourceExcerpt; keep both copies identical.
test('shared authorship vectors match Context Engine', async () => {
  const { vectors } = JSON.parse(
    await readFile('tests/fixtures/source-text-vectors.json', 'utf8'),
  ) as { vectors: Array<{ name: string; source: string; excerpt: string; expected: boolean }> };
  assert.ok(vectors.length >= 10);
  for (const vector of vectors)
    assert.equal(containsUserText(vector.source, vector.excerpt), vector.expected, vector.name);
});

test('a reminder quote that differs only in case or spacing is still the user’s text', () => {
  assert.equal(containsUserText('remind me at 5 pm to Call Ravi', 'call ravi'), true);
  assert.equal(containsUserText('remind me at 5 pm to call  Ravi', 'Call Ravi'), true);
  // Different words are still rejected.
  assert.equal(containsUserText('remind me at 5 pm to call Ravi', 'call Raj'), false);
  assert.equal(containsUserText('remind me at 5 pm to call Ravi', 'all Ravi'), false);
});
