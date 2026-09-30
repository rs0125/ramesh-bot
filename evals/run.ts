/** Opt-in, nondeterministic OpenAI evaluations through isolated SQLite and capture-only delivery. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { config as loadEnvironment } from 'dotenv';
import { loadAssistantConfig } from '../src/config/assistant.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { LocalChat, openLocalChatDatabase } from '../scripts/lib/local-chat.js';
import { styleViolations } from '../src/modules/assistant/style.js';
import {
  PROMPT_VERSION,
  CONVERSER_PROMPT,
  FORMATTER_PROMPT,
} from '../src/modules/assistant/prompts.js';
import type { AgentTrace } from '../src/modules/assistant/assistant.types.js';
import { CASES } from './cases.js';
import { judge, type GradeResult } from './judge.js';

loadEnvironment({ path: new URL('../.env', import.meta.url), quiet: true });
const { values } = parseArgs({
  options: {
    trials: { type: 'string', default: '3' },
    case: { type: 'string' },
    split: { type: 'string', default: 'all' },
  },
});
const trials = Number(values.trials);
if (!Number.isInteger(trials) || trials < 1 || trials > 5)
  throw new Error('--trials must be between 1 and 5');
if (!['all', 'core', 'holdout'].includes(values.split)) throw new Error('Invalid --split');
const cases = CASES.filter(
  (item) =>
    (!values.case || item.id === values.case) &&
    (values.split === 'all' || item.split === values.split),
);
if (!cases.length) throw new Error('No matching evaluation cases');
const config = loadAssistantConfig();
if (!config) throw new Error('OPENAI_API_KEY is required for live evaluations');
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const directory = fileURLToPath(new URL(`../.local/evals/${runId}/`, import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
const db = await openLocalChatDatabase(join(directory, 'evaluation.db'));
const model = new OpenAITextModel(config);
type Trial = {
  case: string;
  split: string;
  trial: number;
  passed: boolean;
  checks: string[];
  grade?: GradeResult;
  judgeUsage?: { inputTokens: number; outputTokens: number };
  turns: { user: string; draft?: string; reply: string; trace: AgentTrace }[];
  error?: string;
};
const results: Trial[] = [];
const work = cases.flatMap((scenario) =>
  Array.from({ length: trials }, (_, i) => ({ scenario, trial: i + 1 })),
);
const started = Date.now();
console.log(
  `Live eval: ${work.length} trials on ${config.model}. SQLite + fake transport; no WhatsApp or Supabase connections.`,
);
try {
  await Promise.all(
    Array.from({ length: Math.min(2, work.length) }, async () => {
      for (;;) {
        const item = work.shift();
        if (!item) return;
        const chat = new LocalChat(config, model, db);
        const result: Trial = {
          case: item.scenario.id,
          split: item.scenario.split,
          trial: item.trial,
          passed: false,
          checks: [],
          turns: [],
        };
        const conversation = randomUUID();
        try {
          for (const user of item.scenario.messages) {
            const messageId = randomUUID();
            const reply = await chat.send({
              conversation,
              text: user,
              group: item.scenario.group,
              messageId,
            });
            result.turns.push({ user, draft: reply.draft, reply: reply.text, trace: reply.trace });
            result.checks.push(...styleViolations(reply.text));
            if (item.scenario.requiresClarification && !reply.text.includes('?'))
              result.checks.push('missing_clarification_question');
            if (reply.trace.outcome !== 'completed') result.checks.push('model_unavailable');
            if (reply.trace.stages.map((stage) => stage.stage).join(',') !== 'converser,formatter')
              result.checks.push('incomplete_graph');
            const row = await db.greeting.findFirst({ where: { messageId } });
            if (row?.status !== 'SENT') result.checks.push('sqlite_outcome_missing');
          }
          const verdict = await judge(
            model,
            item.scenario,
            result.turns,
            AbortSignal.timeout(config.timeoutMs),
          );
          result.grade = verdict.grade;
          result.judgeUsage = verdict.usage;
          result.passed =
            result.checks.length === 0 &&
            verdict.grade.relevance >= 4 &&
            verdict.grade.naturalness >= 4 &&
            verdict.grade.fidelity >= 4 &&
            verdict.grade.capabilityHonesty === 5;
        } catch {
          result.error = 'Evaluation could not complete; inspect model access or connectivity.';
        } finally {
          await chat.drain();
        }
        results.push(result);
        console.log(
          `${result.passed ? 'PASS' : 'FAIL'} ${result.case} trial ${result.trial}${result.checks.length ? ` (${result.checks.join(', ')})` : ''}`,
        );
      }
    }),
  );
} finally {
  await db.$disconnect();
}

results.sort((a, b) => a.case.localeCompare(b.case) || a.trial - b.trial);
const passed = results.filter((result) => result.passed).length;
const summary = cases.map((scenario) => {
  const runs = results.filter((result) => result.case === scenario.id);
  return {
    case: scenario.id,
    split: scenario.split,
    passed: runs.filter((run) => run.passed).length,
    trials: runs.length,
    distinctOutputs: new Set(runs.map((run) => run.turns.map((turn) => turn.reply).join('\n')))
      .size,
  };
});
const report = {
  runId,
  model: config.model,
  promptVersion: PROMPT_VERSION,
  promptHash: createHash('sha256')
    .update(CONVERSER_PROMPT + FORMATTER_PROMPT)
    .digest('hex'),
  datasetHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
  durationMs: Date.now() - started,
  passed,
  total: results.length,
  summary,
  results,
  limitations:
    'Synthetic cases and a same-model judge are quality signals, not guarantees. Review transcripts and judge rationales. Exact wording and output variation are not pass criteria.',
};
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
const markdown = [
  `# Ramesh live agent evaluation`,
  '',
  `Model: ${config.model}. Prompt: ${PROMPT_VERSION}.`,
  '',
  `Passed ${passed}/${results.length} repeated trials through SQLite and simulated delivery.`,
  '',
  '| Case | Split | Passed | Distinct outputs |',
  '| --- | --- | --- | --- |',
  ...summary.map(
    (row) =>
      `| ${row.case} | ${row.split} | ${row.passed}/${row.trials} | ${row.distinctOutputs} |`,
  ),
  '',
  report.limitations,
  '',
  'See report.json for drafts, replies, grades, token usage and stage latency.',
  '',
].join('\n');
await writeFile(join(directory, 'report.md'), markdown, { mode: 0o600 });
console.log(`${passed}/${results.length} passed. Report: ${join(directory, 'report.md')}`);
process.exitCode = passed === results.length ? 0 : 1;
