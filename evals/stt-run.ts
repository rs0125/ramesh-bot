/** Paid synthetic speech regression comparison through the real media adapter; no WhatsApp. */
import { createEvalUsageMeter, evalBudgetOptions, settleEvalWorkers } from './lib/usage-budget.js';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { config as dotenv } from 'dotenv';
import { STT_CASES } from './stt-cases.js';
import { loadAssistantConfig } from '../src/config/assistant.js';
import { OpenAIMediaProcessor } from '../src/infrastructure/openai/media-processor.js';
import { assertEvalRun, evalPolicyOptions } from './lib/run-policy.js';
dotenv({ path: new URL('../.env', import.meta.url), quiet: true });
const { values } = parseArgs({
  options: {
    ...evalPolicyOptions,
    ...evalBudgetOptions,
    case: { type: 'string' },
    models: { type: 'string', default: 'gpt-4o-transcribe,gpt-4o-mini-transcribe,gpt-transcribe' },
    trials: { type: 'string', default: '1' },
  },
});
const models = values.models!.split(',');
const trials = Number(values.trials);
if (
  !models.length ||
  models.length > 5 ||
  models.some((m) => !/^[a-zA-Z0-9._-]{1,100}$/.test(m)) ||
  !Number.isInteger(trials) ||
  trials < 1 ||
  trials > 5
)
  throw new Error('INVALID_STT_EVAL_OPTIONS');
const cases = STT_CASES.filter((c) => !values.case || values.case.split(',').includes(c.id));
assertEvalRun(models, cases.length * trials * models.length, values);
const loaded = loadAssistantConfig();
if (!loaded) throw new Error('OPENAI_API_KEY_REQUIRED');
const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
const directory = new URL(`../.local/stt-evals/${runId}/`, import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
const usageMeter = await createEvalUsageMeter(
  { ...values, campaignId: runId, directory },
  process.env,
  models,
);
const config = { ...loaded, usageMeter };
const run = promisify(execFile);
const recordings: Array<{ id: string; bytes: Buffer; duration: number; hash: string }> = [];
for (const c of cases) {
  const files: string[] = [];
  for (const [i, segment] of c.segments.entries()) {
    const file = new URL(`${c.id}-${i}.wav`, directory).pathname;
    await run('espeak-ng', ['-v', segment.voice, '-s', '145', '-w', file, '--', segment.text], {
      timeout: 10000,
    });
    files.push(file);
  }
  const output = new URL(`${c.id}.ogg`, directory).pathname;
  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      ...files.flatMap((f) => ['-i', f]),
      '-filter_complex',
      `${files.map((_, i) => `[${i}:a]`).join('')}concat=n=${files.length}:v=0:a=1[a]`,
      '-map',
      '[a]',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      '16k',
      output,
    ],
    { timeout: 30000 },
  );
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    output,
  ]);
  const bytes = await readFile(output);
  recordings.push({
    id: c.id,
    bytes,
    duration: Number(stdout.trim()),
    hash: createHash('sha256').update(bytes).digest('hex'),
  });
}
const results: any[] = [];
// Run in rotation, with bounded concurrency. Keep failures and do not reroll transcripts.
const jobs = Array.from({ length: trials }, (_, trial) =>
  cases.flatMap((c) => models.map((model) => ({ c, model, trial: trial + 1 }))),
).flat();
const usageBudget = await settleEvalWorkers(
  usageMeter,
  Array.from({ length: 1 }, async () => {
    for (;;) {
      const item = jobs.shift();
      if (!item) return;
      const { c, model, trial } = item;
      const recording = recordings.find((r) => r.id === c.id)!;
      const started = Date.now();
      const row: any = {
        case: c.id,
        model,
        trial,
        audioHash: recording.hash,
        audioSeconds: recording.duration,
      };
      try {
        row.transcript = await new OpenAIMediaProcessor(config, model).extract(
          { bytes: recording.bytes, mime: 'audio/ogg', name: `${c.id}.ogg` },
          AbortSignal.timeout(90000),
        );
        row.checks = c.checks.map((pattern) => ({
          pattern: pattern.source,
          passed: pattern.test(row.transcript.normalize('NFKC')),
        }));
        row.passed = row.checks.every((check: any) => check.passed);
      } catch (e) {
        row.passed = false;
        row.error = {
          code: 'STT_REQUEST_FAILED',
          status: e && typeof e === 'object' && 'status' in e ? e.status : undefined,
        };
      }
      row.durationMs = Date.now() - started;
      results.push(row);
      await appendFile(new URL('trials.ndjson', directory), JSON.stringify(row) + '\n', {
        mode: 0o600,
      });
      console.log(
        `${row.passed ? 'PASS' : 'FAIL'} ${c.id} ${model} ${trial}${row.error ? ' status=' + row.error.status : ''}`,
      );
    }
  }),
);
await writeFile(
  new URL('report.json', directory),
  JSON.stringify(
    {
      runId,
      usageBudget,
      models,
      trials,
      references: STT_CASES.map((c) => ({ id: c.id, segments: c.segments })),
      results,
      limitation:
        'Synthetic speech semantic smoke tests, not real-voice WER or proof of multilingual production accuracy. Latency includes upload and provider processing; synthetic encoding occurs before timing. Every trial retained.',
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(`Report: ${directory.pathname}report.json`);
if (results.some((r) => !r.passed)) process.exitCode = 1;
