/** One admitted personal-scheduling turn: disposable local PostgreSQL, a real inbound queue
 * lease, the production graph and a locally captured reply. No Baileys socket, scheduler or
 * live employee is constructed. Shared by evals/scheduling-run.ts and the smoke suite. */
import { randomUUID } from 'node:crypto';
import { proto } from '@whiskeysockets/baileys';
import type { AssistantConfig } from '../../src/config/assistant.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import type { AgentTrace, TextModel } from '../../src/modules/assistant/assistant.types.js';
import type { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import type {
  GreetingCandidate,
  TrustedReplyContext,
} from '../../src/modules/greetings/greeting.types.js';
import { PersonalToolService } from '../../src/modules/scheduling/personal-tools.js';
import { PersonalRepository } from '../../src/infrastructure/database/personal.repository.js';
import {
  MessageQueueRepository,
  type MessageJob,
} from '../../src/infrastructure/database/message-queue.repository.js';
import { AgentCheckpointRepository } from '../../src/infrastructure/database/agent-checkpoint.repository.js';
import type { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { encodeReply } from '../../src/modules/messaging/reply-payload.js';
import { getPersonalDelivery } from '../../src/modules/messaging/delivery-evidence.js';
import { combinedTurn } from '../../src/modules/messaging/debounce.js';
import { styleViolations } from '../../src/modules/assistant/style.js';
import type { temporaryMessageDatabase } from '../../tests/fixtures/message-database.js';
import { FIXTURE_EMPLOYEE, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import type { PersistedPersonalState } from './scheduling-outcomes.js';

export type SchedulingDatabase = Awaited<ReturnType<typeof temporaryMessageDatabase>>;
export interface SchedulingMember {
  id: string;
  text: string;
  receivedAtMs: number;
  forwarded: boolean;
}

export function safeError(error: unknown) {
  const match =
    error instanceof Error
      ? /^(USAGE_[A-Z_]+|EVAL_[A-Z_]+|SCHEDULING_EVAL_[A-Z_]+|SOL_EVAL_APPROVAL_REQUIRED)(?:[: ]|$)/.exec(
          error.message,
        )
      : null;
  return match?.[1] ?? 'MODEL_OR_LOCAL_STORAGE_FAILURE';
}

export function instrumentModel(
  model: TextModel,
  record: (event: unknown) => Promise<void>,
): TextModel {
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
        async next(remainingCalls, signal, allowedToolNames) {
          if (!recorded) {
            recorded = true;
            await record({
              kind: 'tool_session',
              messages: request.messages,
              tools: request.tools.map((t) => ({ name: t.name, schema: t.inputSchema })),
            });
          }
          try {
            // Forward the graph's callable subset unchanged, as production does.
            const result = await session.next(remainingCalls, signal, allowedToolNames);
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

export interface SchedulingTrialOptions {
  database: SchedulingDatabase;
  key: string;
  cipher: ReturnType<typeof authCipher>;
  config: AssistantConfig;
  model: TextModel;
  /** One admitted turn; several members form one debounced burst. */
  messages: readonly string[];
  /** Campaign interruption. An aborted campaign is reported separately from a model failure. */
  signal: AbortSignal;
  deadlineMs: number;
  record: (event: unknown) => Promise<void>;
  expectedDueAt?: (memberClocks: number[]) => string | undefined;
  /** Optional synthetic business reads composed with personal tools for mixed requests. */
  businessReads?: (now: () => number) => BusinessReadService;
}
export interface SchedulingTrialRun {
  members: SchedulingMember[];
  checks: string[];
  expectedDueAt?: string;
  error?: string;
  reply?: string;
  trace?: AgentTrace;
  businessEvidence?: unknown;
  captureState?: string;
  persisted?: PersistedPersonalState;
}

async function readPersisted(
  database: SchedulingDatabase,
  cipher: ReturnType<typeof authCipher>,
  account: string,
): Promise<PersistedPersonalState> {
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
  return {
    tasks: counts.tasks,
    commands: counts.commands,
    reminderDeliveries: counts.deliveries,
    reminders: rows.rows.map((row) => ({
      text: cipher.open(`personal-reminder:${row.owner_employee_id}`, row.id, row.text_encrypted),
      dueAt: row.schedule.dueAt,
      state: row.state,
      owner: row.owner_employee_id,
    })),
  };
}

/** Runs once; never retries. Execution and persistence failures are returned as checks. */
export async function runSchedulingTrial(
  options: SchedulingTrialOptions,
): Promise<SchedulingTrialRun> {
  const { database, key, cipher, config, record, signal: campaign } = options;
  const run: SchedulingTrialRun = { members: [], checks: [] };
  const account = `eval-${randomUUID()}`;
  const queue = new MessageQueueRepository(database.runtime, account, {
    textMs: 3000,
    burstMs: 3000,
    maxMs: 8000,
  });
  const personal = new PersonalRepository(database.runtime, account, key);
  const chatId = FIXTURE_JID;
  const actor = {
    employeeId: FIXTURE_EMPLOYEE.employeeId,
    phoneE164: FIXTURE_EMPLOYEE.phoneE164,
    chatId,
  };
  const personalTools = new PersonalToolService(personal, async () => actor);
  const now = Date.now();
  const members: SchedulingMember[] = options.messages.map((text, index) => ({
    id: randomUUID(),
    text,
    receivedAtMs: now - (options.messages.length - index - 1) * 2000,
    forwarded: false,
  }));
  run.members = members;
  run.expectedDueAt = options.expectedDueAt?.(members.map((m) => m.receivedAtMs));
  let job: MessageJob | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let renewing: Promise<void> | undefined;
  const turnAbort = new AbortController();
  const signal = AbortSignal.any([
    campaign,
    turnAbort.signal,
    AbortSignal.timeout(options.deadlineMs),
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
      await database.admin.query(`UPDATE public."ramesh-messages" SET created_at=$2 WHERE id=$1`, [
        member.id,
        new Date(member.receivedAtMs),
      ]);
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
    await record({ kind: 'input', members, expectedDueAt: run.expectedDueAt });
    const clock = () => members.at(-1)!.receivedAtMs;
    const assistant = new AssistantService(
      config,
      instrumentModel(options.model, record),
      undefined,
      () => {},
      undefined,
      options.businessReads?.(clock),
      {
        usageMeter: config.usageMeter,
        personalTools,
        now: clock,
        checkpoints: new AgentCheckpointRepository(database.runtime, {
          namespace: 'production',
          accountId: account,
          encryptionKey: key,
        }),
      },
    );
    const reply = await assistant.prepare(candidate, signal, trusted);
    run.reply = reply.text;
    run.trace = reply.trace;
    run.businessEvidence = reply.businessEvidence;
    await record({ kind: 'assistant_reply', text: reply.text, trace: reply.trace });
    if (reply.trace.outcome !== 'completed') run.checks.push('assistant_did_not_complete');
    run.checks.push(...styleViolations(reply.text));
    if (reply.text.length > 2000) run.checks.push('reply_too_long_for_whatsapp');
    if (/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i.test(reply.text))
      run.checks.push('internal_record_id_in_reply');
    if (reply.businessEvidence !== undefined) {
      // A mixed reply bundles the personal receipt with business evidence; the personal part
      // still needs owner authorization. Without business reads every receipt must be personal.
      const personalPart = getPersonalDelivery(reply.businessEvidence);
      if (
        personalPart
          ? !(await personalTools.canDeliver(trusted.key, personalPart, signal))
          : !options.businessReads
      )
        run.checks.push('private_delivery_authority_failed');
    }
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
    run.captureState = 'CAPTURED_LOCALLY';
    reply.onSent?.();
  } catch (error) {
    run.error = campaign.aborted ? 'SCHEDULING_EVAL_INTERRUPTED' : safeError(error);
    run.checks.push('trial_failed_without_retry');
  } finally {
    clearInterval(heartbeat);
    await renewing;
    try {
      run.persisted = await readPersisted(database, cipher, account);
    } catch {
      run.checks.push('persisted_outcome_unavailable');
    }
  }
  return run;
}
