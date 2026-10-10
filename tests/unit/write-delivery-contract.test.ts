/** Real graph, write/read services and delivery checks; synthetic CRM and model only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createTranscriptFixture,
  TRANSCRIPT_NOTE_ID,
} from '../../scripts/lib/transcript-fixture.js';
import { FIXTURE_EMPLOYEE, FIXTURE_JID, FIXTURE_LEAD_ID } from '../../scripts/lib/sales-fixture.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import type { ChatMessage, TextModel } from '../../src/modules/assistant/assistant.types.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';
import { toolDelivery } from '../../src/modules/assistant/tool-evidence.js';
import {
  PersonalToolService,
  type PersonalRepositoryPort,
} from '../../src/modules/scheduling/personal-tools.js';
import {
  authorizeDelivery,
  compositeDeliverySchema,
  getBusinessReply,
  writeDeliveryBundleSchema,
} from '../../src/modules/messaging/delivery-evidence.js';

const now = Date.parse('2026-10-11T04:00:00Z');
const signal = () => AbortSignal.timeout(5000);
const actor = { ...FIXTURE_EMPLOYEE, chatId: FIXTURE_JID };
const modelOutput = (value: unknown) => ({
  text: typeof value === 'string' ? value : JSON.stringify(value),
  inputTokens: 1,
  outputTokens: 1,
});

async function scenario(options: {
  action: 'create' | 'update' | 'undo';
  history?: 'personal' | 'business' | 'both';
  supplement?: string;
  longNote?: boolean;
  reject?: boolean;
}) {
  const fixture = createTranscriptFixture('notes', () => now);
  const note = fixture.state.notes.get(TRANSCRIPT_NOTE_ID)!;
  const title = 'Loading access';
  const body = options.longNote
    ? 'Keep the loading approach clear. '.repeat(60).trimEnd()
    : 'Keep the loading approach clear.';
  const source = `${options.action} the note on Fixture Acme Storage. Title: ${title}. Body: ${body}${options.longNote ? `\nContext: ${'Use the existing access road. '.repeat(30)}` : ''}`;
  const trusted = fixture.trusted(source);
  const history: ChatMessage[] = [];
  const addHistory = (text: string, receipt: unknown) =>
    history.push({
      role: 'assistant',
      content: PRIVATE_HISTORY_REPLY,
      protectedReply: { text, receipt },
    });
  if (options.history === 'personal' || options.history === 'both')
    addHistory('Saved task: check the proposal.', {
      kind: 'personal',
      version: 1,
      employeeId: actor.employeeId,
      phoneE164: actor.phoneE164,
      runId: 'earlier-personal-turn',
      history: { at: new Date(now - 60000).toISOString(), activity: [] },
    });
  if (options.history === 'business' || options.history === 'both')
    addHistory(
      'Earlier CRM results.',
      toolDelivery(actor.employeeId, [], now - 60000, { historicalOnly: true }),
    );
  const unexpectedPersonalCall = async (): Promise<never> => {
    assert.fail('A CRM note request must not operate on historical personal records.');
  };
  const personalRepository: PersonalRepositoryPort = {
    getReceipt: async () => null,
    saveContext: async () => {},
    applyBatch: unexpectedPersonalCall,
    list: unexpectedPersonalCall,
    recall: unexpectedPersonalCall,
    resolveSelection: unexpectedPersonalCall,
    finalizeSelections: unexpectedPersonalCall,
  };
  const personal = new PersonalToolService(
    personalRepository,
    async () => (fixture.state.active ? actor : null),
    () => now,
  );
  const writeName = `${options.action}_crm_note`;
  const calls = [
    {
      name: 'read_crm_lead_context',
      args: { id: FIXTURE_LEAD_ID, section: 'notes' },
    },
    ...(options.action === 'create'
      ? []
      : [{ name: 'read_crm_note', args: { deal_id: FIXTURE_LEAD_ID, note_id: note.id } }]),
    {
      name: writeName,
      args: {
        deal_id: FIXTURE_LEAD_ID,
        ...(options.action === 'undo'
          ? { original_operation_id: note.operation }
          : {
              title,
              body,
              ...(options.action === 'update'
                ? { note_id: note.id, expected_updated_at: note.updated_at }
                : {}),
            }),
      },
    },
  ];
  let next = 0;
  let reviews = 0;
  const model: TextModel = {
    async complete(request) {
      if (request.stage === 'converser')
        return modelOutput({
          route: 'work',
          workflow: 'general',
          objective: 'Change the note.',
          reply: '',
        });
      if (request.stage === 'planner')
        return modelOutput({
          objective: 'Change the requested note.',
          successCriteria: [
            'Apply the exact requested change and report its authoritative result.',
          ],
          steps: [
            {
              id: 'change',
              goal: 'Read then change the note.',
              dependsOn: [],
              toolNames: calls.map((call) => call.name),
            },
          ],
        });
      if (request.stage === 'verifier') {
        reviews++;
        assert.equal(fixture.state.writes.length, 0, 'review must precede dispatch');
        return modelOutput({ supported: !options.reject, feedback: '', repair: 'none' });
      }
      return modelOutput(
        request.jsonSchema
          ? { additional_reply: options.supplement ?? '' }
          : (options.supplement ?? 'No change prepared.'),
      );
    },
    startToolSession() {
      return {
        async next() {
          const call = calls[next++];
          return {
            ...modelOutput('Prepared for independent review.'),
            calls: call
              ? [{ id: randomUUID(), name: call.name, arguments: JSON.stringify(call.args) }]
              : [],
          };
        },
        accept() {},
        revise() {},
      };
    },
  };
  const assistant = new AssistantService(
    { model: 'synthetic-no-provider', timeoutMs: 5000 },
    model,
    undefined,
    undefined,
    async () => history,
    fixture.reads,
    { now: () => now, businessWrites: fixture.writes, personalTools: personal },
  );
  const reply = await assistant.prepare(
    {
      chatId: FIXTURE_JID,
      messageId: trusted.commandMessages![0]!.id,
      text: source,
      sentAtMs: now,
      fromMe: false,
      isGroup: false,
      mentionsBot: false,
    },
    undefined,
    trusted,
  );
  const reasons: string[] = [];
  const canDeliver = () =>
    authorizeDelivery(reply.businessEvidence, {
      write: (receipt) => fixture.writes.canDeliver(trusted.key, receipt, signal()),
      personal: (receipt) => personal.canDeliver(trusted.key, receipt, signal()),
      business: (receipt) =>
        fixture.reads.canDeliver(trusted.key, receipt, signal(), (reason) => reasons.push(reason)),
    });
  return { fixture, reply, canDeliver, reasons, reviews, body, source };
}

for (const action of ['create', 'update', 'undo'] as const)
  for (const history of [undefined, 'personal', 'business', 'both'] as const)
    test(`${action} note receipt remains deliverable after its own mutation with ${history ?? 'no'} history`, async () => {
      const h = await scenario({ action, history });
      assert.equal(h.reply.trace.outcome, 'completed');
      assert.equal(h.fixture.state.writes.length, 1);
      assert.equal(h.reviews, 1);
      assert.match(h.reply.text, /^(Saved note|Updated note|Removed this note)/);
      assert.equal(await h.canDeliver(), true, h.reasons.join(','));
      const receipt = writeDeliveryBundleSchema.parse(h.reply.businessEvidence);
      if (history === 'personal' || history === 'both') {
        const composite = compositeDeliverySchema.parse(receipt.other);
        assert.equal(composite.businessText, '');
        assert.equal(composite.businessRecallAllowed, false);
        assert.deepEqual(composite.business.checks, []);
      }
      assert.equal(getBusinessReply({ text: h.reply.text, receipt }), undefined);
      h.fixture.state.active = false;
      assert.equal(await h.canDeliver(), false, 'a saved receipt must not bypass revoked access');
    });

test('separately displayed pre-edit facts retain their freshness checks', async () => {
  const h = await scenario({
    action: 'update',
    history: 'both',
    supplement: 'The previous note says they want fire NOC.',
  });
  assert.equal(h.fixture.state.writes.length, 1);
  assert.equal(await h.canDeliver(), false);
  assert.ok(h.reasons.includes('SOURCE_CHANGED'));
  const receipt = writeDeliveryBundleSchema.parse(h.reply.businessEvidence);
  assert.ok(compositeDeliverySchema.parse(receipt.other).business.checks.length > 0);
});

test('a valid long direct note keeps the exact source and full note without a confirmation-preview limit', async () => {
  const h = await scenario({ action: 'create', history: 'both', longNote: true });
  assert.ok(h.source.length <= 3000);
  assert.ok(h.body.length <= 2000);
  assert.equal(h.fixture.state.writes.length, 1, JSON.stringify(h.reply.trace));
  const saved = h.fixture.state.writes[0]!;
  assert.equal(saved.args.raw_text, h.source);
  assert.equal(saved.args.body, h.body);
  assert.ok(JSON.stringify(saved.args).length > 4800);
  assert.ok(h.reply.text.includes(h.body));
  assert.equal(await h.canDeliver(), true);
});

test('rejected mixed-history notes cannot dispatch', async () => {
  const h = await scenario({ action: 'update', history: 'both', reject: true });
  assert.equal(h.fixture.state.writes.length, 0);
  assert.doesNotMatch(h.reply.text, /^Updated note/);
});
