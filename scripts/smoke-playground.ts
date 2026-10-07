/** Opt-in live model + Supabase + signed MCP checks. Prints metadata, never real CRM/supply bodies. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { loadLivePlaygroundConfig } from '../src/config/playground.js';
import { assistantModels } from '../src/config/assistant.js';
import { messagePoolOptions } from '../src/infrastructure/database/message-pool.js';
import { PlaygroundRepository } from '../src/infrastructure/database/playground.repository.js';
import { authCipher } from '../src/infrastructure/database/auth-store.js';
import { createPlaygroundAccess } from '../src/app/playground-access.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { toolDeliverySchema } from '../src/modules/assistant/tool-evidence.js';
import { LiveChat } from './lib/live-chat.js';
import { assertEvalRun, evalPolicyOptions } from '../evals/lib/run-policy.js';
import { createEvalUsageMeter, evalBudgetOptions } from '../evals/lib/usage-budget.js';

async function main() {
  const { values } = parseArgs({ options: { ...evalPolicyOptions, ...evalBudgetOptions } });
  const config = loadLivePlaygroundConfig(
    parse(await readFile(resolve(process.env.PLAYGROUND_ENV_FILE ?? '.local/live-playground.env'))),
  );
  assertEvalRun([config.model.model], 5, values);
  const usageMeter = await createEvalUsageMeter(values, process.env, assistantModels(config.model));
  const modelConfig = { ...config.model, usageMeter };
  const pool = new Pool(messagePoolOptions(config.databaseUrl, config.ca));
  pool.on('error', () => {});
  const repo = new PlaygroundRepository(
    pool,
    config.namespace,
    config.employeeId,
    config.encryptionKey,
  );
  const chat = new LiveChat(
    modelConfig,
    new OpenAITextModel(modelConfig),
    repo,
    createPlaygroundAccess(config, pool),
    config.context.timeoutMs,
  );
  const cipher = authCipher(config.encryptionKey);
  const conversation = `smoke-${randomUUID()}`;
  const events = async (id: string) => {
    const { rows } = await pool.query(
      `SELECT e.kind,e.payload_encrypted FROM public."ramesh-test-agent-events" e JOIN public."ramesh-test-inbound-queue" i ON i.id=e.message_id WHERE i.id=$1 AND i.namespace=$2 AND i.employee_id=$3 ORDER BY e.id`,
      [id, config.namespace, config.employeeId],
    );
    return rows.map((row) => ({
      kind: row.kind as string,
      payload: cipher.open(`test-event:${row.kind}`, id, row.payload_encrypted) as Record<
        string,
        unknown
      >,
    }));
  };
  try {
    await repo.health();
    const scenarios = [
      {
        check: 'assigned_today',
        text: 'Show my assigned CRM follow-ups for today.',
        tool: 'search_crm_leads',
      },
      { check: 'all_followups_after_today', text: 'show all follow ups', tool: 'search_crm_leads' },
      {
        check: 'crm_pipeline_total',
        text: 'How many CRM leads can I access? Show the total by stage.',
        tool: 'crm_summary',
      },
      {
        check: 'supply_total',
        text: 'How many warehouses are in the listings I can access? Show a total by city.',
        tool: 'warehouse_summary',
      },
      {
        check: 'knowledge_browse',
        text: 'Show a few company knowledge pages I can read.',
        tool: 'search_knowledge',
      },
    ];
    for (const scenario of scenarios) {
      const input = { conversation, text: scenario.text, messageId: randomUUID() };
      const reply = await chat.send(input);
      const recorded = await events(input.messageId);
      const receipt = toolDeliverySchema.safeParse(
        (await repo.output(input.messageId))?.reply.businessEvidence,
      );
      const calls = recorded.filter((e) => e.kind === 'tool_succeeded');
      let passed =
        reply.outcome === 'captured' &&
        reply.trace.outcome === 'completed' &&
        receipt.success &&
        receipt.data.employeeId === config.employeeId &&
        calls.some((e) => e.payload.tool === scenario.tool);
      if (scenario.check === 'all_followups_after_today')
        passed =
          passed &&
          calls.some((e) => {
            const args = e.payload.arguments as Record<string, unknown>;
            return (
              e.payload.tool === 'search_crm_leads' &&
              args.view === 'assigned' &&
              !['follow_up_status', 'period', 'date_field', 'date_from', 'date_to'].some(
                (k) => k in args,
              ) &&
              args.active_only !== 'true'
            );
          }) &&
          !/\b(?:I can only|I only support|only able to)\b[^.\n]{0,100}\btoday\b/i.test(reply.text);
      console.log(
        JSON.stringify({
          check: scenario.check,
          passed,
          queueId: input.messageId,
          outcome: reply.outcome,
          agentOutcome: reply.trace.outcome,
          verifiedReceipt: receipt.success,
          durationMs: reply.trace.durationMs,
          tools: calls.map((e) => e.payload.tool),
          failures: recorded.filter((e) => e.kind === 'tool_failed').map((e) => e.payload.code),
          results: calls.map((e) => {
            const data = (e.payload.result as { data: Record<string, unknown> }).data;
            return {
              tool: e.payload.tool,
              returnedCount: Array.isArray(data.items) ? data.items.length : undefined,
              total: typeof data.total === 'number' ? data.total : undefined,
              hasMore: data.nextCursor !== undefined ? data.nextCursor !== null : undefined,
            };
          }),
        }),
      );
      if (!passed) throw new Error('LIVE_SALES_READ_NOT_VERIFIED');
      if (scenario.check === 'all_followups_after_today') {
        const replay = await chat.send(input);
        if (
          replay.outcome !== 'captured' ||
          replay.text !== reply.text ||
          JSON.stringify(replay.trace) !== JSON.stringify(reply.trace) ||
          (await events(input.messageId)).length !== recorded.length
        )
          throw new Error('CAPTURE_REPLAY_FAILED');
        console.log(
          JSON.stringify({ check: 'saved_reply_replay_with_fresh_authorization', passed: true }),
        );
      }
    }
    for (const input of [
      { sender: 'teammate', group: false, check: 'unknown_denied' },
      { sender: 'me', group: true, check: 'group_denied' },
    ]) {
      const messageId = randomUUID();
      const reply = await chat.send({
        ...input,
        conversation,
        text: 'Show my assigned CRM follow-ups.',
        messageId,
      });
      if (
        reply.outcome !== 'captured' ||
        reply.trace.outcome !== 'completed' ||
        (await events(messageId)).length ||
        reply.trace.stages.some((s) => s.stage === 'worker') ||
        (await repo.output(messageId))?.reply.businessEvidence !== undefined
      )
        throw new Error('LIVE_ACCESS_BOUNDARY_CHECK_FAILED');
      console.log(
        JSON.stringify({ check: input.check, passed: true, queueId: messageId, toolCalls: 0 }),
      );
    }
    const { rows } = await pool.query(
      `SELECT i.state AS input_state,o.state AS output_state,o.transport FROM public."ramesh-test-inbound-queue" i JOIN public."ramesh-test-outbound-queue" o ON o.message_id=i.id WHERE i.namespace=$1 AND i.employee_id=$2 AND i.conversation=$3`,
      [config.namespace, config.employeeId, conversation],
    );
    if (
      rows.length !== 7 ||
      rows.some(
        (row) =>
          row.input_state !== 'COMPLETED' ||
          row.output_state !== 'CAPTURED' ||
          row.transport !== 'capture',
      )
    )
      throw new Error('LIVE_CAPTURE_QUEUE_CHECK_FAILED');
    console.log(
      JSON.stringify({
        passed: true,
        checks: 9,
        capturedMessages: rows.length,
        model: config.model.model,
        transport: 'capture',
        whatsappConnections: 0,
      }),
    );
  } finally {
    try {
      await chat.drain();
    } finally {
      try {
        await usageMeter.report();
      } finally {
        await pool.end();
      }
    }
  }
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  console.error(/^[A-Z_]+$/.test(message) ? message : 'LIVE_PLAYGROUND_SMOKE_FAILED');
  process.exitCode = 1;
});
