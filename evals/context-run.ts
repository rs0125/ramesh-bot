/** Three opt-in Luna conversations: real scoped reads; all context and transcripts stay local. */
import { parseArgs } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { loadLivePlaygroundConfig } from '../src/config/playground.js';
import { messagePoolOptions } from '../src/infrastructure/database/message-pool.js';
import { PostgresEmployeeRoster } from '../src/infrastructure/database/employee-roster.js';
import { EmployeeIdentityResolver } from '../src/modules/identity/employee-identity.js';
import { SignedEmployeeCredentials } from '../src/infrastructure/context-engine/request-credentials.js';
import { scopedCrmReader } from '../src/app/scoped-crm-reader.js';
import { BusinessReadService } from '../src/modules/assistant/business-reads.js';
import { AssistantService } from '../src/modules/assistant/assistant.service.js';
import { ChatContext, contextScope } from '../src/modules/assistant/chat-context.js';
import { LocalChatContextStore } from '../src/infrastructure/database/local-chat-context.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { getBusinessReply } from '../src/modules/messaging/delivery-evidence.js';
import { PRIVATE_HISTORY_REPLY } from '../src/modules/assistant/conversation-memory.js';
import { withUsageScope } from '../src/modules/usage/usage-scope.js';
import { assertEvalRun, DEFAULT_EVAL_MODEL } from './lib/run-policy.js';
import { createEvalUsageMeter, evalBudgetOptions } from './lib/usage-budget.js';
import { LocalContextConversation } from './lib/local-context-conversation.js';
import { readonlyRoster } from './lib/readonly-roster.js';
import type { TrustedReplyContext } from '../src/modules/greetings/greeting.types.js';

async function main() {
  const { values } = parseArgs({
    options: {
      ...evalBudgetOptions,
      'env-file': { type: 'string' },
      'key-env-file': { type: 'string' },
      'prices-file': { type: 'string' },
      'allow-live-reads': { type: 'boolean', default: false },
      output: { type: 'string' },
    },
  });
  if (
    process.env.CI ||
    !values['allow-live-reads'] ||
    !values['env-file'] ||
    !values['key-env-file'] ||
    !values['prices-file']
  )
    throw new Error('EXPLICIT_LOCAL_READ_ONLY_EVAL_REQUIRED');
  assertEvalRun([DEFAULT_EVAL_MODEL], 3, {});
  const directory = resolve(values.output ?? `.local/context-evals/${randomUUID()}`);
  const localRoot = resolve('.local');
  if (!relative(localRoot, directory) || relative(localRoot, directory).startsWith('..'))
    throw new Error('LOCAL_PRIVATE_OUTPUT_REQUIRED');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const source = parse(await readFile(resolve(values['env-file'])));
  const keySource = parse(await readFile(resolve(values['key-env-file'])));
  if (!keySource.OPENAI_API_KEY) throw new Error('EXPLICIT_OPENAI_KEY_REQUIRED');
  const env = {
    ...source,
    OPENAI_API_KEY: keySource.OPENAI_API_KEY,
    OPENAI_MODEL: DEFAULT_EVAL_MODEL,
    AGENT_CONTEXT_ENABLED: 'true',
    AGENT_CONTEXT_MAX_INPUT_TOKENS: '96000',
    AGENT_CONTEXT_COMPACT_THRESHOLD: '64000',
    AGENT_TIMEOUT_MS: '300000',
    AGENT_MAX_OUTPUT_TOKENS: '8000',
    AGENT_TOOL_REASONING_EFFORT: 'low',
    USAGE_MODE: 'off',
    EVAL_USAGE_PRICES_JSON: await readFile(resolve(values['prices-file']), 'utf8'),
  };
  const config = loadLivePlaygroundConfig(env);
  config.model.tavilyApiKey = undefined;
  // Strip every mutation scope even if the local source credential also supports writes.
  config.signing.scopes = config.signing.scopes.filter((scope) => scope.endsWith(':read'));
  const meter = await createEvalUsageMeter({ ...values, directory }, env, [DEFAULT_EVAL_MODEL]);
  const modelConfig = { ...config.model, usageMeter: meter };
  const model = new OpenAITextModel(modelConfig);
  const pool = new Pool({
    ...messagePoolOptions(config.databaseUrl, config.ca),
    application_name: 'ramesh-local-read-only-eval',
  });
  pool.on('error', () => {});
  const identities = new EmployeeIdentityResolver(new PostgresEmployeeRoster(readonlyRoster(pool)));
  const credentials = new SignedEmployeeCredentials(config.context, identities, config.signing);
  const encryptionKey = randomBytes(32).toString('base64url');
  await writeFile(join(directory, 'local-key'), encryptionKey, { mode: 0o600, flag: 'wx' });
  const results: Array<Record<string, unknown>> = [];
  const evidence: unknown[] = [];
  const save = async (name: string, data: unknown) =>
    writeFile(join(directory, name), JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    const actor = await identities.resolveEmployee(config.employeeId, AbortSignal.timeout(30000));
    if (!actor) throw new Error('LIVE_EMPLOYEE_UNAVAILABLE');
    const chatId = `${actor.phoneE164.slice(1)}@s.whatsapp.net`;
    const reads = new BusinessReadService(
      async (key, signal) => {
        const current = await identities.resolveEmployee(config.employeeId, signal);
        if (
          !current ||
          key.remoteJid !== chatId ||
          current.phoneE164 !== actor.phoneE164 ||
          current.email !== actor.email
        )
          return null;
        const reader = scopedCrmReader(config.context, credentials, current, {
          phoneE164: current.phoneE164,
          audience: 'dm',
        });
        // Deliberately expose no writer, personal tools, outbox, admin API or WhatsApp transport.
        return { employeeId: reader.employeeId, search: reader.search, tools: reader.tools };
      },
      [actor.employeeId],
      Date.now,
      true,
    );
    const seed = await reads.openTools(
      { runId: randomUUID(), key: { remoteJid: chatId } },
      AbortSignal.timeout(60000),
    );
    if (!seed.run) throw new Error('LIVE_READS_UNAVAILABLE');
    await seed.run.execute(
      'search_warehouses',
      JSON.stringify({ limit: 2 }),
      AbortSignal.timeout(60000),
    );
    const rows = seed.run.evidence.find((entry) => entry.tool === 'search_warehouses')?.result.data
      .items;
    if (
      !Array.isArray(rows) ||
      rows.length < 2 ||
      rows.some((row) => !Number.isSafeInteger(row.id))
    )
      throw new Error('TWO_REAL_WAREHOUSES_REQUIRED');
    const records = rows.slice(0, 2).map((row, index) => ({
      kind: 'warehouse' as const,
      id: row.id as number,
      position: index + 1,
    }));
    const receipt = seed.run.delivery();
    if (!receipt) throw new Error('SEED_RECEIPT_REQUIRED');
    receipt.displayedRecords = records;
    await save('seed-evidence.json', seed.run.evidence);
    for (const name of [
      'correction-after-compaction',
      'selection-after-restart',
      'forget-and-switch-to-crm',
    ]) {
      const conversation = new LocalContextConversation(chatId);
      const storePath = join(directory, name, 'memory');
      const store = new LocalChatContextStore(storePath, encryptionKey);
      const owner = contextScope(`local-eval:${name}`, chatId, actor);
      const context = () =>
        new ChatContext({
          store: new LocalChatContextStore(storePath, encryptionKey),
          source: conversation,
          model,
          resolve: async (_message, _trusted, signal) => {
            const current = await identities.resolveEmployee(actor.employeeId, signal);
            return current && current.phoneE164 === actor.phoneE164 && current.email === actor.email
              ? owner
              : null;
          },
        });
      const commands = async (text: string) => {
        const { candidate, trusted } = conversation.request(text);
        const prepared = await withUsageScope(
          { runId: trusted.runId, subjectId: `employee:${actor.employeeId}` },
          () => context().prepare(candidate, trusted, AbortSignal.timeout(90000)),
        );
        if (prepared?.reply) conversation.add({ role: 'assistant', content: prepared.reply });
        return prepared;
      };
      const caseEvidence: unknown[] = [];
      let finalText = '';
      try {
        await commands('/pin format: Use concise bullet points.');
        conversation.add({
          role: 'user',
          content: 'My active warehouse requirement is a minimum of 20000 square feet.',
        });
        conversation.add({
          role: 'user',
          content:
            'Correction: the minimum is 50000 square feet. The earlier 20000 figure is wrong.',
        });
        conversation.add({ role: 'user', content: 'Show the two warehouse options in order.' });
        conversation.add({
          role: 'assistant',
          content: PRIVATE_HISTORY_REPLY,
          protectedReply: {
            text: records.map((row) => `${row.position}. ID ${row.id}`).join('\n'),
            receipt,
          },
        });
        conversation.filler(19);
        // Force the summary before reconstructing both service and store for the final turn.
        await commands('Keep the active warehouse context for later.');
        const compacted = (await store.load(owner))!;
        if (!compacted.state.summary.notes.length || !compacted.state.selections.length)
          throw new Error('COMPACTION_DID_NOT_PERSIST');
        if (name === 'forget-and-switch-to-crm') await commands('/forget context');
        const forgotten = await store.load(owner);
        finalText =
          name === 'correction-after-compaction'
            ? `What minimum warehouse size did I correct my requirement to? Also freshly read warehouse ID ${records[0]!.id} and report its recorded city and area, whether or not it meets my requirement. Do not change any record.`
            : name === 'selection-after-restart'
              ? 'For the second warehouse in the earlier displayed list, freshly read and report its recorded city and area. Preserve its original position. Do not change any record.'
              : 'Switch to CRM: read one lead I can access and report its name and next follow-up, if recorded. Do not create or change anything. Do you still have any pinned notes for this chat?';
        const request = conversation.request(finalText);
        const candidate = request.candidate;
        const trusted: TrustedReplyContext = {
          ...request.trusted,
          record: async (event, value) => {
            caseEvidence.push({ event, value });
          },
        };
        const assistant = new AssistantService(
          modelConfig,
          model,
          undefined,
          () => {},
          undefined,
          reads,
          {
            conversationContext: context(),
            usageMeter: meter,
            utilityFetch: async () => {
              throw new Error('EVAL_PUBLIC_NETWORK_DISABLED');
            },
          },
        );
        const reply = await assistant.prepare(candidate, AbortSignal.timeout(300000), trusted);
        conversation.add({
          role: 'assistant',
          content: reply.businessEvidence ? PRIVATE_HISTORY_REPLY : reply.text,
          ...(reply.businessEvidence
            ? {
                protectedReply: getBusinessReply({
                  text: reply.text,
                  receipt: reply.businessEvidence,
                }),
              }
            : {}),
        });
        const calls = caseEvidence.filter(
          (entry: any) => entry.event === 'tool_succeeded',
        ) as Array<{ value: { tool?: string; arguments?: { id?: number } } }>;
        const expectedId = records[name === 'selection-after-restart' ? 1 : 0]!.id;
        const checks = {
          completed: reply.trace.outcome === 'completed',
          memory:
            name === 'correction-after-compaction'
              ? /50[,. ]?000/.test(reply.text)
              : name === 'selection-after-restart'
                ? compacted.state.selections.some((selection) =>
                    selection.records.some(
                      (record) => record.id === expectedId && record.position === 2,
                    ),
                  )
                : forgotten!.state.pins.length === 0 &&
                  forgotten!.state.summary.notes.length === 0 &&
                  forgotten!.state.selections.length === 0,
          freshRead: calls.some((entry) =>
            name === 'forget-and-switch-to-crm'
              ? /crm/.test(entry.value.tool ?? '')
              : entry.value.tool === 'read_warehouse' && entry.value.arguments?.id === expectedId,
          ),
          reviewed: reply.trace.stages.some((stage) => stage.stage === 'verifier'),
        };
        const passed = Object.values(checks).every(Boolean);
        results.push({ name, passed, checks });
        await save(`${name}.json`, {
          name,
          checks,
          seeded: true,
          conversation: conversation.entries,
          compacted,
          after: await store.load(owner),
          reply,
          evidence: caseEvidence,
        });
        console.log(JSON.stringify({ case: name, passed, checks }));
      } catch (error) {
        // Preserve failures once; this command never retries a scenario or expands its allowance.
        results.push({
          name,
          passed: false,
          error: error instanceof Error ? error.message : 'CASE_FAILED',
        });
        await save(`${name}.json`, {
          name,
          finalText,
          conversation: conversation.entries,
          evidence: caseEvidence,
          error: error instanceof Error ? error.message : 'CASE_FAILED',
        });
        console.log(JSON.stringify({ case: name, passed: false }));
      }
      evidence.push(...caseEvidence);
      await save('results.json', results);
    }
    if (results.some((result) => !result.passed)) process.exitCode = 1;
  } catch (error) {
    await save('run-error.json', { error: error instanceof Error ? error.message : 'RUN_FAILED' });
    process.exitCode = 1;
    console.error('LOCAL_CONTEXT_EVAL_FAILED; details preserved in the private run directory');
  } finally {
    await save('evidence.json', evidence);
    const usage = await meter.report();
    console.log(
      JSON.stringify({
        model: DEFAULT_EVAL_MODEL,
        scenarioExecutions: results.length,
        passed: results.filter((result) => result.passed).length,
        knownUsd: usage.knownActualMicros / 1000000,
        heldUsd: usage.heldMicros / 1000000,
        capUsd: usage.maxMicros / 1000000,
        costComplete: usage.costComplete,
      }),
    );
    await pool.end();
  }
}
main().catch(() => {
  console.error('LOCAL_CONTEXT_EVAL_SETUP_FAILED');
  process.exitCode = 1;
});
