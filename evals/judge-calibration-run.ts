/** Paid grader calibration with synthetic known-good/known-bad outcomes; no agent or transport. */
import { createEvalUsageMeter, evalBudgetOptions, settleEvalWorkers } from './lib/usage-budget.js';
import { config as dotenv } from 'dotenv';
import { parseArgs } from 'node:util';
import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { CALIBRATION_CASES } from './judge-calibration-cases.js';
import { CRITERIA } from './lib/judge.js';
import { judgeTurns, type JudgedTurn } from './lib/turn-judge.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { loadAssistantConfig } from '../src/config/assistant.js';
import { writeEvalReports, type EvalTrial } from './lib/report.js';
import { addUsage, emptyUsage } from './lib/usage.js';
import { captureEvalProvenance } from './lib/provenance.js';
import { assertEvalRun, evalModel, evalPolicyOptions } from './lib/run-policy.js';
dotenv({ path: new URL('../.env', import.meta.url), quiet: true });
const { values } = parseArgs({
  options: {
    ...evalPolicyOptions,
    ...evalBudgetOptions,
    trials: { type: 'string', default: '1' },
    case: { type: 'string' },
    model: { type: 'string' },
  },
});
const trials = Number(values.trials);
if (!Number.isInteger(trials) || trials < 1 || trials > 5) throw new Error('Use 1–5 trials');
const cases = CALIBRATION_CASES.filter(
  (c) => !values.case || values.case.split(',').includes(c.id),
);
if (!cases.length) throw new Error('Unknown case');
const selectedModel = evalModel(values.model);
const spendingPolicy = assertEvalRun([selectedModel], cases.length * trials, values);
const config = loadAssistantConfig({ ...process.env, OPENAI_MODEL: selectedModel });
if (!config) throw new Error('OPENAI_API_KEY is required through the environment');
const prompt = await readFile(new URL('./prompts/journey-judge.md', import.meta.url), 'utf8');
const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
const directory = new URL(`../.local/judge-calibration/${runId}/`, import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
const usageMeter = await createEvalUsageMeter(
  { ...values, campaignId: runId, directory },
  process.env,
  [selectedModel],
);
const model = new OpenAITextModel({
  ...config,
  timeoutMs: 90000,
  maxOutputTokens: 5000,
  usageMeter,
});
const started = Date.now(),
  usage = emptyUsage();
const metadata = {
  usageBudget: usageMeter.manifest,
  spendingPolicy,
  runId,
  model: config.model,
  promptHash: createHash('sha256').update(prompt).digest('hex'),
  ...(await captureEvalProvenance(new URL('../', import.meta.url))),
};
await writeFile(new URL('run-metadata.json', directory), JSON.stringify(metadata, null, 2), {
  mode: 0o600,
});
const jobs = cases.flatMap((c) =>
  Array.from({ length: trials }, (_, i) => ({ scenario: c, trial: i + 1 })),
);
const results: EvalTrial[] = [];
const usageBudget = await settleEvalWorkers(
  usageMeter,
  Array.from({ length: 1 }, async () => {
    for (;;) {
      const job = jobs.shift();
      if (!job) return;
      const began = Date.now();
      const { scenario, trial } = job;
      const checks: string[] = [];
      let judge;
      try {
        judge = await judgeTurns(
          model,
          prompt,
          scenario.expectation,
          scenario.turns as JudgedTurn[],
          AbortSignal.timeout(90000 * scenario.turns.length),
          (result) => addUsage(usage, result),
        );
        for (let i = 0; i < scenario.expected.length; i++)
          for (const key of CRITERIA) {
            const expected = scenario.expected[i]![key];
            if (expected !== undefined && judge.turns[i]![key] !== expected)
              checks.push(`turn${i + 1}:${key}:expected_${expected}`);
          }
      } catch {
        checks.push('calibration_error');
      }
      const record = {
        case: scenario.id,
        trial,
        passed: !checks.length,
        checks,
        durationMs: Date.now() - began,
        judge,
      };
      results.push(record);
      await appendFile(new URL('trials.ndjson', directory), JSON.stringify(record) + '\n', {
        mode: 0o600,
      });
      console.log(
        `${record.passed ? 'PASS' : 'FAIL'} ${scenario.id} ${trial}${checks.length ? ' ' + checks.join(', ') : ''}`,
      );
    }
  }),
);
const finalInputs = await captureEvalProvenance(new URL('../', import.meta.url));
const report = {
  ...metadata,
  usageBudget,
  passed: results.filter((r) => r.passed).length,
  total: results.length,
  durationMs: Date.now() - started,
  usage,
  results,
  inputIntegrity: finalInputs.inputHash === metadata.inputHash,
};
await writeEvalReports(directory, report);
console.log(`${report.passed}/${report.total} calibration trials passed. ${directory.pathname}`);
if (report.passed !== report.total || !report.inputIntegrity) process.exitCode = 1;
