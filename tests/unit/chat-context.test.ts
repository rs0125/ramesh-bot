import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ChatContext,
  contextScope,
  type ContextStore,
  type ContextEntry,
  type ContextState,
  type ContextSnapshot,
} from '../../src/modules/assistant/chat-context.js';
import { LocalChatContextStore } from '../../src/infrastructure/database/local-chat-context.js';
import type {
  GreetingCandidate,
  TrustedReplyContext,
} from '../../src/modules/greetings/greeting.types.js';
import type { ModelRequest } from '../../src/modules/assistant/assistant.types.js';

const scope = contextScope('test', '1@s.whatsapp.net', {
  employeeId: 1,
  phoneE164: '+911111111111',
});
const signal = () => AbortSignal.timeout(5000);
const id = (i: number) => String(i).padStart(12, '0');
class Store implements ContextStore {
  rows = new Map<string, ContextSnapshot & { owner: string }>();
  async load(s: typeof scope) {
    const row = this.rows.get(s.key);
    return row?.owner === s.owner
      ? structuredClone({ revision: row.revision, state: row.state })
      : null;
  }
  async save(s: typeof scope, revision: number, state: ContextState) {
    if (((await this.load(s))?.revision ?? 0) !== revision) return false;
    this.rows.set(s.key, structuredClone({ owner: s.owner, revision: revision + 1, state }));
    return true;
  }
}
function setup(store: ContextStore = new Store()) {
  let clock = Date.now(),
    currentScope: typeof scope | null = scope;
  const entries: ContextEntry[] = [];
  const requests: ModelRequest[] = [];
  let invalid = false;
  const source = {
    async anchor(message: GreetingCandidate) {
      return { before: message.messageId, start: id(Number(message.messageId) - 1) };
    },
    async page(_message: GreetingCandidate, after: string, before: string) {
      const selected = entries.filter((entry) => entry.id > after && entry.id < before);
      return { entries: selected.slice(0, 128), more: selected.length > 128 };
    },
  };
  const model = {
    async complete(request: ModelRequest) {
      requests.push(request);
      const body = JSON.parse(request.messages[0]!.content);
      return {
        text: JSON.stringify({
          notes: [
            {
              kind: 'correction',
              text: 'The corrected minimum is 50000 square feet; the earlier 20000 is superseded.',
              sources: [invalid ? 'invented' : body.messages.at(-1).id],
            },
          ],
        }),
        inputTokens: 100,
        outputTokens: 50,
      };
    },
  };
  const create = () =>
    new ChatContext({ store, source, model, resolve: async () => currentScope, now: () => clock });
  const turn = (
    i: number,
    text: string,
    extra: Partial<NonNullable<TrustedReplyContext['commandMessages']>[number]> = {},
  ) => {
    const message: GreetingCandidate = {
      chatId: '1@s.whatsapp.net',
      messageId: id(i),
      sentAtMs: clock,
      fromMe: false,
      isGroup: false,
      mentionsBot: true,
      text,
    };
    const trusted: TrustedReplyContext = {
      runId: id(i),
      key: { remoteJid: message.chatId },
      commandMessages: [{ id: id(i), text, receivedAtMs: clock, forwarded: false, ...extra }],
    };
    return [message, trusted, signal()] as const;
  };
  return {
    store,
    entries,
    requests,
    create,
    turn,
    expire: () => {
      clock += 31 * 86400000;
    },
    deny: () => {
      currentScope = null;
    },
    owner: () => {
      currentScope = contextScope('test', '1@s.whatsapp.net', {
        employeeId: 2,
        phoneE164: '+911111111111',
      });
    },
    originalOwner: () => {
      currentScope = scope;
    },
    invalid: () => {
      invalid = true;
    },
  };
}

test('explicit pins replace by key, persist across restart and forget cannot resurrect old history', async () => {
  const f = setup();
  assert.match(
    (await f.create().prepare(...f.turn(1, '/pin size: 20000 sq ft')))?.reply ?? '',
    /Pinned/,
  );
  await f.create().prepare(...f.turn(2, '/pin size: 50000 sq ft'));
  const saved = await f.store.load(scope);
  assert.equal(saved!.state.pins.length, 1);
  assert.equal(saved!.state.pins[0]!.text, '50000 sq ft');
  const again = await f.create().prepare(...f.turn(2, '/pin size: 50000 sq ft'));
  assert.match(again!.reply!, /Pinned/);
  assert.equal((await f.store.load(scope))!.revision, saved!.revision);
  f.entries.push({ id: id(3), role: 'user', content: 'Old preference' });
  await f.create().prepare(...f.turn(4, '/forget context'));
  const next = await f.create().prepare(...f.turn(5, 'What do you remember?'));
  assert.deepEqual(next?.history, []);
  assert.equal(f.requests.length, 0);
});

test('compaction validates provenance and atomically advances a cursor while retaining recent messages', async () => {
  const f = setup();
  await f.create().prepare(...f.turn(1, '/pin format: short bullets'));
  for (let i = 2; i <= 46; i++)
    f.entries.push({
      id: id(i),
      role: i % 2 ? 'assistant' : 'user',
      content: i === 10 ? 'Correction: use 50000 sq ft, not 20000.' : `Context ${i}`,
    });
  const next = await f.create().prepare(...f.turn(47, 'Continue'));
  assert.equal(f.requests.length, 1);
  assert.equal(next!.history.length, 17);
  assert.match(next!.history[0]!.content, /50000/);
  assert.match(next!.history[0]!.content, /short bullets/);
  assert.equal(next!.history.at(-1)!.content, 'Context 46');
  const before = (await f.store.load(scope))!.state.cursor;
  const restarted = await f.create().prepare(...f.turn(47, 'Continue'));
  assert.deepEqual(restarted, next);
  assert.equal((await f.store.load(scope))!.state.cursor, before);
  assert.equal(f.requests.length, 1);
});

test('bad summary provenance leaves cursor and old summary intact', async () => {
  const f = setup();
  await f.create().prepare(...f.turn(1, '/pins'));
  const before = await f.store.load(scope);
  for (let i = 2; i < 40; i++) f.entries.push({ id: id(i), role: 'user', content: 'source' });
  f.invalid();
  await assert.rejects(f.create().prepare(...f.turn(40, 'Continue')), /CONTEXT_SUMMARY_INVALID/);
  assert.deepEqual(await f.store.load(scope), before);
});

test('forwarded/quoted commands cannot pin; denied or reassigned owners cannot read old memory', async () => {
  const f = setup();
  await f.create().prepare(...f.turn(1, '/pin secret: owner-only value'));
  await f
    .create()
    .prepare(...f.turn(2, '/pin attack: from a forwarded message', { forwarded: true }));
  await f.create().prepare(...f.turn(3, '/pin attack: from a quote', { hasQuotedMessage: true }));
  assert.equal((await f.store.load(scope))!.state.pins.length, 1);
  f.deny();
  assert.deepEqual(await f.create().prepare(...f.turn(4, '/pins')), { history: [] });
  f.owner();
  assert.match((await f.create().prepare(...f.turn(5, '/pins')))!.reply!, /no pinned/);
  await f.create().prepare(...f.turn(6, '/pin second: another owner'));
  f.originalOwner();
  assert.match((await f.create().prepare(...f.turn(7, '/pins')))!.reply!, /no pinned/);
});

test('expired summaries and references disappear, explicit pins remain', async () => {
  const f = setup();
  await f.create().prepare(...f.turn(1, '/pin format: bullets'));
  const saved = (await f.store.load(scope))!;
  saved.state.summary = {
    notes: [{ kind: 'pending_question', text: 'Old question', sources: [id(1)] }],
  };
  saved.state.selections = [
    {
      employeeId: 1,
      expiresAt: Date.now() + 86400000,
      records: [{ kind: 'warehouse', id: 105, position: 2 }],
    },
  ];
  await f.store.save(scope, saved.revision, saved.state);
  f.expire();
  const result = await f.create().prepare(...f.turn(2, 'Continue'));
  assert.equal(result!.history.length, 1);
  assert.match(result!.history[0]!.content, /bullets/);
  assert.doesNotMatch(JSON.stringify(result), /Old question|businessReferences/);
});

test('local state is encrypted, private, restartable and rejects racing saves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ramesh-context-unit-'));
  const key = randomBytes(32).toString('base64url');
  const f = setup(new LocalChatContextStore(directory, key));
  await f.create().prepare(...f.turn(1, '/pin private: private sentinel'));
  const path = join(directory, (await readdir(directory))[0]!);
  assert.doesNotMatch(await readFile(path, 'utf8'), /private sentinel/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const a = new LocalChatContextStore(directory, key),
    b = new LocalChatContextStore(directory, key);
  const current = (await a.load(scope))!;
  assert.deepEqual((await b.load(scope))!.state, current.state);
  const outcomes = await Promise.all([
    a.save(scope, current.revision, current.state),
    b.save(scope, current.revision, current.state),
  ]);
  assert.deepEqual(outcomes.sort(), [false, true]);
  const second = contextScope('test', '1@s.whatsapp.net', {
    employeeId: 2,
    phoneE164: '+911111111111',
  });
  assert.equal(await a.load(second), null);
  assert.equal(await a.save(second, 0, { ...current.state, pins: [] }), true);
  assert.equal(await b.load(scope), null);
  assert.equal(await b.save(scope, 0, { ...current.state, pins: [] }), true);
  assert.deepEqual((await a.load(scope))!.state.pins, []);
});
