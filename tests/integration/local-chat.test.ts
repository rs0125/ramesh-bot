/** The GUI/eval transport runs the actual mapper, LangGraph and SQLite claim path. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalChat } from '../../scripts/lib/local-chat.js';
import { temporaryDatabase } from '../fixtures/database.js';
import type { ModelRequest } from '../../src/modules/assistant/assistant.types.js';
import { createFollowupFixture } from '../../scripts/lib/followup-fixture.js';

test('local DM/group replies persist in SQLite, deduplicate and keep histories separate', async () => {
  const temp = await temporaryDatabase();
  const calls: ModelRequest[] = [];
  const chat = new LocalChat(
    { model: 'fake', timeoutMs: 2000 },
    {
      async complete(request) {
        calls.push(request);
        return {
          text: request.stage === 'converser' ? 'Draft' : 'Hey, what’s up?',
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    },
    temp.db,
  );
  try {
    const input = { conversation: 'test-room', text: 'hi', messageId: 'one' };
    const reply = await chat.send(input);
    assert.equal(reply.text, 'Hey, what’s up?');
    assert.equal(reply.outcome, 'sent');
    assert.equal(
      (await temp.db.greeting.findFirst({ where: { messageId: 'one' } }))?.status,
      'SENT',
    );
    await assert.rejects(chat.send(input), /duplicate/);
    assert.equal(calls.length, 2);
    await chat.send({ ...input, messageId: 'two', text: 'remember that?' });
    assert.equal(calls[2]!.messages.length, 3);
    await chat.send({ ...input, group: true, sender: 'me', messageId: 'three' });
    assert.equal(calls[4]!.messages.length, 1);
    await chat.send({ ...input, group: true, sender: 'teammate', messageId: 'four' });
    assert.equal(calls[6]!.messages.length, 3, 'participants share their group conversation');
    assert.equal(await temp.db.greeting.count(), 4);
    assert.equal(
      await temp.db.whatsAppAuthEntry.count(),
      0,
      'Local tests never pair a WhatsApp account',
    );
  } finally {
    await chat.drain();
    await temp.close();
  }
});

test('local CRM fixtures use the graph and preflight with captured output, never pairing state', async () => {
  const temp = await temporaryDatabase();
  const fixture = createFollowupFixture();
  const chat = new LocalChat(
    { model: 'fake', timeoutMs: 2000 },
    {
      async complete() {
        return {
          text: JSON.stringify({ intent: 'assigned_followups_today', language: 'en', draft: '' }),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    },
    temp.db,
    fixture,
  );
  try {
    const reply = await chat.send({ conversation: 'fixture', text: 'my follow-ups today' });
    assert.match(reply.text, /Fixture Acme Storage/);
    assert.ok(reply.businessEvidence);
    assert.equal(fixture.state.calls, 2, 'read and delivery recheck both execute');
    fixture.state.active = false;
    const unknown = await chat.send({ conversation: 'unknown', text: 'my follow-ups today' });
    assert.equal(unknown.businessEvidence, undefined);
    assert.match(unknown.text, /access isn't available/);
    assert.equal(fixture.state.calls, 2);
    assert.equal(await temp.db.greeting.count({ where: { status: 'SENT' } }), 2);
    assert.equal(await temp.db.whatsAppAuthEntry.count(), 0);
  } finally {
    await chat.drain();
    await temp.close();
  }
});
