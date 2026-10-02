import { writeFile } from 'node:fs/promises';

export interface EvalTrial {
  case: string;
  trial: number;
  passed: boolean;
  checks: string[];
  durationMs: number;
  [key: string]: unknown;
}
export interface EvalReport {
  runId: string;
  model: string;
  promptHash: string;
  passed: number;
  total: number;
  results: EvalTrial[];
  durationMs: number;
  [key: string]: unknown;
}
export const xmlEscape = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
export function junit(report: EvalReport) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${report.total}" failures="${report.total - report.passed}" time="${report.durationMs / 1000}"><testsuite name="Ramesh conversations" tests="${report.total}" failures="${report.total - report.passed}">\n` +
    report.results
      .map(
        (r) =>
          `<testcase classname="${xmlEscape(r.case)}" name="trial ${r.trial}" time="${r.durationMs / 1000}">${r.passed ? '' : `<failure message="${xmlEscape(r.checks.join(', '))}">${xmlEscape(JSON.stringify(r.judge ?? {}))}</failure>`}</testcase>`,
      )
      .join('\n') +
    '\n</testsuite></testsuites>\n'
  );
}
export async function writeEvalReports(directory: URL, report: EvalReport) {
  const names = [...new Set(report.results.map((r) => r.case))].sort();
  const summary = [
    `# Ramesh conversation evals`,
    '',
    `${report.passed}/${report.total} trials passed. Model: ${report.model}.`,
    '',
    ...(report.kind === 'regrade'
      ? [
          `JUDGE-ONLY RE-EVALUATION of ${report.sourceRunId}. No agent run was repeated. Original answers and hard checks are preserved; the original report is unchanged. Source report SHA-256: ${report.sourceReportHash}.`,
          '',
        ]
      : []),
    ...(report.inputIntegrity === false
      ? [
          'INVALID SNAPSHOT: source inputs changed during this run. See changedInputs in report.json.',
          '',
        ]
      : []),
    `Prompt bundle: \`${report.promptHash}\`. Run: \`${report.runId}\`.`,
    '',
    '| Scenario | Passed | Failed checks |',
    '| --- | --- | --- |',
    ...names.map((name) => {
      const rows = report.results.filter((r) => r.case === name);
      return `| ${name} | ${rows.filter((r) => r.passed).length}/${rows.length} | ${[...new Set(rows.flatMap((r) => r.checks))].join(', ')} |`;
    }),
    '',
    'Every trial is retained. Runtime verification and the independent judge are probabilistic; hard contract failures cannot be overridden by the judge. Data is fictional. Real-source capture smoke is separate. No WhatsApp transport is imported.',
    '',
    'See report.json for turns, evidence, tool calls, verifier feedback, token use and latency; junit.xml is suitable for CI.',
    '',
  ].join('\n');
  await writeFile(new URL('report.json', directory), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  await writeFile(new URL('junit.xml', directory), junit(report), { mode: 0o600 });
  await writeFile(new URL('summary.md', directory), summary, { mode: 0o600 });
}
