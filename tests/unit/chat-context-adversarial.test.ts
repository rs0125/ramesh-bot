import test from 'node:test';
import assert from 'node:assert/strict';
import { contextFixture, contextId, CONTEXT_CHAT, CONTEXT_DAY } from '../fixtures/chat-context.js';
import { contextTokens } from '../../src/modules/assistant/chat-context.js';
import { MAX_REPLY_CHARACTERS } from '../../src/modules/media/voice-reply.js';
import {
  contextDeliveryBundle,
  contextDeliveryBundleSchema,
  getBusinessReply,
} from '../../src/modules/messaging/delivery-evidence.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';

test('literal tokenizer markers remain ordinary text through repeated turns', async () => {
  const f = contextFixture();
  await f.context.prepare(...f.turn(1, '/pins'));
  const markers = 'Please explain <|endoftext|> and <|endofprompt|> as literal strings.';
  assert.ok(contextTokens(markers) > 0);
  f.add(2, { role: 'user', content: markers });
  for (const n of [3, 4]) {
    const [message, trusted, signal] = f.turn(n, 'Hello again');
    assert.equal((await f.service.prepare(message, signal, trusted)).trace.outcome, 'completed');
  }
  const history = f.requests.filter((request) => request.stage === 'converser');
  assert.equal(history.length, 2);
  assert.ok(
    history.every((request) => request.messages.some((message) => message.content === markers)),
  );
});

test('a rejected oversized message cannot poison future turns or prevent compaction', async () => {
  const f = contextFixture();
  await f.context.prepare(...f.turn(1, '/pins'));
  const content = 'word '.repeat(16000);
  const [message, trusted, signal] = f.turn(2, content);
  assert.equal((await f.service.prepare(message, signal, trusted)).trace.outcome, 'input_rejected');
  f.add(2, { role: 'user', content });
  const next = await f.context.prepare(...f.turn(3, 'Hello again'));
  assert.match(next!.history[0]!.content, /Historical input omitted/);
  for (let i = 4; i < 50; i++) f.add(i, { role: 'user', content: `Small message ${i}` });
  const [later, laterTrusted, laterSignal] = f.turn(50, 'Continue');
  assert.equal(
    (await f.service.prepare(later, laterSignal, laterTrusted)).trace.outcome,
    'completed',
  );
  assert.ok((await f.store.load(f.original))!.state.cursor > contextId(2));
  assert.ok(f.requests.some((request) => request.stage === 'context'));
  assert.ok(f.requests.every((request) => contextTokens(request) < 24000));
});

test('token-dense accepted history is a bounded marked excerpt with both ends retained', async () => {
  const f = contextFixture();
  await f.context.prepare(...f.turn(1, '/pins'));
  const content = 'CRITICAL_BEGIN ' + '𓀀𓀁𓀂 '.repeat(850) + ' CRITICAL_END';
  assert.ok(content.length <= 6000);
  assert.ok(contextTokens(content) > 10000);
  f.add(2, { role: 'user', content });
  const next = await f.context.prepare(...f.turn(3, 'Continue'));
  assert.equal(next!.history.length, 1);
  assert.match(next!.history[0]!.content, /Historical excerpt/);
  assert.match(next!.history[0]!.content, /CRITICAL_BEGIN/);
  assert.match(next!.history[0]!.content, /CRITICAL_END/);
  assert.ok(contextTokens(next!.history) < 4500);
  assert.equal(f.entries[0]!.content, content, 'source archive is not altered');
});

test('summary merges cannot extend source expiry; expired recent messages are also withheld', async () => {
  const f = contextFixture();
  await f.context.prepare(...f.turn(1, '/pin permanent: Explicit pin stays'));
  const sourceAt = f.now();
  for (let i = 2; i < 48; i++) f.add(i, { role: 'user', content: `Original ${i}` });
  f.advance(25);
  await f.context.prepare(...f.turn(48, 'Continue'));
  assert.equal(
    (await f.store.load(f.original))!.state.summary.notes[0]!.expiresAt,
    sourceAt + 30 * CONTEXT_DAY,
  );
  f.advance(4);
  for (let i = 49; i < 95; i++) f.add(i, { role: 'user', content: `Unrelated new source ${i}` });
  await f.create().prepare(...f.turn(95, 'Continue'));
  assert.equal(
    (await f.store.load(f.original))!.state.summary.notes[0]!.expiresAt,
    sourceAt + 30 * CONTEXT_DAY,
  );
  f.advance(11);
  const result = await f.create().prepare(...f.turn(96, 'What do you remember?'));
  assert.doesNotMatch(JSON.stringify(result), /Temporary original objective|Original \d/);
  assert.match(JSON.stringify(result), /Explicit pin stays/);
  assert.equal((await f.store.load(f.original))!.state.summary.notes.length, 0);
});

test('undated legacy summaries are dropped without losing explicit pins or the history boundary', async () => {
  const f = contextFixture();
  await f.context.prepare(...f.turn(1, '/pin permanent: Keep this'));
  const old = (await f.store.load(f.original))!;
  old.state.summary = {
    notes: [{ kind: 'constraint', text: 'Undated legacy note', sources: ['unknown'] }],
  };
  await f.store.save(f.original, old.revision, old.state);
  const result = await f.context.prepare(...f.turn(2, 'Continue'));
  assert.doesNotMatch(JSON.stringify(result), /Undated legacy note/);
  assert.match(JSON.stringify(result), /Keep this/);
  assert.equal((await f.store.load(f.original))!.state.cursor, old.state.cursor);
});

test('pin pagination lists all valid notes within the transport limit and repairs oversized cached lists', async () => {
  const f = contextFixture();
  const expected = Array.from(
    { length: 18 },
    (_, i) => `note${i + 1}: ${'warehouse '.repeat(100).trim()}`,
  );
  for (let i = 1; i <= 18; i++)
    assert.match(
      (await f.context.prepare(...f.turn(i, `/pin note${i}: ${'warehouse '.repeat(100)}`)))!.reply!,
      /^Pinned/,
    );
  const first = (await f.context.prepare(...f.turn(20, '/pins')))!.reply!;
  assert.match(first, /page 1 of 2/);
  assert.match(first, /\/pins 2/);
  const second = (await f.create().prepare(...f.turn(21, '/pins 2')))!.reply!;
  for (const page of [first, second]) assert.ok(page.length <= MAX_REPLY_CHARACTERS);
  const lines = `${first}\n${second}`.split('\n').filter((line) => /^note\d+:/.test(line));
  assert.deepEqual(lines, expected);
  assert.match((await f.context.prepare(...f.turn(22, '/pins 99')))!.reply!, /Use \/pins 1/);
  const old = (await f.store.load(f.original))!;
  old.state.command = { id: contextId(23), reply: expected.join('\n') };
  assert.ok(old.state.command.reply.length > MAX_REPLY_CHARACTERS);
  await f.store.save(f.original, old.revision, old.state);
  const repaired = (await f.context.prepare(...f.turn(23, '/pins')))!.reply!;
  assert.equal(repaired, first);
});

test('memory-derived model answers carry delivery bindings; only their owner can read their history', async () => {
  const f = contextFixture();
  await f.context.prepare(...f.turn(1, '/pin private: OWNER_ONE_PRIVATE_NOTE'));
  f.reply('You asked me to remember OWNER_ONE_PRIVATE_NOTE.');
  const [message, trusted, signal] = f.turn(3, 'What did I ask you to remember?');
  const result = await f.service.prepare(message, signal, trusted);
  assert.equal(result.trace.outcome, 'completed');
  assert.ok(contextDeliveryBundleSchema.safeParse(result.businessEvidence).success);
  assert.equal(
    getBusinessReply({ text: result.text, receipt: result.businessEvidence }),
    undefined,
  );
  f.add(4, {
    role: 'assistant',
    content: PRIVATE_HISTORY_REPLY,
    protectedReply: { text: result.text, receipt: result.businessEvidence },
  });
  const next = await f.context.prepare(...f.turn(5, 'Continue'));
  assert.ok(
    next!.history.some((entry) => entry.role === 'assistant' && entry.content === result.text),
  );
  const alien = contextDeliveryBundle({
    ...f.original,
    owner: 'a'.repeat(64),
    chatId: CONTEXT_CHAT,
  });
  f.add(6, {
    role: 'assistant',
    content: PRIVATE_HISTORY_REPLY,
    protectedReply: { text: 'ALIEN_PRIVATE_REPLY', receipt: alien },
  });
  assert.doesNotMatch(
    JSON.stringify(await f.context.prepare(...f.turn(7, 'Continue'))),
    /ALIEN_PRIVATE_REPLY/,
  );
});
