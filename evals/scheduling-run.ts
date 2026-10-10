/** Opt-in Luna prose checks: synthetic identities + disposable local PostgreSQL + captured replies. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { config as dotenv } from 'dotenv';
import { assistantModels, loadAssistantConfig } from '../src/config/assistant.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import type { AgentTrace } from '../src/modules/assistant/assistant.types.js';
import { authCipher } from '../src/infrastructure/database/auth-store.js';
import { promptManifest } from '../src/modules/assistant/prompt-files.js';
import { temporaryMessageDatabase } from '../tests/fixtures/message-database.js';
import { captureEvalProvenance } from './lib/provenance.js';
import { assertEvalRun, evalModel, evalPolicyOptions } from './lib/run-policy.js';
import { createEvalUsageMeter, evalBudgetOptions, settleEvalWorkers } from './lib/usage-budget.js';
import { runSchedulingTrial, safeError } from './lib/scheduling-trial.js';
import {
  truthfulConditionalLimitation,
  type PersistedPersonalState,
} from './lib/scheduling-outcomes.js';

export const SCHEDULING_EVAL_CASES = [
  {
    id: 'hinglish-relative',
    messages: ['Parso subah 10 baje owner ko call karne ka reminder laga de.'],
    expected: 'reminder',
  } as const,
  {
    id: 'burst-correction',
    messages: ['Remind me in 20 minutes to call the owner.', 'Actually make that 40 minutes.'],
    expected: 'reminder',
  } as const,
  {
    id: 'conditional-unsupported',
    messages: ['Remind me tomorrow at 9 am only if that deal still has no follow-up.'],
    expected: 'no-write',
  } as const,
];
type Scenario = (typeof SCHEDULING_EVAL_CASES)[number];

/** Independent time oracle: local IST calendar arithmetic, never calls the implementation normalizer. */
export function expectedReminderInstant(
  caseId: string,
  memberClocks: number[],
): string | undefined {
  if (caseId === 'burst-correction')
    return new Date(memberClocks.at(-1)! + 40 * 60000).toISOString();
  if (caseId === 'hinglish-relative') {
    const date = new Date(memberClocks[0]! + 330 * 60000).toISOString().slice(0, 10);
    const dayAfter = new Date(Date.parse(`${date}T00:00:00Z`) + 2 * 86400000)
      .toISOString()
      .slice(0, 10);
    return new Date(`${dayAfter}T10:00:00+05:30`).toISOString();
  }
  return undefined;
}
interface TrialResult {
  case: string;
  trial: number;
  passed: boolean;
  checks: string[];
  error?: string;
  reply?: string;
  trace?: AgentTrace;
  expectedDueAt?: string;
  persisted?: PersistedPersonalState;
  captureState?: string;
}

export async function runSchedulingEvaluation() {
  dotenv({ path: new URL('../.env', import.meta.url), quiet: true });
  const { values } = parseArgs({
    options: {
      ...evalPolicyOptions,
      ...evalBudgetOptions,
      model: { type: 'string' },
      case: { type: 'string' },
      trials: { type: 'string', default: '1' },
      'continuation-of': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const trials = Number(values.trials);
  const ids = values.case?.split(',').map((v) => v.trim());
  const cases = SCHEDULING_EVAL_CASES.filter((item) => !ids || ids.includes(item.id));
  if (
    !Number.isSafeInteger(trials) ||
    trials < 1 ||
    !cases.length ||
    cases.length * trials > 3 ||
    ids?.some((id) => !SCHEDULING_EVAL_CASES.some((item) => item.id === id))
  )
    throw new Error(
      'SCHEDULING_EVAL_MAX_THREE_TRIALS: choose known cases and at most three total executions',
    );
  const selectedModel = evalModel(values.model);
  const spendingPolicy = assertEvalRun([selectedModel], cases.length * trials, values);
  if (values['dry-run']) {
    console.log(
      JSON.stringify(
        {
          model: selectedModel,
          toolReasoningEffort: 'low',
          continuationOf: values['continuation-of'],
          ...spendingPolicy,
          cases,
          paidCalls: 0,
          database: 'Disposable local PostgreSQL only',
          transport: 'Captured locally; no Baileys or scheduler',
          deadlineMs: 120000,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!process.env.TEST_MESSAGE_DATABASE_URL)
    throw new Error('SCHEDULING_EVAL_LOCAL_DATABASE_REQUIRED');
  const loaded = loadAssistantConfig({
    ...process.env,
    OPENAI_MODEL: selectedModel,
    AGENT_TOOL_REASONING_EFFORT: 'low',
    AGENT_TIMEOUT_MS: '120000',
    AGENT_MAX_OUTPUT_TOKENS: '2000',
    TAVILY_API_KEY: undefined,
    USAGE_MODE: 'off',
  });
  if (!loaded) throw new Error('SCHEDULING_EVAL_API_KEY_REQUIRED');
  const runId = `scheduling-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const directory = fileURLToPath(new URL(`../.local/evals/${runId}/`, import.meta.url));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const provenance = await captureEvalProvenance(new URL('../', import.meta.url));
  const manifest = {
    runId,
    model: selectedModel,
    toolReasoningEffort: 'low',
    continuationOf: values['continuation-of'],
    deadlineMs: 120000,
    spendingPolicy,
    cases,
    prompts: promptManifest(),
    inputHash: provenance.inputHash,
    datasetHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
    transport:
      'Local captured replies only; no Baileys factory, scheduler, live employee or business database',
  };
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({ ...manifest, inputs: provenance.inputManifest }, null, 2),
    { mode: 0o600, flag: 'wx' },
  );
  const usageMeter = await createEvalUsageMeter(
    { ...values, campaignId: runId, directory },
    process.env,
    assistantModels(loaded),
  );
  const config = { ...loaded, usageMeter };
  const native = new OpenAITextModel(config);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('SCHEDULING_EVAL_INTERRUPTED'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const results: TrialResult[] = [];
  let db: Awaited<ReturnType<typeof temporaryMessageDatabase>> | undefined;
  let fatal: string | undefined;
  let stoppedReason: string | undefined;
  let usageBudget: Awaited<ReturnType<typeof usageMeter.report>> | undefined;
  const started = Date.now();
  console.log(
    `Scheduling eval: ${cases.length * trials} ${selectedModel} trials; synthetic PostgreSQL and capture only.`,
  );
  try {
    db = await temporaryMessageDatabase();
    const database = db;
    const key = randomBytes(32).toString('base64url');
    const cipher = authCipher(key);
    const work = cases.flatMap((scenario) =>
      Array.from({ length: trials }, (_, i) => ({ scenario, trial: i + 1 })),
    );
    usageBudget = await settleEvalWorkers(usageMeter, [
      (async () => {
        for (const item of work) {
          if (controller.signal.aborted) break;
          const { scenario, trial } = item;
          const result: TrialResult = { case: scenario.id, trial, passed: false, checks: [] };
          results.push(result);
          const name = `${scenario.id}-${trial}`;
          const record = async (event: unknown) => {
            await appendFile(
              join(directory, `${name}.trace.ndjson`),
              JSON.stringify(event) + '\n',
              { mode: 0o600 },
            );
          };
          const run = await runSchedulingTrial({
            database,
            key,
            cipher,
            config,
            model: native,
            messages: scenario.messages,
            signal: controller.signal,
            deadlineMs: 120000,
            record,
            expectedDueAt: (clocks) => expectedReminderInstant(scenario.id, clocks),
          });
          result.expectedDueAt = run.expectedDueAt;
          if (run.reply !== undefined) result.reply = run.reply;
          if (run.trace) result.trace = run.trace;
          if (run.captureState) result.captureState = run.captureState;
          if (run.error) result.error = run.error;
          result.checks.push(...run.checks);
          try {
            const persisted = run.persisted;
            if (persisted) {
              result.persisted = persisted;
              if (persisted.tasks !== 0) result.checks.push('unrequested_task_created');
              if (persisted.reminderDeliveries !== 0)
                result.checks.push('future_reminder_enqueued_early');
              if (scenario.expected === 'reminder') {
                if (persisted.reminders.length !== 1 || persisted.commands !== 1)
                  result.checks.push('expected_one_committed_reminder');
                const saved = persisted.reminders[0];
                if (saved?.dueAt !== result.expectedDueAt)
                  result.checks.push('wrong_resolved_instant');
                if (saved?.owner !== 23 || saved.state !== 'scheduled')
                  result.checks.push('wrong_owner_or_state');
                if (
                  typeof saved?.text !== 'string' ||
                  !/(owner)/i.test(saved.text) ||
                  !/call/i.test(saved.text)
                )
                  result.checks.push('wrong_reminder_content');
                if (
                  !/saved reminder/i.test(result.reply ?? '') ||
                  !/(IST|Asia\/Kolkata)/.test(result.reply ?? '')
                )
                  result.checks.push('missing_committed_time_acknowledgement');
              } else {
                if (persisted.reminders.length !== 0 || persisted.commands !== 0)
                  result.checks.push('unsupported_conditional_mutation');
                if (!truthfulConditionalLimitation(result.reply ?? ''))
                  result.checks.push('missing_truthful_conditional_limitation');
              }
            }
          } finally {
            // The shared meter may be caught and rendered as an unavailable reply by
            // the graph. Its terminal stop still ends this campaign immediately.
            const currentUsage = await usageMeter.report();
            if (currentUsage.stoppedReason) {
              stoppedReason = currentUsage.stoppedReason;
              result.error ??= currentUsage.stoppedReason;
              result.checks.push('campaign_stopped_by_usage_meter');
            }
            result.passed = result.checks.length === 0 && !result.error;
            await writeFile(join(directory, `${name}.json`), JSON.stringify(result, null, 2), {
              mode: 0o600,
            });
            await appendFile(join(directory, 'trials.ndjson'), JSON.stringify(result) + '\n', {
              mode: 0o600,
            });
            console.log(
              `${result.passed ? 'PASS' : 'FAIL'} ${name}${result.checks.length ? ` (${result.checks.join(', ')})` : ''}`,
            );
          }
          if (stoppedReason) break;
        }
      })(),
    ]);
  } catch (error) {
    fatal = safeError(error);
  } finally {
    usageBudget ??= await usageMeter.report();
    await db?.close();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    const passed = results.filter((item) => item.passed).length;
    const notRun = cases
      .flatMap((scenario) =>
        Array.from({ length: trials }, (_, i) => ({ case: scenario.id, trial: i + 1 })),
      )
      .filter(
        (item) =>
          !results.some((result) => result.case === item.case && result.trial === item.trial),
      )
      .map((item) => ({
        ...item,
        reason:
          stoppedReason ??
          fatal ??
          (controller.signal.aborted
            ? 'SCHEDULING_EVAL_INTERRUPTED'
            : 'SCHEDULING_EVAL_NOT_STARTED'),
      }));
    const report = {
      ...manifest,
      durationMs: Date.now() - started,
      passed,
      total: results.length,
      planned: cases.length * trials,
      interrupted: controller.signal.aborted,
      fatal,
      stoppedReason,
      usageBudget,
      results,
      notRun,
      limits:
        'Three prose probes are not a production quality gate. No separate paid grader. Persistence/cancellation correctness uses deterministic suites.',
    };
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    await writeFile(
      join(directory, 'report.md'),
      [
        '# Personal scheduling prose evaluation',
        '',
        `Model: ${selectedModel}; tool effort: low. ${passed}/${results.length} passed; ${cases.length * trials} planned.`,
        'Synthetic employee and disposable local PostgreSQL. Replies captured without a WhatsApp session or running scheduler.',
        '',
        ...results.map(
          (item) =>
            `- ${item.passed ? 'PASS' : 'FAIL'} ${item.case} trial ${item.trial}: ${item.checks.join(', ') || 'outcomes matched'}`,
        ),
        ...notRun.map((item) => `- NOT RUN ${item.case} trial ${item.trial}: ${item.reason}`),
        '',
        `Fatal status: ${fatal ?? 'none'}. Budget stop: ${stoppedReason ?? 'none'}. Interrupted: ${controller.signal.aborted}.`,
        'All failed/interrupted attempts and shared usage accounting remain in this directory. No automatic retries of scenarios.',
      ].join('\n'),
      { mode: 0o600 },
    );
    console.log(`Report: ${directory}`);
    if (
      fatal ||
      controller.signal.aborted ||
      results.length !== cases.length * trials ||
      passed !== results.length
    )
      process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runSchedulingEvaluation().catch((error) => {
    console.error(
      `Scheduling eval stopped: ${safeError(error)}. No scenario was automatically retried.`,
    );
    process.exitCode = 1;
  });
