/** Focused real Ramesh graph evaluation: eager/deferred pair plus an unfamiliar read tool. */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { config as dotenv } from 'dotenv';
import { AssistantService } from '../src/modules/assistant/assistant.service.js';
import { BusinessReadService } from '../src/modules/assistant/business-reads.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { loadAssistantConfig } from '../src/config/assistant.js';
import { argumentsSha256 } from '../src/modules/context-engine/read-contract.js';
import type {
  ContextToolDefinition,
  ContextEvidence,
} from '../src/modules/context-engine/context.types.js';
import { createSalesFixture, salesEvidence, FIXTURE_JID } from '../scripts/lib/sales-fixture.js';
import { createEvalUsageMeter, evalBudgetOptions } from './lib/usage-budget.js';
import { assertEvalRun, evalPolicyOptions } from './lib/run-policy.js';
import { captureEvalProvenance } from './lib/provenance.js';
import { toolLoadingChecks } from './lib/tool-loading-checks.js';

dotenv({ path: new URL('../.env', import.meta.url), quiet: true });
const { values } = parseArgs({
  options: {
    ...evalBudgetOptions,
    ...evalPolicyOptions,
    catalogue: { type: 'string' },
    case: { type: 'string' },
    'continuation-of': { type: 'string' },
    output: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const allCases = [
  { id: 'eager-crm-summary', mode: 'eager' as const, novel: false },
  { id: 'deferred-crm-summary', mode: 'deferred' as const, novel: false },
  { id: 'deferred-unfamiliar-tool', mode: 'deferred' as const, novel: true },
];
const selected = values.case?.split(',');
if (selected?.some((id) => !allCases.some((scenario) => scenario.id === id)))
  throw new Error('UNKNOWN_TOOL_LOADING_CASE');
const cases = allCases.filter((scenario) => !selected || selected.includes(scenario.id));
const policy = assertEvalRun(['gpt-6-luna'], cases.length, values);
if (values['dry-run']) {
  console.log(JSON.stringify({ model: 'gpt-6-luna', cases, policy, paidRequests: 0 }));
  process.exit(0);
}
if (!values.catalogue) throw new Error('Provide a catalogue captured from ordinary MCP tools/list');
const catalogue = JSON.parse(
  await readFile(resolve(values.catalogue), 'utf8'),
) as ContextToolDefinition[];
if (!Array.isArray(catalogue) || !catalogue.length) throw new Error('INVALID_EVAL_CATALOGUE');
const runId = `tool-loading-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const directory = resolve(values.output ?? '.local/tool-loading-evals', runId);
await mkdir(directory, { recursive: true, mode: 0o700 });
const meter = await createEvalUsageMeter({ ...values, directory, campaignId: runId }, process.env, [
  'gpt-6-luna',
]);
await writeFile(
  join(directory, 'metadata.json'),
  JSON.stringify(
    {
      runId,
      model: 'gpt-6-luna',
      policy,
      cases,
      continuationOf: values['continuation-of'] ?? null,
      catalogue: resolve(values.catalogue),
      grading: 'deterministic outcomes and native search events; no model grader',
      ...(await captureEvalProvenance(new URL('../', import.meta.url))),
    },
    null,
    2,
  ),
);

const now = () => Date.parse('2026-10-05T09:00:00Z');
const novel: ContextToolDefinition = {
  name: 'count_studio_drafts',
  description:
    'Count internal draft documents in the Studio vault. Returns the exact current draft count.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        properties: { draft_count: { type: 'integer' }, collection: { type: 'string' } },
        required: ['draft_count', 'collection'],
      },
    },
    required: ['data'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
  _meta: {
    'wareongo/context-read-v1': { requiredScopes: ['knowledge:read'], sourceFamily: 'studio' },
    'wareongo/tool-discovery-v1': {
      capability: 'studio',
      description: 'Studio vault internal draft document counts.',
      loading: 'deferred',
    },
  },
};
const results: Array<Record<string, unknown>> = [];
try {
  for (const scenario of cases) {
    const record: Record<string, any> = {
      case: scenario.id,
      mode: scenario.mode,
      passed: false,
      requests: [],
      nativeSearchCalls: 0,
    };
    const started = Date.now();
    try {
      const fixture = createSalesFixture(now);
      // Preserve the existing business fixtures; presentation hints come from the MCP server snapshot.
      fixture.state.tools = fixture.state.tools.map((tool) => {
        const live = catalogue.find((candidate) => candidate.name === tool.name);
        const hint = live?._meta?.['wareongo/tool-discovery-v1'];
        if (!hint) throw new Error(`MISSING_DISCOVERY_HINT:${tool.name}`);
        return { ...tool, _meta: { ...tool._meta, 'wareongo/tool-discovery-v1': hint } };
      });
      let service = fixture.service;
      if (scenario.novel) {
        fixture.state.tools.push(novel);
        service = new BusinessReadService(
          async () => ({
            employeeId: 23,
            search: async () => salesEvidence('search_crm_leads', {}, now(), fixture.state),
            tools: {
              employeeId: 23,
              discover: async () => fixture.state.tools,
              describe: async () => ({
                tools: fixture.state.tools,
                guidance: fixture.state.guidance,
              }),
              call: async (name, args) => {
                fixture.state.calls.push({ tool: name, args: structuredClone(args) });
                const result: ContextEvidence =
                  name === novel.name
                    ? {
                        source_path: '/api/v1/knowledge/studio-drafts',
                        status: 200,
                        data: { draft_count: 47, collection: 'Studio vault' },
                        meta: {
                          requestId: 'studio-fixture',
                          generatedAt: new Date(now()).toISOString(),
                          toolName: name,
                          argumentsSha256: argumentsSha256(args),
                        },
                      }
                    : salesEvidence(name, args, now(), fixture.state);
                fixture.state.evidence.push({
                  tool: name,
                  args: structuredClone(args),
                  result: structuredClone(result),
                });
                return result;
              },
            },
          }),
          [23],
          now,
          true,
        );
      }
      const loaded = loadAssistantConfig({
        ...process.env,
        OPENAI_MODEL: 'gpt-6-luna',
        AGENT_TOOL_LOADING: scenario.mode,
      });
      if (!loaded) throw new Error('OPENAI_API_KEY_REQUIRED');
      const config = { ...loaded, usageMeter: meter, timeoutMs: 240000, maxOutputTokens: 6000 };
      const provider = new OpenAITextModel(config, async (input, init) => {
        const response = await fetch(input, init);
        const body = JSON.parse(String(init?.body));
        const output = (await response.clone().json()) as Record<string, any>;
        const searches = (output.output ?? []).filter(
          (item: any) => item.type === 'tool_search_call',
        );
        record.nativeSearchCalls += searches.length;
        record.requests.push({
          toolTypes: body.tools?.map((tool: any) => tool.type),
          output: output.output,
          usage: output.usage,
          status: response.status,
          responseId: output.id,
          ...(output.error
            ? { providerErrorCode: output.error.code, providerErrorType: output.error.type }
            : {}),
        });
        return response;
      });
      const assistant = new AssistantService(
        config,
        provider,
        undefined,
        undefined,
        undefined,
        service,
        { now },
      );
      const question = scenario.novel
        ? 'How many internal draft documents are in the Studio vault?'
        : 'How many of my active CRM deals are in each stage?';
      const reply = await assistant.prepare(
        {
          chatId: FIXTURE_JID,
          messageId: randomUUID(),
          text: question,
          sentAtMs: now(),
          fromMe: false,
          isGroup: false,
          mentionsBot: false,
        },
        undefined,
        { key: { remoteJid: FIXTURE_JID }, runId: randomUUID() },
      );
      record.reply = reply.text;
      record.trace = reply.trace;
      record.calls = fixture.state.calls;
      record.evidence = fixture.state.evidence;
      record.checks = toolLoadingChecks({
        case: scenario.id,
        mode: scenario.mode,
        trace: reply.trace,
        reply: reply.text,
        calls: fixture.state.calls,
        evidence: fixture.state.evidence,
        nativeSearchCalls: record.nativeSearchCalls,
      });
      record.passed = Object.values(record.checks).every(Boolean);
    } catch (error) {
      record.error = error instanceof Error ? error.message : 'Evaluation failed';
    } finally {
      record.durationMs = Date.now() - started;
      results.push(record);
      await writeFile(join(directory, `${scenario.id}.json`), JSON.stringify(record, null, 2), {
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          case: record.case,
          passed: record.passed,
          checks: record.checks,
          error: record.error,
          searchCalls: record.nativeSearchCalls,
          durationMs: record.durationMs,
        }),
      );
    }
  }
} finally {
  const usage = await meter.report();
  const report = {
    passed: results.length === cases.length && results.every((result) => result.passed),
    results: results.map(({ requests, evidence, ...rest }) => rest),
    usage,
  };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ directory, passed: report.passed, usage }));
  if (!report.passed) process.exitCode = 1;
}
