/** Matched screening experiment; fictional source fixtures, fixed independent judge. */
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertEvalRun, evalPolicyOptions } from './lib/run-policy.js';

const { values } = parseArgs({
  options: {
    ...evalPolicyOptions,
    trials: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '1' },
  },
});
if (!/^[1-5]$/.test(values.trials!)) throw new Error('Use 1–5 trials');
if (!/^[1-4]$/.test(values.concurrency!)) throw new Error('Use concurrency 1–4');
const cases = [
  'reported-shortlist',
  'use-correction-owner-questions',
  'crm-today-to-all',
  'crm-tomorrow-to-month',
  'ga4-overview-compare',
  'analytics-form-entry-cohort',
  'analytics-partial-source-failure',
  'adversarial-transient-tool-recovery',
  'adversarial-note-cannot-dispatch',
  'adversarial-request-is-not-fact',
  'adversarial-no-causal-certainty',
  'adversarial-personal-no-research',
];
const profiles = [
  { name: 'terra-medium', model: 'gpt-5.6-terra', effort: 'medium' },
  { name: 'sol-medium', model: 'gpt-6.1-sol', effort: 'medium' },
  { name: 'sol-high', model: 'gpt-6.1-sol', effort: 'high' },
];
assertEvalRun(
  profiles.map((profile) => profile.model),
  cases.length * profiles.length * Number(values.trials),
  values,
);
const root = new URL('../', import.meta.url);
const directory = new URL(
  `.local/model-comparisons/${new Date().toISOString().replaceAll(':', '-')}/`,
  root,
);
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(
  new URL('experiment.json', directory),
  JSON.stringify(
    {
      cases,
      profiles,
      trials: Number(values.trials),
      judgeModel: 'gpt-5.6-terra',
      judgeEffort: 'medium',
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
const reports: any[] = [];
for (const profile of profiles) {
  console.log(
    `Starting ${profile.name}; fixed Terra judge, ${cases.length} cases x ${values.trials}.`,
  );
  const output = new URL(`${profile.name}/`, directory);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'evals/conversation-run.ts',
        '--suite',
        'all',
        '--case',
        cases.join(','),
        '--trials',
        values.trials!,
        '--concurrency',
        values.concurrency!,
        '--model',
        profile.model,
        '--tool-effort',
        profile.effort,
        '--judge-model',
        'gpt-5.6-terra',
        '--max-trials',
        values['max-trials']!,
        ...(values['sol-approval'] ? ['--sol-approval', values['sol-approval']] : []),
        '--output',
        fileURLToPath(output),
      ],
      { cwd: root, stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  const runs = (await readdir(output)).sort();
  const reportPath = new URL(`${runs.at(-1)}/report.json`, output);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  reports.push({ ...profile, code, reportPath: fileURLToPath(reportPath), report });
}
const percentile = (values: number[], quantile: number) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered.length
    ? Math.round(
        ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * quantile))]! / 100,
      ) / 10
    : null;
};
const summaries = reports.map(({ report, ...profile }) => {
  const turns = report.results.flatMap((r: any) => r.turns);
  const toolFailures = report.results.filter((r: any) =>
    r.checks.some((check: string) =>
      /tool_contract|trace_count|unnecessary_reads|missing_recall|missing_supply|wrong_latest|private_history|stale_selection|lost_ordinal/.test(
        check,
      ),
    ),
  ).length;
  return {
    ...profile,
    runId: report.runId,
    inputHash: report.inputHash,
    promptHash: report.promptHash,
    datasetHash: report.datasetHash,
    judgeHash: report.judgeHash,
    passed: report.passed,
    total: report.total,
    toolContractFailedTrials: toolFailures,
    trialErrors: report.results.filter((r: any) => r.checks.includes('trial_error')).length,
    turns: turns.length,
    completedTurns: turns.filter((t: any) => t.trace.outcome === 'completed').length,
    proposedCalls: turns.reduce((sum: number, t: any) => sum + t.proposed_tools.length, 0),
    sourceCalls: turns.reduce((sum: number, t: any) => sum + t.calls.length, 0),
    invalidArgumentResults: turns.reduce(
      (sum: number, t: any) =>
        sum + t.tool_results.filter((r: any) => r.output?.code === 'INVALID_ARGUMENTS').length,
      0,
    ),
    latencySeconds: {
      p50: percentile(
        turns.map((t: any) => t.trace.durationMs),
        0.5,
      ),
      p95: percentile(
        turns.map((t: any) => t.trace.durationMs),
        0.95,
      ),
    },
    agentUsage: report.agentUsage,
    judgeUsage: report.judgeUsage,
  };
});
const matchedInputs = ['inputHash', 'promptHash', 'datasetHash', 'judgeHash'].every(
  (key) => new Set(summaries.map((row) => row[key as keyof typeof row])).size === 1,
);
const summary = {
  matchedInputs,
  summaries,
  limits:
    'Two-trial screening is not statistical proof. Native date/time continues to advance; fixtures resolve relative dates at execution. Simple Sol formatting uses low because none is unsupported. Hard tool-contract counts exclude semantic-only judge failures; inspect full traces too.',
};
await writeFile(new URL('comparison.json', directory), JSON.stringify(summary, null, 2), {
  mode: 0o600,
});
await writeFile(
  new URL('comparison.md', directory),
  [
    '# Matched model and tool-effort screen',
    '',
    `Matched code, prompts, dataset and judge: ${matchedInputs}.`,
    '',
    '| Model / tool effort | Trials passed | Tool-contract failures | Invalid arguments | Turn p50 / p95 | Agent reasoning tokens |',
    '| --- | --- | --- | --- | --- | --- |',
    ...summaries.map(
      (s) =>
        `| ${s.name} | ${s.passed}/${s.total} | ${s.toolContractFailedTrials} | ${s.invalidArgumentResults} | ${s.latencySeconds.p50}s / ${s.latencySeconds.p95}s | ${s.agentUsage.reasoningTokens} |`,
    ),
    '',
    summary.limits,
    '',
    'Every profile uses the same Terra judge at medium effort. No WhatsApp transport or real business data is used. Failures remain in each profile report.',
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.log(`Comparison: ${fileURLToPath(new URL('comparison.md', directory))}`);
if (!matchedInputs || summaries.some((s) => s.passed !== s.total)) process.exitCode = 1;
