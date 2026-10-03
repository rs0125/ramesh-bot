/** STOP recognition uses only a direct transport message, never forwarded or model text. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { GreetingCandidate } from '../../src/modules/greetings/greeting.types.js';
import {
  isInvestigationStop,
  renderInvestigationStop,
} from '../../src/modules/messaging/investigation-stop.js';

const direct = (overrides: Partial<GreetingCandidate> = {}): GreetingCandidate => ({
  chatId: '919000000023@s.whatsapp.net',
  senderId: '919000000023@s.whatsapp.net',
  messageId: 'synthetic-stop',
  sentAtMs: 1,
  text: 'STOP',
  kind: 'text',
  fromMe: false,
  forwarded: false,
  isGroup: false,
  mentionsBot: false,
  ...overrides,
});
const group = (overrides: Partial<GreetingCandidate> = {}) =>
  direct({
    chatId: 'synthetic@g.us',
    senderId: 'alice@lid',
    isGroup: true,
    mentionsBot: true,
    ...overrides,
  });

test('a direct standalone STOP accepts case and one optional full stop or exclamation mark', () => {
  for (const text of ['STOP', 'stop', ' Stop. ', '\n sToP!\t'])
    assert.equal(isInvestigationStop(direct({ text })), true, text);
  for (const text of [
    'stop?',
    'stop!!',
    'stop now',
    'please stop',
    'stop the reminder',
    'do not stop',
    '"STOP"',
    'STOP\nthen continue',
    '@919000000001 STOP',
    'STOP @919000000001',
  ])
    assert.equal(isInvestigationStop(direct({ text })), false, text);
});

test('only direct text with explicit non-forwarded provenance can stop work', () => {
  for (const overrides of [
    { fromMe: true },
    { forwarded: true },
    { forwarded: undefined },
    { text: undefined },
    { kind: undefined },
    { kind: 'audio' },
    { kind: 'image' },
    { kind: 'document' },
    { batchMessageIds: ['synthetic-member'] },
  ])
    assert.equal(isInvestigationStop(direct(overrides)), false, JSON.stringify(overrides));
});

test('group STOP requires the actual bot mention and sender; one numeric mention may prefix or suffix it', () => {
  for (const text of ['STOP', '@919000000001 STOP', '@919000000001 stop!', 'Stop. @919000000001'])
    assert.equal(isInvestigationStop(group({ text })), true, text);
  for (const overrides of [
    { mentionsBot: false },
    { mentionsBot: false, text: '@919000000001 STOP' },
    { senderId: undefined },
    { senderId: 'synthetic@g.us' },
    { text: '@bot STOP' },
    { text: '@919000000001 STOP @919000000002' },
    { text: '@919000000001 please STOP' },
    { text: 'STOP now @919000000001' },
  ])
    assert.equal(isInvestigationStop(group(overrides)), false, JSON.stringify(overrides));
});

test('acknowledgements distinguish cancelled work from saved changes and uncertain delivery', () => {
  const empty = { duplicate: false, cancelledRunIds: [], preservedOutcomes: 0, alreadySending: 0 };
  assert.match(renderInvestigationStop(empty), /no pending investigation/i);
  const preserved = renderInvestigationStop({ ...empty, preservedOutcomes: 1, alreadySending: 1 });
  assert.match(preserved, /saved changes and published confirmations/);
  assert.match(preserved, /already sending or its delivery is uncertain/);
  assert.doesNotMatch(preserved, /Stopped your pending work/);
  const id = 'b216106d-950b-4690-8a6e-f4d854d4894e';
  const stopped = renderInvestigationStop({ ...empty, cancelledRunIds: [id] });
  assert.match(stopped, /Stopped your pending work/);
  assert.doesNotMatch(stopped, new RegExp(id));
});
