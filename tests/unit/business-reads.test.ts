/** CRM preset authorization, source contracts and the real LangGraph path, using only synthetic evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { followupEvidence, createFollowupFixture } from '../../scripts/lib/followup-fixture.js';
import {
  verifyFollowups,
  renderFollowups,
  indiaDate,
} from '../../src/modules/assistant/followups.js';
import { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { loadBusinessReadConfig } from '../../src/config/business-reads.js';
import type {
  GreetingCandidate,
  TrustedReplyContext,
} from '../../src/modules/greetings/greeting.types.js';
import type { ModelRequest, TextModel } from '../../src/modules/assistant/assistant.types.js';

const fixedNow = Date.parse('2026-10-01T06:00:00Z');
const trusted = (): TrustedReplyContext => ({
  runId: randomUUID(),
  key: { remoteJid: '919000000023@s.whatsapp.net', fromMe: false },
});
const signal = () => new AbortController().signal;

test('verifier preserves assignment, current India dates, partial coverage and verification caveats', () => {
  const evidence = followupEvidence(fixedNow);
  evidence.data.access_scope = 'all'; // An admin still used the fixed view=assigned query.
  evidence.data.nextCursor = 'more';
  (evidence.data.query_context as Record<string, unknown>).has_more = true;
  const facts = verifyFollowups(evidence, fixedNow);
  const reply = renderFollowups(facts, 'en');
  assert.match(reply, /Fixture Acme Storage/);
  assert.match(reply, /first 1 results; more exist/);
  assert.match(reply, /need verification/);
  assert.ok(!reply.includes('—'));
  assert.equal(indiaDate(Date.parse('2026-10-01T18:31:00Z')), '2026-10-02');
});

test('verifier rejects wider queries, stale or invalid source evidence and misleading page metadata', () => {
  const mutations: Array<(e: ReturnType<typeof followupEvidence>) => void> = [
    (e) => {
      e.source_path = e.source_path.replace('assigned', 'accessible');
    },
    (e) => {
      e.source_path += '&assigned_to=someone';
    },
    (e) => {
      e.source_path = `https://attacker.invalid${e.source_path}`;
    },
    (e) => {
      e.data.access_scope = 'created_or_assigned';
    },
    (e) => {
      (e.data.query_context as Record<string, unknown>).returned_count = 10;
    },
    (e) => {
      (e.data.query_context as Record<string, unknown>).has_more = true;
    },
    (e) => {
      (e.data.query_context as Record<string, unknown>).local_date = '2026-09-30';
    },
    (e) => {
      (e.data.source_status as { opportunities: { status: string } }).opportunities.status =
        'error';
    },
    (e) => {
      (
        e.data.source_status as { opportunities: { last_run_at: string } }
      ).opportunities.last_run_at = '2026-09-30T00:00:00Z';
    },
    (e) => {
      (e.data.items as Array<Record<string, unknown>>)[0]!.next_follow_up = '2026-10-02T12:00:00Z';
    },
    (e) => {
      (e.data.items as Array<Record<string, unknown>>)[0]!.verification_required = undefined;
    },
  ];
  for (const mutate of mutations) {
    const value = followupEvidence(fixedNow);
    mutate(value);
    assert.throws(() => verifyFollowups(value, fixedNow));
  }
});

test('unknown, nonpilot and group identities cannot reach business reads', async () => {
  const fixture = createFollowupFixture(() => fixedNow);
  assert.equal((await fixture.service.read(undefined, signal())).outcome, 'denied');
  assert.equal(
    (
      await fixture.service.read(
        {
          ...trusted(),
          key: { remoteJid: '123@g.us', participant: '919000000023@s.whatsapp.net' },
        },
        signal(),
      )
    ).outcome,
    'denied',
  );
  fixture.state.active = false;
  assert.equal((await fixture.service.read(trusted(), signal())).outcome, 'denied');
  fixture.state.active = true;
  fixture.state.employeeId = 24;
  assert.equal((await fixture.service.read(trusted(), signal())).outcome, 'denied');
  assert.equal(fixture.state.calls, 0);
});

test('receipts are recorded and delayed delivery rechecks identity, data and expiry', async () => {
  let now = fixedNow;
  const fixture = createFollowupFixture(() => now);
  const events: string[] = [];
  const context = {
    ...trusted(),
    async record(kind: string) {
      events.push(kind);
    },
  };
  const result = await fixture.service.read(context, signal());
  assert.equal(result.outcome, 'verified');
  if (result.outcome !== 'verified') assert.fail('Expected facts');
  assert.deepEqual(events, ['tool_started', 'tool_succeeded']);
  assert.equal(await fixture.service.canDeliver(context.key, result.delivery, signal()), true);
  fixture.state.more = true;
  assert.equal(await fixture.service.canDeliver(context.key, result.delivery, signal()), false);
  fixture.state.more = false;
  fixture.state.active = false;
  assert.equal(await fixture.service.canDeliver(context.key, result.delivery, signal()), false);
  fixture.state.active = true;
  now += 301_000;
  assert.equal(await fixture.service.canDeliver(context.key, result.delivery, signal()), false);
});

test('identity changing during a read and source failures never become successful empty results', async () => {
  let id = 23;
  const changing = new BusinessReadService(
    async () => ({
      employeeId: id,
      async search() {
        id = 24;
        return followupEvidence(fixedNow);
      },
    }),
    [23],
    () => fixedNow,
  );
  assert.equal((await changing.read(trusted(), signal())).outcome, 'denied');
  const fixture = createFollowupFixture(() => fixedNow);
  fixture.state.stale = true;
  assert.equal((await fixture.service.read(trusted(), signal())).outcome, 'unavailable');
  fixture.state.stale = false;
  fixture.state.empty = true;
  const empty = await fixture.service.read(trusted(), signal());
  assert.equal(empty.outcome, 'verified');
  if (empty.outcome === 'verified')
    assert.match(renderFollowups(empty.facts, 'en'), /No assigned follow-ups/);
});

test('real LangGraph routes the preset, never passes source facts to a formatter model, and omits business memory', async () => {
  const fixture = createFollowupFixture();
  const calls: ModelRequest[] = [];
  const model: TextModel = {
    async complete(request) {
      calls.push(request);
      return {
        text: JSON.stringify({ intent: 'assigned_followups_today', language: 'en', draft: '' }),
        inputTokens: 2,
        outputTokens: 1,
      };
    },
  };
  const agent = new AssistantService(
    { model: 'fixture', timeoutMs: 2000 },
    model,
    undefined,
    undefined,
    undefined,
    fixture.service,
  );
  const context = trusted();
  const candidate: GreetingCandidate = {
    chatId: context.key.remoteJid!,
    messageId: 'fixture',
    sentAtMs: Date.now(),
    fromMe: false,
    isGroup: false,
    mentionsBot: false,
    text: 'My follow-ups today?',
  };
  const reply = await agent.prepare(candidate, signal(), context);
  assert.match(reply.text, /Fixture Acme Storage/);
  assert.ok(reply.businessEvidence);
  assert.deepEqual(
    reply.trace.stages.map((stage) => stage.stage),
    ['converser', 'worker', 'formatter'],
  );
  assert.equal(calls.length, 1);
  assert.equal(reply.trace.runId, context.runId);
  reply.onSent?.();
  await agent.prepare({ ...candidate, messageId: 'next' }, signal(), trusted());
  assert.equal(calls[1]!.messages.length, 3);
  assert.match(calls[1]!.messages[1]!.content, /Private content is omitted/);
  assert.ok(!JSON.stringify(calls[1]!.messages).includes('Fixture Acme Storage'));
  const group = await agent.prepare({ ...candidate, chatId: '123@g.us', isGroup: true }, signal(), {
    ...trusted(),
    key: { remoteJid: '123@g.us' },
  });
  assert.match(group.text, /DM/);
  assert.equal(group.businessEvidence, undefined);
});

test('business configuration is closed unless explicitly enabled with valid signed access', () => {
  assert.equal(loadBusinessReadConfig({}), undefined);
  assert.equal(
    loadBusinessReadConfig({
      BUSINESS_READS_ENABLED: 'false',
      CONTEXT_RAMESH_SIGNING_KEY_JSON: 'invalid',
    }),
    undefined,
  );
  assert.throws(() => loadBusinessReadConfig({ BUSINESS_READS_ENABLED: 'yes' }));
  assert.throws(() => loadBusinessReadConfig({ BUSINESS_READS_ENABLED: 'true' }));
  assert.throws(() =>
    loadBusinessReadConfig({ BUSINESS_READS_ENABLED: 'true', BUSINESS_READ_EMPLOYEE_IDS: '23,23' }),
  );
  assert.throws(() =>
    loadBusinessReadConfig({ BUSINESS_READS_ENABLED: 'true', BUSINESS_READ_EMPLOYEE_IDS: '23' }),
  );
});

test('enabled signed configuration defaults to active employees and accepts the full read vocabulary', () => {
  const env = {
    BUSINESS_READS_ENABLED: 'true',
    CONTEXT_MCP_URL: 'https://context.example/mcp/ramesh',
    CONTEXT_RAMESH_SIGNING_KEY_JSON: JSON.stringify({
      kid: 'fixture',
      privateKey: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'A'.repeat(43) },
      scopes: ['crm:read', 'warehouses:read', 'knowledge:read', 'analytics:read'],
    }),
  };
  assert.equal(loadBusinessReadConfig(env)?.employeeIds, 'all');
  assert.equal(
    loadBusinessReadConfig({ ...env, BUSINESS_READ_EMPLOYEE_IDS: 'all' })?.employeeIds,
    'all',
  );
  assert.deepEqual(
    loadBusinessReadConfig({ ...env, BUSINESS_READ_EMPLOYEE_IDS: '23,77' })?.employeeIds,
    [23, 77],
  );
  assert.equal(loadBusinessReadConfig(env)?.signing.scopes.length, 4);
  assert.throws(
    () => loadBusinessReadConfig({ ...env, CONTEXT_MCP_URL: 'https://context.example/mcp' }),
    /WhatsApp business reads require signed Context Engine access at \/mcp\/ramesh/,
  );
});

test('all-active mode removes the pilot list while keeping trusted resolution and group boundaries', async () => {
  let active = true;
  const service = new BusinessReadService(
    async (key) =>
      active && key.remoteJid === trusted().key.remoteJid
        ? { employeeId: 77, search: async () => followupEvidence(fixedNow) }
        : null,
    'all',
    () => fixedNow,
  );
  assert.equal((await service.read(trusted(), signal())).outcome, 'verified');
  active = false;
  assert.equal((await service.read(trusted(), signal())).outcome, 'denied');
  active = true;
  assert.equal(
    (await service.read({ ...trusted(), key: { remoteJid: 'group@g.us' } }, signal())).outcome,
    'denied',
  );
});
