import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceInputReplies } from '../../src/modules/media/voice-input.js';

test('transcript presentation preserves exact whitespace, markup and Unicode', () => {
  const text = '  Ask about “open_area”\nहिन्दी 🙂 *literal*  ';
  assert.deepEqual(voiceInputReplies(text), [`_"${text}"_`]);
});

test('long transcript is split without losing text or breaking Unicode', () => {
  const text = 'a'.repeat(14999) + '🙂' + '\nZ'.repeat(2000);
  const replies = voiceInputReplies(text);
  assert.equal(replies.length, 2);
  assert.ok(replies.every((reply) => reply.length <= 16000));
  const reconstructed = replies.map((reply) => reply.slice(reply.indexOf('_"') + 2, -2)).join('');
  assert.equal(reconstructed, text);
  assert.ok(!/[\uD800-\uDBFF]"_$/.test(replies[0]!));
});
