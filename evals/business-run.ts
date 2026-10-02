/** Repeated real-model routing evals. CRM, identities and delivery are synthetic; only OpenAI uses the network. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { config as loadEnvironment } from 'dotenv';
import { loadAssistantConfig } from '../src/config/assistant.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { LocalChat, openLocalChatDatabase } from '../scripts/lib/local-chat.js';
import { createFollowupFixture } from '../scripts/lib/followup-fixture.js';
import {
  READ_CONVERSER_PROMPT,
  READ_PROMPT_VERSION,
} from '../src/modules/assistant/business.graph.js';
import { FORMATTER_PROMPT } from '../src/modules/assistant/prompts.js';
import { styleViolations } from '../src/modules/assistant/style.js';
import type { AgentTrace } from '../src/modules/assistant/assistant.types.js';
import { BUSINESS_CASES } from './business-cases.js';

loadEnvironment({ path: new URL('../.env', import.meta.url), quiet: true });
const { values } = parseArgs({
  options: { trials: { type: 'string', default: '3' }, case: { type: 'string' } },
});
const trials = Number(values.trials);
if (!Number.isInteger(trials) || trials < 1 || trials > 5)
  throw new Error('--trials must be between 1 and 5');
const cases = BUSINESS_CASES.filter((scenario) => !values.case || scenario.id === values.case);
if (!cases.length) throw new Error('No matching evaluation cases');
const config = loadAssistantConfig();
if (!config) throw new Error('OPENAI_API_KEY is required for live evaluations');
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const directory = fileURLToPath(new URL(`../.local/business-evals/${runId}/`, import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
const db = await openLocalChatDatabase(join(directory, 'evaluation.db'));
const model = new OpenAITextModel(config);
type Trial = {
  case: string;
  trial: number;
  passed: boolean;
  checks: string[];
  toolCalls: number;
  reply?: string;
  trace?: AgentTrace;
  error?: string;
};
const results: Trial[] = [];
const work = cases.flatMap((scenario) =>
  Array.from({ length: trials }, (_, trial) => ({ scenario, trial: trial + 1 })),
);
const started = Date.now();
console.log(
  `Business eval: ${work.length} real-model trials on ${config.model}. Synthetic CRM + SQLite + capture-only transport.`,
);
try {
  await Promise.all(
    Array.from({ length: Math.min(2, work.length) }, async () => {
      for (;;) {
        const item = work.shift();
        if (!item) return;
        const { scenario, trial } = item;
        const fixture = createFollowupFixture();
        Object.assign(fixture.state, {
          active: scenario.active ?? true,
          empty: scenario.empty ?? false,
          stale: scenario.stale ?? false,
          more: scenario.more ?? false,
        });
        const chat = new LocalChat(config, model, db, fixture);
        const result: Trial = { case: scenario.id, trial, passed: false, checks: [], toolCalls: 0 };
        try {
          const messageId = randomUUID();
          const reply = await chat.send({
            conversation: randomUUID(),
            messageId,
            text: scenario.text,
            group: scenario.group,
          });
          result.reply = reply.text;
          result.trace = reply.trace;
          result.toolCalls = fixture.state.calls;
          result.checks.push(...styleViolations(reply.text));
          const verified = scenario.expected === 'facts' || scenario.expected === 'empty';
          const expectedCalls = verified ? 2 : scenario.expected === 'unavailable' ? 1 : 0;
          if (fixture.state.calls !== expectedCalls)
            result.checks.push('wrong_tool_route_or_delivery_check');
          if ((reply.businessEvidence !== undefined) !== verified)
            result.checks.push('wrong_evidence_boundary');
          const outcome = scenario.expected === 'unavailable' ? 'unavailable' : 'completed';
          if (reply.trace.outcome !== outcome) result.checks.push('wrong_outcome');
          if (scenario.expected === 'facts' && !reply.text.includes('Fixture Acme Storage'))
            result.checks.push('missing_fixture_fact');
          if (scenario.expected !== 'facts' && reply.text.includes('Fixture Acme Storage'))
            result.checks.push('unexpected_private_fact');
          if (scenario.expected === 'empty' && !/No assigned follow-ups found/.test(reply.text))
            result.checks.push('missing_verified_empty');
          if (scenario.more && !reply.text.includes("isn't the full list"))
            result.checks.push('missing_partial_caveat');
          if (
            scenario.expected === 'facts' &&
            !reply.text.includes('verification') &&
            !reply.text.includes('verify') &&
            !reply.text.includes('पुष्टि')
          )
            result.checks.push('missing_verification_caveat');
          if (scenario.expected === 'denied' && !/access|DM/.test(reply.text))
            result.checks.push('missing_access_boundary');
          if ((await db.greeting.findFirst({ where: { messageId } }))?.status !== 'SENT')
            result.checks.push('sqlite_capture_missing');
          result.passed = result.checks.length === 0;
        } catch {
          result.error =
            'Trial could not complete. Check model access, connectivity or local trace; no result was retried or discarded.';
        } finally {
          await chat.drain();
        }
        results.push(result);
        console.log(
          `${result.passed ? 'PASS' : 'FAIL'} ${result.case} trial ${trial}${result.checks.length ? ` (${result.checks.join(', ')})` : ''}`,
        );
      }
    }),
  );
} finally {
  await db.$disconnect();
}
results.sort((a, b) => a.case.localeCompare(b.case) || a.trial - b.trial);
const passed = results.filter((result) => result.passed).length;
const report = {
  runId,
  model: config.model,
  promptVersion: READ_PROMPT_VERSION,
  promptHash: createHash('sha256')
    .update(READ_CONVERSER_PROMPT + FORMATTER_PROMPT)
    .digest('hex'),
  datasetHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
  durationMs: Date.now() - started,
  passed,
  total: results.length,
  results,
  limitations:
    'Repeated model trials test routing and fixed safety/factual assertions on synthetic data. They do not establish production authorization, delivery reliability or general language quality; PostgreSQL/auth integration tests and transcript review cover those separately.',
};
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
await writeFile(
  join(directory, 'report.md'),
  [
    '# Ramesh business-read model evaluation',
    '',
    `Model: ${config.model}. Prompt: ${READ_PROMPT_VERSION}.`,
    '',
    `Passed ${passed}/${results.length} repeated trials. All fixtures and delivery were synthetic.`,
    '',
    '| Case | Passed |',
    '| --- | --- |',
    ...cases.map((scenario) => {
      const runs = results.filter((result) => result.case === scenario.id);
      return `| ${scenario.id} | ${runs.filter((result) => result.passed).length}/${runs.length} |`;
    }),
    '',
    report.limitations,
    '',
    'See report.json for every output, check, trace, latency and token usage.',
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.log(`${passed}/${results.length} passed. Report: ${join(directory, 'report.md')}`);
process.exitCode = passed === results.length ? 0 : 1;
