/** Production orchestration against synthetic source storage, journal and CRM. */
import { randomUUID } from 'node:crypto';
import {
  createTranscriptFixture,
  TRANSCRIPT_NOTE_ID,
} from '../../scripts/lib/transcript-fixture.js';
import { FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';
import type { AssistantConfig } from '../../src/config/assistant.js';
import type {
  ChatMessage,
  TextModel,
  ToolSessionRequest,
} from '../../src/modules/assistant/assistant.types.js';
import { addUsage, emptyUsage } from './usage.js';
import type { TranscriptCase } from '../transcript-cases.js';
import { OpenAIToolCatalog } from '../../src/infrastructure/openai/tool-catalog.js';
import { toolDiscovery } from '../../src/modules/context-engine/tool-discovery.js';

/** Exercise provider catalogue construction before any paid request, including writes. */
export async function validateTranscriptCatalogue(
  mode: TranscriptCase['mode'],
  loading: 'eager' | 'deferred',
) {
  const fixture = createTranscriptFixture(mode, () => Date.parse('2026-10-06T09:00:00Z'));
  const trusted = fixture.trusted('Synthetic fixture preflight');
  const signal = AbortSignal.timeout(5000);
  const reads = (await fixture.reads.openTools(trusted, signal)).run;
  const writes = await fixture.writes.open(trusted, signal);
  if (!reads) throw new Error('TRANSCRIPT_READ_PREFLIGHT_FAILED');
  const tools = [
    ...reads.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(toolDiscovery(t) ? { discovery: toolDiscovery(t) } : {}),
    })),
    ...(writes?.tools ?? []),
  ];
  return new OpenAIToolCatalog(tools, loading).render();
}

export type TranscriptFixture = ReturnType<typeof createTranscriptFixture>;
type Fixture = TranscriptFixture;
export interface TranscriptTurnView {
  reply: string;
  calls: unknown[];
  local_calls: Array<{ name: string }>;
  protected: boolean;
  trace: { outcome: string };
}
/** Optional per-suite overrides; omitted hooks keep the incident transcript behaviour. */
export interface TranscriptTrialHooks {
  /** Replaces the default fault injection/revocation before each turn. */
  beforeTurn?: (index: number, fixture: Fixture) => void;
  /** Replaces transcriptChecks for each completed turn. */
  checks?: (index: number, fixture: Fixture, turn: TranscriptTurnView) => string[];
}
export function transcriptChecks(
  scenario: TranscriptCase,
  index: number,
  fixture: Fixture,
  turn: TranscriptTurnView,
) {
  const failures: string[] = [];
  const check = (ok: unknown, name: string) => {
    if (!ok) failures.push(`turn${index + 1}:${name}`);
  };
  const supplied = (value: unknown) =>
    value != null && !(typeof value === 'string' && !value.trim());
  if (scenario.mode === 'rfq') {
    check(fixture.state.rfqs.length === [0, 1, 2, 2][index], 'rfq_effect_count');
    if (index === 1 && fixture.state.rfqs[0] && !fixture.state.rfqs[0].uncertain)
      check(
        !/(?:creation is pending independent review|(?:has not|hasn't) been created yet)/i.test(
          turn.reply,
        ),
        'no_stale_precommit_status',
      );
    if (index === 1) {
      const record = fixture.state.rfqs[0];
      check(
        record &&
          (!supplied(record.args.location) || record.args.location === 'Visakhapatnam') &&
          (!supplied(record.args.requirement) || record.args.requirement === '25,000 sft') &&
          (!supplied(record.args.micro_market) || record.args.micro_market === 'Anywhere'),
        'first_rfq_fields',
      );
      check(String(record?.args.raw_text).includes(scenario.turns[0]!), 'complete_original_source');
      check(
        !supplied(record?.args.budget) || record?.args.budget === 'market rate',
        'supplied_budget_preserved',
      );
      check(
        !supplied(record?.args.lease_duration) ||
          (record?.args.lease_duration as { value?: string } | undefined)?.value === 'LONG_TERM',
        'supplied_duration_preserved',
      );
    }
    if (index >= 2) {
      const record = fixture.state.rfqs[1];
      check(
        record &&
          (!supplied(record.args.location) || record.args.location === 'Coimbatore') &&
          (!supplied(record.args.requirement) || record.args.requirement === '30,000 sft') &&
          (!supplied(record.args.micro_market) || record.args.micro_market === 'Anywhere'),
        'second_rfq_fields',
      );
      check(
        record && !supplied(record.args.budget) && !supplied(record.args.lease_duration),
        'no_field_carryover',
      );
      check(record?.args.raw_text === scenario.turns[2], 'second_rfq_own_source_only');
      check(record?.uncertain, 'uncertain_create_exercised');
      check(
        fixture.state.writes
          .filter((w) => w.tool === 'create_crm_rfq')
          .every((w) => fixture.state.rfqs.some((r) => r.operation_id === w.result.operation_id)),
        'retry_operation_identity',
      );
    }
  } else if (scenario.mode === 'notes') {
    const note = fixture.state.notes.get(TRANSCRIPT_NOTE_ID);
    check(fixture.state.writes.length === [0, 1, 1, 2][index], 'note_action_count');
    check(fixture.state.notes.size === 1 && note?.attached, 'original_note_remains_attached');
    check(
      fixture.state.writes.every((w) => ['update_crm_note', 'undo_crm_note'].includes(w.tool)),
      'no_replacement_or_creation_undo',
    );
    if (index === 1 || index === 2)
      check(note?.title === 'Fire advisory' && note.body === 'Fire advisory', 'both_fields_exact');
    if (index === 3) {
      check(
        note?.title === 'Fire NOC requirement' && note.body === 'They want fire NOC.',
        'undo_restores_exact_original',
      );
      const [edit, undo] = fixture.state.writes;
      check(
        undo?.tool === 'undo_crm_note' &&
          undo.args.original_operation_id === edit?.result.operation_id,
        'undo_edit_identity',
      );
    }
  } else if (index < 2) {
    check(turn.trace.outcome === 'completed', 'completed');
    check(
      /25,?000/.test(turn.reply) &&
        /Bengaluru|Bangalore/i.test(turn.reply) &&
        /distribution/i.test(turn.reply),
      'actual_requirement_retained',
    );
    check(turn.protected, 'protected_receipt');
    if (index === 1)
      check(
        turn.local_calls.some((c) => c.name === 'recall_business_context'),
        'fresh_protected_recall',
      );
  } else {
    check(turn.calls.length === 0, 'no_reads_after_revocation');
    check(
      !/Acme|Bengaluru|Bangalore|25,?000|distribution/i.test(turn.reply),
      'no_private_history_leak',
    );
  }
  return failures;
}

export async function runTranscriptTrial(
  scenario: TranscriptCase,
  provider: TextModel,
  config: AssistantConfig,
  hooks: TranscriptTrialHooks = {},
) {
  let now = Date.parse('2026-10-06T09:00:00Z');
  const fixture = createTranscriptFixture(scenario.mode, () => now);
  const history: ChatMessage[] = [];
  let availableTools: ToolSessionRequest['tools'] = [];
  const record: any = {
    case: scenario.id,
    category: 'boundaries',
    trial: 1,
    passed: false,
    checks: [],
    turns: [],
    modelOutputs: [],
    toolResults: [],
    proposedTools: [],
    usage: emptyUsage(),
    agentUsage: emptyUsage(),
    judgeUsage: emptyUsage(),
  };
  const model: TextModel = {
    toolLoadingMode: provider.toolLoadingMode,
    async complete(request, signal) {
      const result = await provider.complete(request, signal);
      addUsage(record.usage, result);
      addUsage(record.agentUsage, result);
      record.modelOutputs.push({ stage: request.stage, text: result.text });
      return result;
    },
    startToolSession(request) {
      const session = provider.startToolSession!(request);
      return {
        async next(...args) {
          const result = await session.next(...args);
          addUsage(record.usage, result);
          addUsage(record.agentUsage, result);
          record.proposedTools.push(...result.calls);
          if (result.text) record.modelOutputs.push({ stage: 'worker', text: result.text });
          return result;
        },
        accept(id, output) {
          const call = record.proposedTools.findLast((c: any) => c.id === id);
          record.toolResults.push({ ...call, output: structuredClone(output) });
          session.accept(id, output);
        },
        revise: (feedback) => session.revise!(feedback),
      };
    },
  };
  const assistant = new AssistantService(
    config,
    model,
    undefined,
    undefined,
    async () => history.slice(-32),
    fixture.reads,
    {
      now: () => now,
      businessWrites: fixture.writes,
      observeContext: (ctx) => {
        availableTools = ctx.tools;
      },
    },
  );
  const started = Date.now();
  try {
    for (let index = 0; index < scenario.turns.length; index++) {
      now += 60000;
      if (hooks.beforeTurn) hooks.beforeTurn(index, fixture);
      else {
        if (scenario.mode === 'rfq' && index === 2) fixture.state.uncertainNextCreate = true;
        if (scenario.mode === 'recall' && index === 2) fixture.state.active = false;
      }
      const before = fixture.state.reads.length,
        writesBefore = fixture.state.writes.length,
        outputsBefore = record.toolResults.length,
        proposalsBefore = record.proposedTools.length;
      const text = scenario.turns[index]!;
      availableTools = [];
      const reply = await assistant.prepare(
        {
          chatId: FIXTURE_JID,
          messageId: randomUUID(),
          text,
          sentAtMs: now,
          fromMe: false,
          isGroup: false,
          mentionsBot: false,
        },
        undefined,
        fixture.trusted(text),
      );
      const tools = structuredClone(record.toolResults.slice(outputsBefore));
      const turn = {
        text,
        reply: reply.text,
        trace: reply.trace,
        clock: { instant: new Date(now).toISOString(), timezone: 'Asia/Kolkata' },
        authorization: { active_employee: fixture.state.active, audience: 'dm' },
        available_tools: structuredClone(availableTools),
        calls: structuredClone(fixture.state.reads.slice(before)),
        writes: structuredClone(fixture.state.writes.slice(writesBefore)),
        evidence: structuredClone(fixture.state.reads.slice(before).map((r) => r.result)),
        tool_results: tools,
        local_calls: tools.filter((c: any) => c.name === 'recall_business_context'),
        proposed_tools: structuredClone(record.proposedTools.slice(proposalsBefore)),
        protected: !!reply.businessEvidence,
        state: fixture.snapshot(),
      };
      record.turns.push(turn);
      record.checks.push(
        ...(hooks.checks
          ? hooks.checks(index, fixture, turn)
          : transcriptChecks(scenario, index, fixture, turn)),
      );
      history.push(
        { role: 'user', content: text },
        {
          role: 'assistant',
          content: reply.businessEvidence ? PRIVATE_HISTORY_REPLY : reply.text,
          ...(reply.businessEvidence
            ? { protectedReply: { text: reply.text, receipt: reply.businessEvidence } }
            : {}),
        },
      );
    }
  } catch (error) {
    record.checks.push('trial_error');
    record.error = {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
  record.durationMs = Date.now() - started;
  record.passed = record.checks.length === 0 && record.turns.length === scenario.turns.length;
  return record;
}
