/** Fresh judge calls over ALL answers in a completed public run. No agent rerun or score replacement. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, mkdir, appendFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { config as dotenv } from 'dotenv';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { loadAssistantConfig } from '../src/config/assistant.js';
import { CRITERIA } from './lib/judge.js';
import { judgeTurns } from './lib/turn-judge.js';
import { captureEvalProvenance } from './lib/provenance.js';
import { assertCompletePublicRun, retainedHardChecks } from './lib/regrade.js';
import { writeEvalReports } from './lib/report.js';
import { emptyUsage, addUsage } from './lib/usage.js';
import { CONVERSATION_CASES } from './conversation-cases.js';
import { JOURNEY_CASES } from './journey-cases.js';
import { ADVERSARIAL_CASES } from './adversarial-cases.js';
import { PAGINATION_CASES } from './pagination-cases.js';
import { RECOVERY_CASES } from './recovery-cases.js';
import { assertEvalRun, evalModel, evalPolicyOptions } from './lib/run-policy.js';

dotenv({ path: new URL('../.env', import.meta.url), quiet: true });
const { values } = parseArgs({
  options: {
    ...evalPolicyOptions,
    source: { type: 'string' },
    model: { type: 'string' },
    concurrency: { type: 'string', default: '1' },
  },
});
if (!values.source) throw new Error('--source must name a completed public CI run directory');
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
  throw new Error('Use concurrency 1–4');
const root = new URL('../', import.meta.url);
const allowed = await realpath(new URL('../.local/ci-evals/', import.meta.url));
const sourceDir = await realpath(resolve(values.source));
if (!sourceDir.startsWith(allowed + sep)) throw new Error('PUBLIC_CI_RUN_PATH_REQUIRED');
const sourceBytes = await readFile(resolve(sourceDir, 'report.json'));
const source = JSON.parse(sourceBytes.toString());
assertCompletePublicRun(source);
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
// Old reports did not embed expectations. Their scenario files must still be byte-identical.
for (const path of [
  'evals/conversation-cases.ts',
  'evals/journey-cases.ts',
  'evals/adversarial-cases.ts',
  ...(source.inputManifest?.['evals/pagination-cases.ts'] ? ['evals/pagination-cases.ts'] : []),
  ...(source.inputManifest?.['evals/recovery-cases.ts'] ? ['evals/recovery-cases.ts'] : []),
])
  if (hash(await readFile(new URL(path, root))) !== source.inputManifest?.[path])
    throw new Error('ORIGINAL_SCENARIO_SNAPSHOT_REQUIRED');
const cases = new Map(
  [
    ...CONVERSATION_CASES,
    ...JOURNEY_CASES,
    ...ADVERSARIAL_CASES,
    ...PAGINATION_CASES,
    ...RECOVERY_CASES,
  ].map((c) => [c.id, c]),
);
for (const row of source.results)
  if (!cases.has(row.case)) throw new Error('UNKNOWN_SOURCE_SCENARIO');
const selectedModel = evalModel(values.model);
const spendingPolicy = assertEvalRun([selectedModel], source.results.length, values);
const config = loadAssistantConfig({ ...process.env, OPENAI_MODEL: selectedModel });
if (!config) throw new Error('OPENAI_API_KEY is required through the environment');
const model = new OpenAITextModel({ ...config, timeoutMs: 90000, maxOutputTokens: 5000 });
const prompt = await readFile(new URL('prompts/journey-judge.md', import.meta.url), 'utf8');
const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
const directory = new URL(`../.local/regrades/${runId}/`, import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
const began = Date.now();
const metadata = {
  spendingPolicy,
  runId,
  kind: 'regrade',
  agentRerun: false,
  model: source.model,
  promptHash: source.promptHash,
  promptVersion: source.promptVersion,
  judgeModel: config.model,
  judgeHash: hash(prompt),
  sourceRunId: source.runId,
  sourceReportHash: hash(sourceBytes),
  sourceInputHash: source.inputHash,
  sourceDatasetHash: source.datasetHash,
  ...(await captureEvalProvenance(root)),
};
await writeFile(new URL('run-metadata.json', directory), JSON.stringify(metadata, null, 2), {
  mode: 0o600,
});
const work = [...source.results];
const results: any[] = [];
const usage = emptyUsage();
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (;;) {
      const original = work.shift();
      if (!original) return;
      const started = Date.now();
      const row = {
        ...original,
        originalChecks: original.checks,
        originalJudge: original.judge,
        sourceAnswerHash: hash(JSON.stringify(original.turns)),
        sourceDurationMs: original.durationMs,
        checks: retainedHardChecks(original.checks),
        judge: undefined as unknown,
        judgeUsage: emptyUsage(),
      };
      try {
        if (!original.turns.length) throw new Error('NO_DELIVERED_TURNS');
        const judge = await judgeTurns(
          model,
          prompt,
          cases.get(row.case)!.expectation,
          row.turns,
          AbortSignal.timeout(90000 * row.turns.length),
          (result) => {
            addUsage(usage, result);
            addUsage(row.judgeUsage, result);
          },
          row.category,
        );
        row.judge = judge;
        for (const turn of judge.turns)
          for (const key of CRITERIA)
            if (!turn[key]) row.checks.push(`turn${turn.turn}:judge:${key}`);
      } catch {
        row.checks.push('regrade_error');
      }
      row.passed = !row.checks.length;
      row.durationMs = Date.now() - started;
      results.push(row);
      await appendFile(new URL('trials.ndjson', directory), JSON.stringify(row) + '\n', {
        mode: 0o600,
      });
      console.log(
        `${row.passed ? 'PASS' : 'FAIL'} ${row.case} ${row.trial}${row.checks.length ? ' (' + row.checks.join(', ') + ')' : ''}`,
      );
    }
  }),
);
const finalInputs = await captureEvalProvenance(root);
const sourceUnchanged =
  hash(await readFile(resolve(sourceDir, 'report.json'))) === metadata.sourceReportHash;
const report = {
  ...metadata,
  inputIntegrity: finalInputs.inputHash === metadata.inputHash && sourceUnchanged,
  usage,
  durationMs: Date.now() - began,
  total: results.length,
  passed: results.filter((r) => r.passed).length,
  results,
};
await writeEvalReports(directory, report);
console.log(
  `${report.passed}/${report.total} regraded. No agent calls repeated; original report retained. ${directory.pathname}`,
);
if (report.passed !== report.total || !report.inputIntegrity) process.exitCode = 1;
