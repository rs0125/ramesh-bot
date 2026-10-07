/** Paid transcript-derived trials. Synthetic CRM/journal only; no message transport. */
import { config as dotenv } from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assistantModels, loadAssistantConfig } from '../src/config/assistant.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { TRANSCRIPT_CASES } from './transcript-cases.js';
import { runTranscriptTrial, validateTranscriptCatalogue } from './lib/transcript-trial.js';
import {
  assertEvalRun,
  evalModel,
  evalPolicyOptions,
  DEFAULT_EVAL_MODEL,
} from './lib/run-policy.js';
import { createEvalUsageMeter, evalBudgetOptions, settleEvalWorkers } from './lib/usage-budget.js';
import { captureEvalProvenance } from './lib/provenance.js';
import { promptManifest } from '../src/modules/assistant/prompt-files.js';
import { SALES_PROMPT_VERSION } from '../src/modules/assistant/sales-prompts.js';
import { judgeTurns } from './lib/turn-judge.js';
import { CRITERIA } from './lib/judge.js';
import { addUsage, emptyUsage } from './lib/usage.js';
import { writeEvalReports } from './lib/report.js';

dotenv({ path: new URL('../.env', import.meta.url), quiet: true });
const { values } = parseArgs({
  options: {
    ...evalPolicyOptions,
    ...evalBudgetOptions,
    model: { type: 'string' },
    'judge-model': { type: 'string', default: DEFAULT_EVAL_MODEL },
    case: { type: 'string' },
    output: { type: 'string' },
    list: { type: 'boolean', default: false },
  },
});
const cases = TRANSCRIPT_CASES.filter((c) => !values.case || values.case.split(',').includes(c.id));
if (values.list) {
  console.log(cases.map((c) => `${c.id}: ${c.turns.length} turns\n  ${c.provenance}`).join('\n'));
  process.exit(0);
}
if (!cases.length) throw new Error('UNKNOWN_TRANSCRIPT_CASE');
const loaded = loadAssistantConfig({ ...process.env, OPENAI_MODEL: evalModel(values.model) });
if (!loaded) throw new Error('OPENAI_API_KEY_REQUIRED');
const models = [...assistantModels(loaded), values['judge-model']!];
const spendingPolicy = assertEvalRun(models, cases.length, values);
for (const scenario of cases)
  await validateTranscriptCatalogue(scenario.mode, loaded.toolLoadingMode ?? 'eager');
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const directory = pathToFileURL(resolve(values.output ?? '.local/transcript-evals', runId) + '/');
await mkdir(directory, { recursive: true, mode: 0o700 });
const usageMeter = await createEvalUsageMeter(
  { ...values, campaignId: runId, directory },
  process.env,
  models,
);
const config = { ...loaded, usageMeter, timeoutMs: 240000, maxOutputTokens: 6000 };
const provider = new OpenAITextModel(config);
const judge = new OpenAITextModel({
  ...loadAssistantConfig({ ...process.env, OPENAI_MODEL: values['judge-model'] })!,
  usageMeter,
  timeoutMs: 90000,
  maxOutputTokens: 5000,
});
const judgePrompt = await readFile(new URL('./prompts/journey-judge.md', import.meta.url), 'utf8');
const started = Date.now();
const metadata = {
  runId,
  startedAt: new Date(started).toISOString(),
  model: config.model,
  modelRouting: config.modelRouting,
  models,
  judgeModel: values['judge-model'],
  trials: 1,
  concurrency: 1,
  spendingPolicy,
  usageBudget: usageMeter.manifest,
  promptVersion: SALES_PROMPT_VERSION,
  promptManifest: promptManifest(),
  promptHash: createHash('sha256').update(JSON.stringify(promptManifest())).digest('hex'),
  judgeHash: createHash('sha256').update(judgePrompt).digest('hex'),
  scenarios: cases.map((c) => ({ id: c.id, turns: c.turns.length, provenance: c.provenance })),
  limitations:
    'Production graph and BusinessWriteService; synthetic CRM and source/journal substitutes. Does not test remote persistence, database leases or transport. All dialogue uses fictional records.',
  ...(await captureEvalProvenance(new URL('../', import.meta.url))),
};
await writeFile(new URL('run-metadata.json', directory), JSON.stringify(metadata, null, 2), {
  mode: 0o600,
});
const results: any[] = [];
console.log(
  `Transcript eval: ${cases.length} cases once, ${cases.reduce((sum, c) => sum + c.turns.length, 0)} turns; ${models.join(', ')}. Synthetic writes only.`,
);
const usageBudget = await settleEvalWorkers(usageMeter, [
  (async () => {
    for (const scenario of cases) {
      const record = await runTranscriptTrial(scenario, provider, config);
      // Preserve the agent trace before grading, including failed cases.
      await writeFile(
        new URL(`${scenario.id}.agent.json`, directory),
        JSON.stringify(record, null, 2),
        { mode: 0o600 },
      );
      try {
        if (record.turns.length === scenario.turns.length) {
          record.judge = await judgeTurns(
            judge,
            judgePrompt,
            scenario.expectations,
            record.turns,
            AbortSignal.timeout(90000 * record.turns.length),
            (result) => {
              addUsage(record.usage, result);
              addUsage(record.judgeUsage, result);
            },
            'boundaries',
          );
          for (const turn of record.judge.turns)
            for (const key of CRITERIA)
              if (!turn[key]) record.checks.push(`turn${turn.turn}:judge:${key}`);
        }
      } catch (error) {
        record.checks.push('judge_error');
        record.judgeError = error instanceof Error ? error.message : 'Unknown error';
      }
      record.passed = record.checks.length === 0;
      results.push(record);
      await appendFile(new URL('trials.ndjson', directory), JSON.stringify(record) + '\n', {
        mode: 0o600,
      });
      console.log(
        `${record.passed ? 'PASS' : 'FAIL'} ${scenario.id}${record.checks.length ? `: ${record.checks.join(', ')}` : ''}`,
      );
    }
  })(),
]);
const final = await captureEvalProvenance(new URL('../', import.meta.url));
const changedInputs = [
  ...new Set([...Object.keys(metadata.inputManifest), ...Object.keys(final.inputManifest)]),
].filter((p) => metadata.inputManifest[p] !== final.inputManifest[p]);
const totals = (field: string) =>
  results.reduce((sum, row) => {
    for (const key of Object.keys(sum) as Array<keyof typeof sum>) sum[key] += row[field][key];
    return sum;
  }, emptyUsage());
const report = {
  ...metadata,
  usageBudget,
  durationMs: Date.now() - started,
  inputIntegrity: !changedInputs.length,
  changedInputs,
  usage: totals('usage'),
  agentUsage: totals('agentUsage'),
  judgeUsage: totals('judgeUsage'),
  passed: results.filter((r) => r.passed).length,
  total: results.length,
  results,
};
await writeEvalReports(directory, report);
console.log(`${report.passed}/${report.total} passed. Report: ${directory.pathname}report.json`);
if (report.passed !== report.total || !report.inputIntegrity) process.exitCode = 1;
