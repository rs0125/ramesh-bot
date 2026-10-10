/** Paid real-model conversational evals. Synthetic CRM/supply, no transport, retained failed trials. */
import { createEvalUsageMeter, evalBudgetOptions, settleEvalWorkers } from './lib/usage-budget.js';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, appendFile, writeFile, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promptManifest } from '../src/modules/assistant/prompt-files.js';
import { JOURNEY_CASES } from './journey-cases.js';
import { ADVERSARIAL_CASES } from './adversarial-cases.js';
import { PAGINATION_CASES } from './pagination-cases.js';
import { RECOVERY_CASES } from './recovery-cases.js';
import { LATENCY_CASES } from './latency-cases.js';
import { CRITERIA } from './lib/judge.js';
import { judgeTurns } from './lib/turn-judge.js';
import { satisfiesToolCheck } from './lib/tool-contracts.js';
import { traceViolations } from './lib/trace-checks.js';
import { emptyUsage, addUsage } from './lib/usage.js';
import { writeEvalReports } from './lib/report.js';
import { captureEvalProvenance } from './lib/provenance.js';
import { config as dotenv } from 'dotenv';
import {
  assistantModels,
  modelForStage,
  loadAssistantConfig,
  effectiveReasoningEffort,
} from '../src/config/assistant.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { AssistantService } from '../src/modules/assistant/assistant.service.js';
import { PRIVATE_HISTORY_REPLY } from '../src/modules/assistant/conversation-memory.js';
import type {
  ChatMessage,
  TextModel,
  ToolSessionRequest,
} from '../src/modules/assistant/assistant.types.js';
import { createSalesFixture, FIXTURE_JID } from '../scripts/lib/sales-fixture.js';
import { SALES_PROMPT_VERSION } from '../src/modules/assistant/sales-prompts.js';
import { styleViolations } from '../src/modules/assistant/style.js';
import { indiaDate } from '../src/modules/assistant/followups.js';
import { CONVERSATION_CASES, type ConversationCase } from './conversation-cases.js';
import {
  SMOKE_CASES,
  isDelegatedSmokeCase,
  type SmokeCase,
  type SmokePersonalCase,
  type SmokeRfqCase,
} from './smoke-cases.js';
import { runTranscriptTrial, validateTranscriptCatalogue } from './lib/transcript-trial.js';
import { FALLBACK_REPLY, personalSmokeChecks, rfqSmokeChecks } from './lib/smoke-checks.js';
import {
  assertEvalRun,
  evalModel,
  DEFAULT_EVAL_MODEL,
  evalPolicyOptions,
} from './lib/run-policy.js';

dotenv({ path: new URL('../.env', import.meta.url), quiet: true });
const { values } = parseArgs({
  options: {
    ...evalPolicyOptions,
    ...evalBudgetOptions,
    trials: { type: 'string', default: '1' },
    case: { type: 'string' },
    suite: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '1' },
    output: { type: 'string' },
    model: { type: 'string' },
    'tool-effort': { type: 'string' },
    'judge-model': { type: 'string', default: DEFAULT_EVAL_MODEL },
    list: { type: 'boolean', default: false },
  },
});
const trials = Number(values.trials);
if (!Number.isInteger(trials) || trials < 1 || trials > 5) throw new Error('Use 1–5 trials');
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
  throw new Error('Use concurrency 1–4');
if (
  ![
    'all',
    'conversation',
    'journeys',
    'adversarial',
    'pagination',
    'recovery',
    'latency',
    'smoke',
  ].includes(values.suite!)
)
  throw new Error('Unknown suite');
// `all` stays the CI pool; the smoke suite is a separate fixed screen (see evals/smoke-cases.ts).
const poolCases: readonly (ConversationCase | SmokeCase)[] =
  values.suite === 'smoke'
    ? SMOKE_CASES
    : values.suite === 'latency'
      ? LATENCY_CASES
      : values.suite === 'conversation'
        ? CONVERSATION_CASES
        : values.suite === 'journeys'
          ? JOURNEY_CASES
          : values.suite === 'adversarial'
            ? ADVERSARIAL_CASES
            : values.suite === 'pagination'
              ? PAGINATION_CASES
              : values.suite === 'recovery'
                ? RECOVERY_CASES
                : [
                    ...CONVERSATION_CASES,
                    ...JOURNEY_CASES,
                    ...ADVERSARIAL_CASES,
                    ...PAGINATION_CASES,
                    ...RECOVERY_CASES,
                    ...LATENCY_CASES,
                  ];
const filters = values.case?.split(',').map((value) => value.trim());
const cases = poolCases.filter(
  (c) => !filters || filters.includes(c.id) || filters.includes(c.category ?? ''),
);
if (values.list) {
  console.log(cases.map((c) => c.id).join('\n'));
  process.exit(0);
}
if (!cases.length) throw new Error('Unknown case');
const selectedModel = evalModel(values.model);
const spendingPolicy = assertEvalRun(
  [selectedModel, values['judge-model']!],
  cases.length * trials,
  values,
);
const smokeRfqCases = cases.filter(
  (c): c is SmokeRfqCase => isDelegatedSmokeCase(c) && c.runner === 'transcript',
);
const smokePersonalCases = cases.filter(
  (c): c is SmokePersonalCase => isDelegatedSmokeCase(c) && c.runner === 'scheduling',
);
if (smokePersonalCases.length && !process.env.TEST_MESSAGE_DATABASE_URL)
  throw new Error(
    'SMOKE_LOCAL_DATABASE_REQUIRED: personal reminder/task cases need TEST_MESSAGE_DATABASE_URL for a disposable local ramesh_queue_test database. No model request was sent.',
  );
const loaded = loadAssistantConfig({
  ...process.env,
  OPENAI_MODEL: selectedModel,
  ...(values['tool-effort'] ? { AGENT_TOOL_REASONING_EFFORT: values['tool-effort'] } : {}),
});
if (!loaded) throw new Error('OPENAI_API_KEY is required; do not pass it as a command argument');
// Construct the RFQ write catalogue for the provider before any paid request.
if (smokeRfqCases.length)
  await validateTranscriptCatalogue('rfq', loaded.toolLoadingMode ?? 'eager');
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const directory = values.output
  ? pathToFileURL(join(resolve(values.output), runId) + '/')
  : new URL(`../.local/conversation-evals/${runId}/`, import.meta.url);
const judgePrompt = await readFile(new URL('./prompts/journey-judge.md', import.meta.url), 'utf8');
const startedAt = Date.now();
await mkdir(directory, { recursive: true, mode: 0o700 });
const usageMeter = await createEvalUsageMeter(
  { ...values, campaignId: runId, directory },
  process.env,
  [...assistantModels(loaded), values['judge-model']!],
);
const config = { ...loaded, timeoutMs: 240000, maxOutputTokens: 6000, usageMeter };
const provider = new OpenAITextModel(config);
const judgeLoaded = loadAssistantConfig({ ...process.env, OPENAI_MODEL: values['judge-model'] })!;
const judgeProvider = new OpenAITextModel({
  ...judgeLoaded,
  usageMeter,
  timeoutMs: 90000,
  maxOutputTokens: 5000,
});

const manifest = promptManifest();
const metadata = {
  usageBudget: usageMeter.manifest,
  spendingPolicy,
  runId,
  startedAt: new Date(startedAt).toISOString(),
  syntheticClock: '2026-10-02T09:00:00Z; +1 minute per user turn',
  ...(smokeRfqCases.length || smokePersonalCases.length
    ? {
        delegatedClocks: {
          transcript: '2026-10-06T09:00:00Z; +1 minute per user turn (synthetic CRM writes)',
          scheduling:
            'actual admission time; disposable local PostgreSQL queue lease and personal rows',
        },
      }
    : {}),
  model: config.model,
  modelRouting: config.modelRouting,
  models: assistantModels(config),
  toolLoadingMode: provider.toolLoadingMode,
  judgeModel: judgeLoaded.model,
  reasoningEfforts: {
    toolLoop: config.toolReasoningEffort ?? 'medium',
    verifier: 'medium',
    businessFormatter: 'low',
    ordinaryFormatter: effectiveReasoningEffort(modelForStage(config, 'formatter'), 'none'),
    judge: 'medium',
  },
  promptVersion: SALES_PROMPT_VERSION,
  promptHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  promptManifest: manifest,
  judgeHash: createHash('sha256').update(judgePrompt).digest('hex'),
  ...(await captureEvalProvenance(new URL('../', import.meta.url))),
  trials,
  concurrency,
  scenarios: cases.map((c) => c.id),
  limits: { timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens },
};
await writeFile(new URL('run-metadata.json', directory), JSON.stringify(metadata, null, 2), {
  mode: 0o600,
});
/** Records agent usage, proposals and accepted tool outputs for one trial. */
function recordingModel(record: any): TextModel {
  return {
    toolLoadingMode: provider.toolLoadingMode,
    startToolSession(request) {
      const session = provider.startToolSession(request);
      return {
        async next(remaining, signal, allowedTools) {
          const next = await session.next(remaining, signal, allowedTools);
          addUsage(record.usage, next);
          addUsage(record.agentUsage, next);
          record.proposedTools.push(
            ...next.calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
          );
          if (next.text) record.modelOutputs.push({ stage: 'worker', text: next.text });
          return next;
        },
        accept(id, output) {
          const proposal = record.proposedTools.filter((c: any) => c.id === id).at(-1);
          record.toolResults.push({ ...proposal, output: structuredClone(output) });
          if (proposal?.name === 'recall_business_context')
            record.localTools.push({ ...proposal, output: structuredClone(output) });
          session.accept(id, output);
        },
        revise: (feedback) => session.revise!(feedback),
      };
    },
    async complete(request, signal) {
      const response = await provider.complete(request, signal);
      addUsage(record.usage, response);
      addUsage(record.agentUsage, response);
      if (request.stage === 'verifier') record.modelReviews.push(response.text);
      record.modelOutputs.push({ stage: request.stage, text: response.text });
      return response;
    },
  };
}

async function judgeDelegated(
  record: any,
  expectations: readonly string[],
  category: string,
): Promise<void> {
  try {
    record.judge = await judgeTurns(
      judgeProvider,
      judgePrompt,
      expectations,
      record.turns,
      AbortSignal.timeout(90000 * Math.max(1, record.turns.length)),
      (result) => {
        addUsage(record.usage, result);
        addUsage(record.judgeUsage, result);
      },
      category,
    );
    for (const turn of record.judge.turns)
      for (const key of CRITERIA)
        if (!turn[key]) record.checks.push(`turn${turn.turn}:judge:${key}`);
  } catch (error) {
    record.checks.push('judge_error');
    record.judgeError =
      error instanceof Error && /^INVALID_JUDGE_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'JUDGE_FAILED';
  }
}

/** Smoke RFQ case: production graph and write service over the synthetic transcript CRM. */
async function smokeRfqTrial(scenario: SmokeRfqCase, trial: number) {
  const started = Date.now();
  const record = await runTranscriptTrial(scenario, provider, config, {
    beforeTurn: (index, fixture) => {
      if (index === scenario.effects.uncertainCreateTurn) fixture.state.uncertainNextCreate = true;
    },
    checks: (index, fixture, turn) => rfqSmokeChecks(scenario.effects, index, fixture, turn),
  });
  record.trial = trial;
  record.category = scenario.category;
  if (record.turns.length === scenario.turns.length)
    await judgeDelegated(record, scenario.expectations, scenario.category);
  record.durationMs = Date.now() - started;
  record.passed = record.checks.length === 0 && record.turns.length === scenario.turns.length;
  return record;
}

/** Personal tools commit only under a leased inbound row: one disposable local database per run. */
let smokeDatabase:
  | Promise<{
      database: import('./lib/scheduling-trial.js').SchedulingDatabase;
      key: string;
      cipher: ReturnType<typeof import('../src/infrastructure/database/auth-store.js').authCipher>;
    }>
  | undefined;
async function openSmokeDatabase() {
  const [{ temporaryMessageDatabase }, { authCipher }] = await Promise.all([
    import('../tests/fixtures/message-database.js'),
    import('../src/infrastructure/database/auth-store.js'),
  ]);
  const database = await temporaryMessageDatabase();
  const key = randomBytes(32).toString('base64url');
  return { database, key, cipher: authCipher(key) };
}

/** Open pools keep the process alive, so the disposable database is always dropped. */
async function closeSmokeDatabase() {
  const opened = await smokeDatabase?.catch(() => undefined);
  if (opened)
    await opened.database
      .close()
      .catch(() =>
        console.error('Smoke database cleanup failed; drop leftover ramesh_test_* databases.'),
      );
}

/** Smoke personal case: the scheduling trial, optionally with synthetic CRM reads. */
async function smokePersonalTrial(scenario: SmokePersonalCase, trial: number) {
  const started = Date.now();
  const record: any = {
    case: scenario.id,
    trial,
    passed: false,
    checks: [],
    turns: [],
    modelReviews: [],
    modelOutputs: [],
    proposedTools: [],
    localTools: [],
    toolResults: [],
    category: scenario.category,
    usage: emptyUsage(),
    agentUsage: emptyUsage(),
    judgeUsage: emptyUsage(),
  };
  try {
    const { runSchedulingTrial } = await import('./lib/scheduling-trial.js');
    const db = await (smokeDatabase ??= openSmokeDatabase()).catch(() => {
      throw new Error('SMOKE_LOCAL_DATABASE_UNAVAILABLE');
    });
    const run = await runSchedulingTrial({
      ...db,
      config,
      model: recordingModel(record),
      messages: scenario.turns,
      signal: new AbortController().signal,
      deadlineMs: config.timeoutMs,
      record: (event) =>
        appendFile(
          new URL(`${scenario.id}-${trial}.trace.ndjson`, directory),
          `${JSON.stringify(event)}\n`,
          { mode: 0o600 },
        ),
      expectedDueAt: scenario.personal.dueAt,
      businessReads: scenario.businessReads ? (now) => createSalesFixture(now).service : undefined,
    });
    const admitted = run.members.at(-1)?.receivedAtMs ?? Date.now();
    record.turns.push({
      text: scenario.turns[0],
      clock: {
        instant: new Date(admitted).toISOString(),
        timezone: 'Asia/Kolkata',
        local_date: indiaDate(admitted),
      },
      authorization: { active_employee: true, audience: 'dm' },
      reply: run.reply ?? '',
      trace: run.trace,
      proposed_tools: structuredClone(record.proposedTools),
      tool_results: structuredClone(record.toolResults),
      evidence: record.toolResults.map((r: any) => r.output),
      persisted: run.persisted,
      expected_due_at: run.expectedDueAt,
      capture_state: run.captureState,
    });
    if (run.error) record.error = { name: 'SchedulingTrialError', code: run.error };
    record.checks.push(...run.checks, ...personalSmokeChecks(scenario, run));
    if (run.reply !== undefined)
      await judgeDelegated(record, scenario.expectations, scenario.category);
  } catch (error) {
    record.error = {
      name: error instanceof Error ? error.name : 'UnknownError',
      code:
        error instanceof Error && error.message === 'SMOKE_LOCAL_DATABASE_UNAVAILABLE'
          ? error.message
          : 'TRIAL_ERROR',
    };
    record.checks.push('trial_error');
  }
  record.durationMs = Date.now() - started;
  record.passed = record.checks.length === 0;
  return record;
}

const syntheticInstant = Date.parse('2026-10-02T09:00:00Z');
const results: any[] = [];
const jobs = cases.flatMap((scenario) =>
  Array.from({ length: trials }, (_, i) => ({ scenario, trial: i + 1 })),
);
console.log(
  `Conversation evals: ${jobs.length} trials using ${config.model}; synthetic data, no WhatsApp.`,
);
const usageBudget = await settleEvalWorkers(
  usageMeter,
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const item = jobs.shift();
      if (!item) return;
      const { scenario, trial } = item;
      if (isDelegatedSmokeCase(scenario)) {
        const record =
          scenario.runner === 'transcript'
            ? await smokeRfqTrial(scenario, trial)
            : await smokePersonalTrial(scenario, trial);
        results.push(record);
        await appendFile(new URL('trials.ndjson', directory), `${JSON.stringify(record)}\n`, {
          mode: 0o600,
        });
        console.log(
          `${record.passed ? 'PASS' : 'FAIL'} ${scenario.id} ${trial}${record.checks.length ? ` (${record.checks.join(', ')})` : ''}`,
        );
        continue;
      }
      let turnTime = syntheticInstant;
      const fixture = createSalesFixture(() => turnTime);
      scenario.setup?.(fixture.state);
      const trialStarted = Date.now();
      const history: ChatMessage[] = [];
      let availableTools: ToolSessionRequest['tools'] = [];
      const record: any = {
        case: scenario.id,
        trial,
        passed: false,
        checks: [],
        turns: [],
        modelReviews: [],
        modelOutputs: [],
        proposedTools: [],
        localTools: [],
        toolResults: [],
        category: scenario.category ?? 'crm',
        usage: emptyUsage(),
        agentUsage: emptyUsage(),
        judgeUsage: emptyUsage(),
      };
      const model = recordingModel(record);
      const assistant = new AssistantService(
        config,
        model,
        undefined,
        undefined,
        async () => history.slice(-32),
        fixture.service,
        {
          now: () => turnTime,
          observeContext: (context) => {
            availableTools = context.tools;
          },
        },
      );
      try {
        for (let index = 0; index < scenario.turns.length; index++) {
          turnTime = syntheticInstant + index * 60000;
          availableTools = [];
          scenario.beforeTurn?.(index, fixture.state);
          if (index === 1 && scenario.filler)
            for (let n = 0; n < scenario.filler; n++)
              history.push(
                { role: 'user', content: `Acknowledged ${n + 1}.` },
                { role: 'assistant', content: 'Okay.' },
              );
          if (index === 1 && scenario.revoke) fixture.state.active = false;
          if (index === 1 && scenario.change)
            fixture.state.visibleLeadIds = ['00000000-0000-4000-8000-000000000102'];
          const before = fixture.state.calls.length;
          const evidenceBefore = fixture.state.evidence.length;
          const localToolsBefore = record.localTools.length;
          const proposedToolsBefore = record.proposedTools.length;
          const toolResultsBefore = record.toolResults.length;
          const text = scenario.turns[index]!;
          const clock = {
            instant: new Date(turnTime).toISOString(),
            timezone: 'Asia/Kolkata',
            local_date: indiaDate(turnTime),
          };
          const reply = await assistant.prepare(
            {
              chatId: scenario.group ? 'fixture@g.us' : FIXTURE_JID,
              messageId: randomUUID(),
              text,
              sentAtMs: Date.now(),
              fromMe: false,
              isGroup: scenario.group === true,
              mentionsBot: scenario.group === true,
            },
            undefined,
            {
              key: { remoteJid: scenario.group ? 'fixture@g.us' : FIXTURE_JID },
              runId: randomUUID(),
            },
          );
          const calls = structuredClone(fixture.state.calls.slice(before));
          record.turns.push({
            text,
            clock,
            authorization: {
              active_employee: fixture.state.active,
              audience: scenario.group ? 'group' : 'dm',
            },
            available_tools: structuredClone(availableTools),
            reply: reply.text,
            trace: reply.trace,
            calls,
            local_calls: structuredClone(record.localTools.slice(localToolsBefore)),
            proposed_tools: structuredClone(record.proposedTools.slice(proposedToolsBefore)),
            tool_results: structuredClone(record.toolResults.slice(toolResultsBefore)),
            evidence: structuredClone(fixture.state.evidence.slice(evidenceBefore)),
          });
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
          record.checks.push(
            ...styleViolations(reply.text, 12000).map((c) => `turn${index + 1}:${c}`),
          );
          if (
            reply.trace.outcome !== 'completed' &&
            !(scenario.unavailableTurns ?? []).includes(index)
          )
            record.checks.push(`turn${index + 1}:incomplete`);
          if (/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i.test(reply.text))
            record.checks.push(`turn${index + 1}:deal_uuid`);
          if ('runner' in scenario && FALLBACK_REPLY.test(reply.text))
            record.checks.push(`turn${index + 1}:fallback_reply`);
          if (/^\s*\|.*\|\s*$/m.test(reply.text) || /```/.test(reply.text))
            record.checks.push(`turn${index + 1}:desktop_or_code_format`);
          if (index === 0 && !scenario.generic) {
            const search = calls.find((c) => c.tool === 'search_crm_leads');
            if (search?.args.sort !== 'created_desc' || search.args.stage !== 'RFQ_RECEIVED')
              record.checks.push('wrong_latest_new_rfq_query');
            if (!/Created\s*:/i.test(reply.text) || !/Last updated\s*:/i.test(reply.text))
              record.checks.push('missing_deal_dates');
            if (reply.text.indexOf('Beacon') > reply.text.indexOf('Acme'))
              record.checks.push('wrong_deal_order');
            if (!/13\s+Sep(?:t)?(?:ember)?\s+2026/i.test(reply.text))
              record.checks.push('wrong_ist_creation_date');
          }
          if (
            index === scenario.turns.length - 1 &&
            scenario.revoke &&
            (calls.length || /Acme|Beacon/.test(reply.text))
          )
            record.checks.push('private_history_leak');
          if (index === scenario.turns.length - 1 && scenario.change && /Acme/.test(reply.text))
            record.checks.push('stale_selection_replayed');
          if (index === 1 && scenario.ordinal && !reply.text.includes('Acme'))
            record.checks.push('lost_ordinal');
        }
        if (scenario.supply) {
          if (!fixture.state.calls.some((c) => c.tool === 'search_warehouses'))
            record.checks.push('missing_supply_search');
          if (!record.proposedTools.some((c: any) => c.name === 'recall_business_context'))
            record.checks.push('missing_recall');
          const comparison = scenario.ownerQuestions
            ? record.turns[1].reply
            : record.turns.at(-1).reply;
          if ([101, 102, 103, 104, 105].some((id) => !new RegExp(`\\b${id}\\b`).test(comparison)))
            record.checks.push('missing_five_candidate_ids');
          if (!/\bpros?\s*:/i.test(comparison) || !/\bcons?\s*:/i.test(comparison))
            record.checks.push('missing_pros_cons');
        }
        for (const check of scenario.toolChecks ?? []) {
          const turn = record.turns[check.turn];
          if (!turn || !satisfiesToolCheck(check, turn.calls, turn.clock.instant))
            record.checks.push(`turn${check.turn + 1}:tool_contract:${check.name}`);
        }
        record.checks.push(...traceViolations(scenario.traceChecks ?? [], record.turns));
        if (
          scenario.noReads &&
          fixture.state.calls.some((call) => !scenario.allowedReads?.includes(call.tool))
        )
          record.checks.push('unnecessary_reads');
        const finalReply = record.turns.at(-1)?.reply ?? '';
        for (const pattern of scenario.contains ?? [])
          if (!pattern.test(finalReply)) record.checks.push(`missing:${pattern.source}`);
        for (const pattern of scenario.excludes ?? [])
          if (pattern.test(finalReply)) record.checks.push(`forbidden:${pattern.source}`);
        if (scenario.maxReplyChars && finalReply.length > scenario.maxReplyChars)
          record.checks.push('reply_too_long');
        record.judge = await judgeTurns(
          judgeProvider,
          judgePrompt,
          scenario.expectations ?? scenario.expectation,
          record.turns,
          AbortSignal.timeout(90000 * Math.max(1, record.turns.length)),
          (result) => {
            addUsage(record.usage, result);
            addUsage(record.judgeUsage, result);
          },
          scenario.category ?? 'crm',
        );
        for (const turn of record.judge.turns)
          for (const key of CRITERIA)
            if (!turn[key]) record.checks.push(`turn${turn.turn}:judge:${key}`);
        record.passed = record.checks.length === 0;
      } catch (error) {
        record.error = {
          name: error instanceof Error ? error.name : 'UnknownError',
          code:
            error instanceof Error && /^INVALID_JUDGE_[A-Z_]+$/.test(error.message)
              ? error.message
              : 'TRIAL_ERROR',
        };
        record.checks.push('trial_error');
      }
      record.durationMs = Date.now() - trialStarted;
      results.push(record);
      await appendFile(new URL('trials.ndjson', directory), `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      });
      console.log(
        `${record.passed ? 'PASS' : 'FAIL'} ${scenario.id} ${trial}${record.checks.length ? ` (${record.checks.join(', ')})` : ''}`,
      );
    }
  }),
).finally(closeSmokeDatabase);
const sumUsage = (field: string) =>
  results.reduce((total, row) => {
    for (const key of Object.keys(total) as Array<keyof typeof total>)
      total[key] += row[field][key];
    return total;
  }, emptyUsage());
const finalInputs = await captureEvalProvenance(new URL('../', import.meta.url));
const changedInputs = [
  ...new Set([...Object.keys(metadata.inputManifest), ...Object.keys(finalInputs.inputManifest)]),
].filter((path) => metadata.inputManifest[path] !== finalInputs.inputManifest[path]);
const report = {
  ...metadata,
  usageBudget,
  inputIntegrity: changedInputs.length === 0,
  changedInputs,
  durationMs: Date.now() - startedAt,
  trials,
  concurrency,
  usage: sumUsage('usage'),
  agentUsage: sumUsage('agentUsage'),
  judgeUsage: sumUsage('judgeUsage'),
  passed: results.filter((r) => r.passed).length,
  total: results.length,
  results,
};
await writeEvalReports(directory, report);
console.log(`${report.passed}/${report.total} passed. Report: ${directory.pathname}report.json`);
if (!report.inputIntegrity)
  console.error(
    'Run inputs changed during evaluation; results cannot be used as a frozen-snapshot baseline.',
  );
if (report.passed !== report.total || !report.inputIntegrity) process.exitCode = 1;
