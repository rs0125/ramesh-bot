/** Opt-in Luna prose checks: synthetic identities + disposable local PostgreSQL + captured replies. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { proto } from '@whiskeysockets/baileys';
import { config as dotenv } from 'dotenv';
import { loadAssistantConfig } from '../src/config/assistant.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { AssistantService } from '../src/modules/assistant/assistant.service.js';
import type { AgentTrace, TextModel } from '../src/modules/assistant/assistant.types.js';
import type {
  GreetingCandidate,
  TrustedReplyContext,
} from '../src/modules/greetings/greeting.types.js';
import { PersonalToolService } from '../src/modules/scheduling/personal-tools.js';
import { PersonalRepository } from '../src/infrastructure/database/personal.repository.js';
import {
  MessageQueueRepository,
  type MessageJob,
} from '../src/infrastructure/database/message-queue.repository.js';
import { AgentCheckpointRepository } from '../src/infrastructure/database/agent-checkpoint.repository.js';
import { authCipher } from '../src/infrastructure/database/auth-store.js';
import { encodeReply } from '../src/modules/messaging/reply-payload.js';
import { getPersonalDelivery } from '../src/modules/messaging/delivery-evidence.js';
import { combinedTurn } from '../src/modules/messaging/debounce.js';
import { styleViolations } from '../src/modules/assistant/style.js';
import { promptManifest } from '../src/modules/assistant/prompt-files.js';
import { temporaryMessageDatabase } from '../tests/fixtures/message-database.js';
import { captureEvalProvenance } from './lib/provenance.js';
import { assertEvalRun, evalModel, evalPolicyOptions } from './lib/run-policy.js';
import { createEvalUsageMeter, evalBudgetOptions, settleEvalWorkers } from './lib/usage-budget.js';

export const SCHEDULING_EVAL_CASES = [
  {
    id: 'hinglish-relative',
    messages: ['Parso subah 10 baje owner ko call karne ka reminder laga de.'],
    expected: 'reminder',
  } as const,
  {
    id: 'burst-correction',
    messages: ['Remind me in 20 minutes to call the owner.', 'Actually make that 40 minutes.'],
    expected: 'reminder',
  } as const,
  {
    id: 'conditional-unsupported',
    messages: ['Remind me tomorrow at 9 am only if that deal still has no follow-up.'],
    expected: 'no-write',
  } as const,
];
type Scenario = (typeof SCHEDULING_EVAL_CASES)[number];

/** Independent time oracle: local IST calendar arithmetic, never calls the implementation normalizer. */
export function expectedReminderInstant(
  caseId: string,
  memberClocks: number[],
): string | undefined {
  if (caseId === 'burst-correction')
    return new Date(memberClocks.at(-1)! + 40 * 60000).toISOString();
  if (caseId === 'hinglish-relative') {
    const date = new Date(memberClocks[0]! + 330 * 60000).toISOString().slice(0, 10);
    const dayAfter = new Date(Date.parse(`${date}T00:00:00Z`) + 2 * 86400000)
      .toISOString()
      .slice(0, 10);
    return new Date(`${dayAfter}T10:00:00+05:30`).toISOString();
  }
  return undefined;
}
interface TrialResult {
  case: string;
  trial: number;
  passed: boolean;
  checks: string[];
  error?: string;
  reply?: string;
  trace?: AgentTrace;
  expectedDueAt?: string;
  persisted?: {
    tasks: number;
    reminders: Array<{ text: unknown; dueAt: string; state: string; owner: number }>;
    commands: number;
    reminderDeliveries: number;
  };
  captureState?: string;
}
function safeError(error: unknown) {
  const match =
    error instanceof Error
      ? /^(USAGE_[A-Z_]+|EVAL_[A-Z_]+|SCHEDULING_EVAL_[A-Z_]+|SOL_EVAL_APPROVAL_REQUIRED)(?:[: ]|$)/.exec(
          error.message,
        )
      : null;
  return match?.[1] ?? 'MODEL_OR_LOCAL_STORAGE_FAILURE';
}
function instrumentModel(model: TextModel, record: (event: unknown) => Promise<void>): TextModel {
  return {
    async complete(request, signal) {
      await record({ kind: 'model_request', stage: request.stage, messages: request.messages });
      try {
        const result = await model.complete(request, signal);
        await record({ kind: 'model_result', stage: request.stage, result });
        return result;
      } catch (error) {
        await record({ kind: 'model_failed', stage: request.stage, reason: safeError(error) });
        throw error;
      }
    },
    startToolSession(request) {
      const session = model.startToolSession!(request);
      let recorded = false;
      return {
        async next(remainingCalls, signal) {
          if (!recorded) {
            recorded = true;
            await record({
              kind: 'tool_session',
              messages: request.messages,
              tools: request.tools.map((t) => ({ name: t.name, schema: t.inputSchema })),
            });
          }
          try {
            const result = await session.next(remainingCalls, signal);
            await record({ kind: 'tool_response', result });
            return result;
          } catch (error) {
            await record({ kind: 'tool_failed', reason: safeError(error) });
            throw error;
          }
        },
        accept(id, output) {
          session.accept(id, output);
        },
        revise: session.revise ? (feedback) => session.revise!(feedback) : undefined,
      };
    },
  };
}

export async function runSchedulingEvaluation() {
  dotenv({ path: new URL('../.env', import.meta.url), quiet: true });
  const { values } = parseArgs({
    options: {
      ...evalPolicyOptions,
      ...evalBudgetOptions,
      model: { type: 'string' },
      case: { type: 'string' },
      trials: { type: 'string', default: '1' },
      'continuation-of': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const trials = Number(values.trials);
  const ids = values.case?.split(',').map((v) => v.trim());
  const cases = SCHEDULING_EVAL_CASES.filter((item) => !ids || ids.includes(item.id));
  if (
    !Number.isSafeInteger(trials) ||
    trials < 1 ||
    !cases.length ||
    cases.length * trials > 3 ||
    ids?.some((id) => !SCHEDULING_EVAL_CASES.some((item) => item.id === id))
  )
    throw new Error(
      'SCHEDULING_EVAL_MAX_THREE_TRIALS: choose known cases and at most three total executions',
    );
  const selectedModel = evalModel(values.model);
  const spendingPolicy = assertEvalRun([selectedModel], cases.length * trials, values);
  if (values['dry-run']) {
    console.log(
      JSON.stringify(
        {
          model: selectedModel,
          toolReasoningEffort: 'low',
          continuationOf: values['continuation-of'],
          ...spendingPolicy,
          cases,
          paidCalls: 0,
          database: 'Disposable local PostgreSQL only',
          transport: 'Captured locally; no Baileys or scheduler',
          deadlineMs: 120000,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!process.env.TEST_MESSAGE_DATABASE_URL)
    throw new Error('SCHEDULING_EVAL_LOCAL_DATABASE_REQUIRED');
  const loaded = loadAssistantConfig({
    ...process.env,
    OPENAI_MODEL: selectedModel,
    AGENT_TOOL_REASONING_EFFORT: 'low',
    AGENT_TIMEOUT_MS: '120000',
    AGENT_MAX_OUTPUT_TOKENS: '2000',
    TAVILY_API_KEY: undefined,
    USAGE_MODE: 'off',
  });
  if (!loaded) throw new Error('SCHEDULING_EVAL_API_KEY_REQUIRED');
  const runId = `scheduling-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const directory = fileURLToPath(new URL(`../.local/evals/${runId}/`, import.meta.url));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const provenance = await captureEvalProvenance(new URL('../', import.meta.url));
  const manifest = {
    runId,
    model: selectedModel,
    toolReasoningEffort: 'low',
    continuationOf: values['continuation-of'],
    deadlineMs: 120000,
    spendingPolicy,
    cases,
    prompts: promptManifest(),
    inputHash: provenance.inputHash,
    datasetHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
    transport:
      'Local captured replies only; no Baileys factory, scheduler, live employee or business database',
  };
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({ ...manifest, inputs: provenance.inputManifest }, null, 2),
    { mode: 0o600, flag: 'wx' },
  );
  const usageMeter = await createEvalUsageMeter(
    { ...values, campaignId: runId, directory },
    process.env,
    [selectedModel],
  );
  const config = { ...loaded, usageMeter };
  const native = new OpenAITextModel(config);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('SCHEDULING_EVAL_INTERRUPTED'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const results: TrialResult[] = [];
  let db: Awaited<ReturnType<typeof temporaryMessageDatabase>> | undefined;
  let fatal: string | undefined;
  let stoppedReason: string | undefined;
  let usageBudget: Awaited<ReturnType<typeof usageMeter.report>> | undefined;
  const started = Date.now();
  console.log(
    `Scheduling eval: ${cases.length * trials} ${selectedModel} trials; synthetic PostgreSQL and capture only.`,
  );
  try {
    db = await temporaryMessageDatabase();
    const database = db;
    const key = randomBytes(32).toString('base64url');
    const cipher = authCipher(key);
    const work = cases.flatMap((scenario) =>
      Array.from({ length: trials }, (_, i) => ({ scenario, trial: i + 1 })),
    );
    usageBudget = await settleEvalWorkers(usageMeter, [
      (async () => {
        for (const item of work) {
          if (controller.signal.aborted) break;
          const { scenario, trial } = item;
          const result: TrialResult = { case: scenario.id, trial, passed: false, checks: [] };
          results.push(result);
          const name = `${scenario.id}-${trial}`;
          const record = async (event: unknown) => {
            await appendFile(
              join(directory, `${name}.trace.ndjson`),
              JSON.stringify(event) + '\n',
              { mode: 0o600 },
            );
          };
          const account = `eval-${randomUUID()}`;
          const queue = new MessageQueueRepository(database.runtime, account, {
            textMs: 3000,
            burstMs: 3000,
            maxMs: 8000,
          });
          const personal = new PersonalRepository(database.runtime, account, key);
          const chatId = '919000000023@s.whatsapp.net';
          const actor = { employeeId: 23, phoneE164: '+919000000023', chatId };
          const personalTools = new PersonalToolService(personal, async () => actor);
          const now = Date.now();
          const members = scenario.messages.map((text, index) => ({
            id: randomUUID(),
            text,
            receivedAtMs: now - (scenario.messages.length - index - 1) * 2000,
            forwarded: false,
          }));
          result.expectedDueAt = expectedReminderInstant(
            scenario.id,
            members.map((m) => m.receivedAtMs),
          );
          let job: MessageJob | null = null;
          let heartbeat: ReturnType<typeof setInterval> | undefined;
          let renewing: Promise<void> | undefined;
          const turnAbort = new AbortController();
          const signal = AbortSignal.any([
            controller.signal,
            turnAbort.signal,
            AbortSignal.timeout(120000),
          ]);
          try {
            for (const member of members) {
              const candidate: GreetingCandidate = {
                chatId,
                senderId: chatId,
                messageId: member.id,
                sentAtMs: member.receivedAtMs,
                text: member.text,
                kind: 'text',
                fromMe: false,
                isGroup: false,
                mentionsBot: false,
              };
              await queue.enqueue(
                member.id,
                candidate,
                cipher.seal(
                  'message',
                  member.id,
                  Buffer.from(
                    proto.WebMessageInfo.encode({
                      key: { remoteJid: chatId, id: member.id, fromMe: false },
                      messageTimestamp: Math.floor(member.receivedAtMs / 1000),
                      message: { conversation: member.text },
                    }).finish(),
                  ),
                ),
                300000,
                100,
                {
                  replyEligible: true,
                  content: cipher.seal('inbox', member.id, {
                    text: member.text,
                    senderId: chatId,
                    senderName: 'Synthetic employee',
                    chatName: null,
                    kind: 'text',
                  }),
                },
              );
              await database.admin.query(
                `UPDATE public."ramesh-messages" SET created_at=$2 WHERE id=$1`,
                [member.id, new Date(member.receivedAtMs)],
              );
            }
            await database.admin.query(
              `UPDATE public."ramesh-inbound-queue" SET available_at=clock_timestamp() WHERE account_id=$1`,
              [account],
            );
            job = await queue.claimInbound(30000);
            if (!job || job.id !== members[0]!.id || !(await queue.beginAgentRun(job)))
              throw new Error('SCHEDULING_EVAL_ADMISSION_FAILED');
            const held = job;
            heartbeat = setInterval(() => {
              if (renewing) return;
              renewing = queue
                .renewLease(held, 30000)
                .then(
                  (ok) => {
                    if (!ok) turnAbort.abort();
                  },
                  () => turnAbort.abort(),
                )
                .finally(() => {
                  renewing = undefined;
                });
            }, 10000);
            heartbeat.unref();
            const trusted: TrustedReplyContext = {
              runId: job.id,
              key: { remoteJid: chatId, fromMe: false },
              checkpointLease: { leaseToken: job.token },
              commandMessages: members,
              record: async (kind, value) => {
                await record({ kind, value });
              },
            };
            const candidate: GreetingCandidate = {
              chatId,
              senderId: chatId,
              messageId: members[0]!.id,
              sentAtMs: members[0]!.receivedAtMs,
              text: combinedTurn(members),
              fromMe: false,
              isGroup: false,
              mentionsBot: false,
              ...(members.length > 1 ? { batchMessageIds: members.map((m) => m.id) } : {}),
            };
            await record({ kind: 'input', members, expectedDueAt: result.expectedDueAt });
            const assistant = new AssistantService(
              config,
              instrumentModel(native, record),
              undefined,
              () => {},
              undefined,
              undefined,
              {
                usageMeter,
                personalTools,
                now: () => members.at(-1)!.receivedAtMs,
                checkpoints: new AgentCheckpointRepository(database.runtime, {
                  namespace: 'production',
                  accountId: account,
                  encryptionKey: key,
                }),
              },
            );
            const reply = await assistant.prepare(candidate, signal, trusted);
            result.reply = reply.text;
            result.trace = reply.trace;
            await record({ kind: 'assistant_reply', text: reply.text, trace: reply.trace });
            if (reply.trace.outcome !== 'completed')
              result.checks.push('assistant_did_not_complete');
            result.checks.push(...styleViolations(reply.text));
            if (reply.text.length > 2000) result.checks.push('reply_too_long_for_whatsapp');
            if (/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i.test(reply.text))
              result.checks.push('internal_record_id_in_reply');
            if (
              reply.businessEvidence !== undefined &&
              !(await personalTools.canDeliver(trusted.key, reply.businessEvidence, signal))
            )
              result.checks.push('private_delivery_authority_failed');
            const protectedReply = reply.businessEvidence !== undefined;
            if (
              !(await queue.handoff(
                job,
                cipher.seal('outbound-reply', job.id, encodeReply(reply.text, protectedReply)),
                new Date(),
                protectedReply
                  ? cipher.seal('business-delivery', job.id, reply.businessEvidence)
                  : undefined,
                getPersonalDelivery(reply.businessEvidence)?.commandId,
              ))
            )
              throw new Error('SCHEDULING_EVAL_CAPTURE_HANDOFF_FAILED');
            const captured = await queue.claimOutbound(30000);
            if (
              !captured ||
              !(await queue.beginSend(captured)) ||
              !(await queue.complete(captured, 'SENT'))
            )
              throw new Error('SCHEDULING_EVAL_CAPTURE_FINALIZE_FAILED');
            result.captureState = 'CAPTURED_LOCALLY';
            reply.onSent?.();
          } catch (error) {
            result.error = controller.signal.aborted
              ? 'SCHEDULING_EVAL_INTERRUPTED'
              : safeError(error);
            result.checks.push('trial_failed_without_retry');
          } finally {
            clearInterval(heartbeat);
            await renewing;
            try {
              const rows = await database.runtime.query<{
                id: string;
                text_encrypted: string;
                schedule: { dueAt: string };
                state: string;
                owner_employee_id: number;
              }>(
                `SELECT id,text_encrypted,schedule,state,owner_employee_id FROM public."ramesh-reminders" WHERE account_id=$1 ORDER BY created_at,id`,
                [account],
              );
              const counts = (
                await database.runtime.query<{
                  tasks: number;
                  commands: number;
                  deliveries: number;
                }>(
                  `SELECT
              (SELECT count(*)::int FROM public."ramesh-tasks" WHERE account_id=$1) AS tasks,
              (SELECT count(*)::int FROM public."ramesh-assistant-commands" WHERE account_id=$1 AND kind='mutation') AS commands,
              (SELECT count(*)::int FROM public."ramesh-messages" WHERE account_id=$1 AND origin='reminder') AS deliveries`,
                  [account],
                )
              ).rows[0]!;
              result.persisted = {
                tasks: counts.tasks,
                commands: counts.commands,
                reminderDeliveries: counts.deliveries,
                reminders: rows.rows.map((row) => ({
                  text: cipher.open(
                    `personal-reminder:${row.owner_employee_id}`,
                    row.id,
                    row.text_encrypted,
                  ),
                  dueAt: row.schedule.dueAt,
                  state: row.state,
                  owner: row.owner_employee_id,
                })),
              };
              if (counts.tasks !== 0) result.checks.push('unrequested_task_created');
              if (counts.deliveries !== 0) result.checks.push('future_reminder_enqueued_early');
              if (scenario.expected === 'reminder') {
                if (rows.rowCount !== 1 || counts.commands !== 1)
                  result.checks.push('expected_one_committed_reminder');
                const saved = result.persisted.reminders[0];
                if (saved?.dueAt !== result.expectedDueAt)
                  result.checks.push('wrong_resolved_instant');
                if (saved?.owner !== 23 || saved.state !== 'scheduled')
                  result.checks.push('wrong_owner_or_state');
                if (
                  typeof saved?.text !== 'string' ||
                  !/(owner)/i.test(saved.text) ||
                  !/call/i.test(saved.text)
                )
                  result.checks.push('wrong_reminder_content');
                if (
                  !/saved reminder/i.test(result.reply ?? '') ||
                  !/(IST|Asia\/Kolkata)/.test(result.reply ?? '')
                )
                  result.checks.push('missing_committed_time_acknowledgement');
              } else {
                if (rows.rowCount !== 0 || counts.commands !== 0)
                  result.checks.push('unsupported_conditional_mutation');
                if (
                  !/(conditional|condition.{0,70}reminder|reminder.{0,70}condition|due[- ]time|(?:scheduled|delivery) time)/i.test(
                    result.reply ?? '',
                  ) ||
                  !/(can[’']t|cannot|couldn[’']t|not (?:yet|supported|available)|unable|unsupported|unavailable|don[’']t support)/i.test(
                    result.reply ?? '',
                  ) ||
                  /use (?:an?|another) account|(?:get|grant|obtain).{0,45}(?:permission|access)/i.test(
                    result.reply ?? '',
                  ) ||
                  /(?:saved reminder|i(?:'ll| will) remind you)/i.test(result.reply ?? '')
                )
                  result.checks.push('missing_truthful_conditional_limitation');
              }
            } catch {
              result.checks.push('persisted_outcome_unavailable');
            }
            // The shared meter may be caught and rendered as an unavailable reply by
            // the graph. Its terminal stop still ends this campaign immediately.
            const currentUsage = await usageMeter.report();
            if (currentUsage.stoppedReason) {
              stoppedReason = currentUsage.stoppedReason;
              result.error ??= currentUsage.stoppedReason;
              result.checks.push('campaign_stopped_by_usage_meter');
            }
            result.passed = result.checks.length === 0 && !result.error;
            await writeFile(join(directory, `${name}.json`), JSON.stringify(result, null, 2), {
              mode: 0o600,
            });
            await appendFile(join(directory, 'trials.ndjson'), JSON.stringify(result) + '\n', {
              mode: 0o600,
            });
            console.log(
              `${result.passed ? 'PASS' : 'FAIL'} ${name}${result.checks.length ? ` (${result.checks.join(', ')})` : ''}`,
            );
          }
          if (stoppedReason) break;
        }
      })(),
    ]);
  } catch (error) {
    fatal = safeError(error);
  } finally {
    usageBudget ??= await usageMeter.report();
    await db?.close();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    const passed = results.filter((item) => item.passed).length;
    const notRun = cases
      .flatMap((scenario) =>
        Array.from({ length: trials }, (_, i) => ({ case: scenario.id, trial: i + 1 })),
      )
      .filter(
        (item) =>
          !results.some((result) => result.case === item.case && result.trial === item.trial),
      )
      .map((item) => ({
        ...item,
        reason:
          stoppedReason ??
          fatal ??
          (controller.signal.aborted
            ? 'SCHEDULING_EVAL_INTERRUPTED'
            : 'SCHEDULING_EVAL_NOT_STARTED'),
      }));
    const report = {
      ...manifest,
      durationMs: Date.now() - started,
      passed,
      total: results.length,
      planned: cases.length * trials,
      interrupted: controller.signal.aborted,
      fatal,
      stoppedReason,
      usageBudget,
      results,
      notRun,
      limits:
        'Three prose probes are not a production quality gate. No separate paid grader. Persistence/cancellation correctness uses deterministic suites.',
    };
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    await writeFile(
      join(directory, 'report.md'),
      [
        '# Personal scheduling prose evaluation',
        '',
        `Model: ${selectedModel}; tool effort: low. ${passed}/${results.length} passed; ${cases.length * trials} planned.`,
        'Synthetic employee and disposable local PostgreSQL. Replies captured without a WhatsApp session or running scheduler.',
        '',
        ...results.map(
          (item) =>
            `- ${item.passed ? 'PASS' : 'FAIL'} ${item.case} trial ${item.trial}: ${item.checks.join(', ') || 'outcomes matched'}`,
        ),
        ...notRun.map((item) => `- NOT RUN ${item.case} trial ${item.trial}: ${item.reason}`),
        '',
        `Fatal status: ${fatal ?? 'none'}. Budget stop: ${stoppedReason ?? 'none'}. Interrupted: ${controller.signal.aborted}.`,
        'All failed/interrupted attempts and shared usage accounting remain in this directory. No automatic retries of scenarios.',
      ].join('\n'),
      { mode: 0o600 },
    );
    console.log(`Report: ${directory}`);
    if (
      fatal ||
      controller.signal.aborted ||
      results.length !== cases.length * trials ||
      passed !== results.length
    )
      process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runSchedulingEvaluation().catch((error) => {
    console.error(
      `Scheduling eval stopped: ${safeError(error)}. No scenario was automatically retried.`,
    );
    process.exitCode = 1;
  });
