/** Local personal tools. Models propose one batch; application authority and receipts own writes. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TrustedReplyContext } from '../greetings/greeting.types.js';
import type { ToolSessionRequest } from '../assistant/assistant.types.js';
import { CheckpointError } from '../assistant/checkpoint.types.js';
import { currentCheckpoint } from '../assistant/model-replay.js';
import { formatIst, resolveSchedule, validateTaskDeadline } from './schedule-time.js';
import {
  SchedulingError,
  type PersonalActor,
  type PersonalCommandContext,
  type PersonalCommandReceipt,
  type PersonalListResult,
  type PersonalOperation,
  type PersonalRecord,
  type VersionedTarget,
} from './scheduling.types.js';

export interface PersonalRepositoryPort {
  getReceipt(context: PersonalCommandContext): Promise<PersonalCommandReceipt | null>;
  applyBatch(
    context: PersonalCommandContext,
    operations: PersonalOperation[],
  ): Promise<PersonalCommandReceipt>;
  list(
    actor: PersonalActor,
    kind: 'task' | 'reminder',
    runId: string,
    options?: { state?: string; limit?: number; cursor?: string },
  ): Promise<PersonalListResult>;
  resolveSelection(
    actor: PersonalActor,
    kind: 'task' | 'reminder',
    selectionId: string,
    ordinal: number,
  ): Promise<VersionedTarget>;
  finalizeSelections(context: PersonalCommandContext, ids: string[]): Promise<void>;
}
type Resolver = (
  key: TrustedReplyContext['key'],
  signal: AbortSignal,
) => Promise<PersonalActor | null>;
const deliverySchema = z
  .object({
    kind: z.literal('personal'),
    version: z.literal(1),
    employeeId: z.number().int().positive(),
    phoneE164: z.string().regex(/^\+[1-9]\d{7,14}$/),
    runId: z.string().min(1),
    commandId: z.string().optional(),
    selectionId: z.string().optional(),
  })
  .strict();
export type PersonalDelivery = z.infer<typeof deliverySchema>;
export interface PersonalReply {
  text: string;
  delivery: PersonalDelivery;
}

const sourceSchema = z
  .object({ messageId: z.string().min(1).max(200), quote: z.string().min(1).max(6000) })
  .strict();
const targetSchema = z.union([
  z
    .object({ id: z.string().min(1).max(200), expectedVersion: z.number().int().positive() })
    .strict(),
  z
    .object({ selectionId: z.string().min(1).max(200), ordinal: z.number().int().min(1).max(25) })
    .strict(),
]);
const recurrenceSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    dayOfMonth: z.union([z.number().int().min(1).max(31), z.literal('last')]).optional(),
    until: z.string().max(40).optional(),
  })
  .strict();
const timeSchema = z
  .object({
    localDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    localTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    afterMinutes: z.number().int().positive().max(4000000000).optional(),
    recurrence: recurrenceSchema.optional(),
  })
  .strict();
const deadlineSchema = z.union([
  z
    .object({
      precision: z.literal('date'),
      localDate: z.string(),
      timezone: z.literal('Asia/Kolkata'),
    })
    .strict(),
  z
    .object({
      precision: z.literal('instant'),
      at: z.string(),
      timezone: z.literal('Asia/Kolkata'),
    })
    .strict(),
]);
const textSchema = z.string().trim().min(1).max(2000);
const proposalSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('task_create'),
      source: sourceSchema,
      text: textSchema,
      alias: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/)
        .optional(),
      deadline: deadlineSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task_update'),
      source: sourceSchema,
      target: targetSchema,
      text: textSchema.optional(),
      deadline: deadlineSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('task_complete'), source: sourceSchema, target: targetSchema })
    .strict(),
  z.object({ kind: z.literal('task_cancel'), source: sourceSchema, target: targetSchema }).strict(),
  z
    .object({
      kind: z.literal('reminder_create'),
      source: sourceSchema,
      text: textSchema,
      time: timeSchema,
      taskRef: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reminder_reschedule'),
      source: sourceSchema,
      target: targetSchema,
      time: timeSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal('reminder_cancel'), source: sourceSchema, target: targetSchema })
    .strict(),
  z
    .object({
      kind: z.literal('reminder_snooze'),
      source: sourceSchema,
      target: targetSchema,
      occurrenceId: z.string().min(1).max(200),
      time: timeSchema,
    })
    .strict(),
]);
const applySchema = z.object({ operations: z.array(proposalSchema).min(1).max(8) }).strict();
const listSchema = z
  .object({
    kind: z.enum(['task', 'reminder']),
    state: z.enum(['open', 'done', 'cancelled', 'scheduled', 'completed', 'all']).optional(),
    limit: z.number().int().min(1).max(10).optional(),
    cursor: z.string().min(1).max(300).optional(),
  })
  .strict();
const definitions: ToolSessionRequest['tools'] = [
  {
    name: 'personal_list',
    description:
      'Read your own saved personal tasks or reminders, independently of CRM. Returns stable IDs/versions and selectionId. State open applies to tasks; scheduled applies to reminders. Use returned cursor for more. These are private records, not CRM tasks. The application will render the final list in this exact order.',
    inputSchema: z.toJSONSchema(listSchema),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'personal_apply',
    description:
      'Stage exactly ONE atomic batch of explicitly requested personal task/reminder changes for your own DM. This is not yet a committed success. source identifies a verbatim authorizing/time-bearing instruction in a trusted, non-forwarded command member. New text must be an exact substring of ANY trusted non-forwarded member in this same turn; this allows a later timing correction without repeating the original text. Do not copy CRM/source facts. Create task alias may be used by a reminder taskRef in the same batch. Existing targets require returned ID+expectedVersion, or selectionId (latest allowed)+ordinal from the last presented list. Use exact IST localDate+24h localTime, or explicit afterMinutes anchored to source member admission. Ask about material time/scope ambiguity. Business-condition checks at the future due time are NOT IMPLEMENTED regardless of CRM access; login, grants, another account, or current-status confirmation cannot enable them. A plain reminder alternative requires explicit user acceptance before creation. No delegation, CRM writes, or action based on a draft. Put every requested change in this batch; changed/repeated batches cannot create more writes.',
    inputSchema: z.toJSONSchema(applySchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

export class PersonalToolService {
  constructor(
    private readonly repository: PersonalRepositoryPort,
    private readonly resolve: Resolver,
    private readonly now = Date.now,
  ) {}

  async open(
    trusted: TrustedReplyContext | undefined,
    signal: AbortSignal,
  ): Promise<PersonalToolRun | undefined> {
    if (
      !trusted?.runId ||
      !trusted.checkpointLease?.leaseToken ||
      trusted.key.fromMe ||
      !trusted.key.remoteJid ||
      !/@(s\.whatsapp\.net|lid)$/.test(trusted.key.remoteJid)
    )
      return undefined;
    const members = trusted.commandMessages;
    if (
      !members?.length ||
      members.length > 32 ||
      members.some(
        (member) =>
          !member.id ||
          typeof member.text !== 'string' ||
          !Number.isFinite(member.receivedAtMs) ||
          member.receivedAtMs <= 0 ||
          typeof member.forwarded !== 'boolean',
      )
    )
      return undefined;
    if (!members.some((member) => !member.forwarded && member.text.trim())) return undefined;
    signal.throwIfAborted();
    const actor = await this.resolve(trusted.key, signal);
    signal.throwIfAborted();
    if (!actor || actor.chatId !== trusted.key.remoteJid) return undefined;
    return new PersonalToolRun(this.repository, this.resolve, actor, trusted, this.now);
  }

  async canDeliver(
    key: TrustedReplyContext['key'],
    stored: unknown,
    signal: AbortSignal,
  ): Promise<boolean> {
    const parsed = deliverySchema.safeParse(stored);
    if (
      !parsed.success ||
      key.fromMe ||
      !key.remoteJid ||
      !/@(s\.whatsapp\.net|lid)$/.test(key.remoteJid)
    )
      return false;
    try {
      signal.throwIfAborted();
      const actor = await this.resolve(key, signal);
      signal.throwIfAborted();
      return (
        !!actor &&
        actor.chatId === key.remoteJid &&
        actor.employeeId === parsed.data.employeeId &&
        actor.phoneE164 === parsed.data.phoneE164
      );
    } catch {
      return false;
    }
  }
}

export class PersonalToolRun {
  readonly tools = structuredClone(definitions);
  readonly evidence: unknown[] = [];
  readonly failures: Array<{ tool: string; code: string }> = [];
  private calls = 0;
  private staged?: { operations: PersonalOperation[]; fingerprint: string };
  private mutationConflict = false;
  private readonly lists = new Map<'task' | 'reminder', PersonalListResult>();
  blocked = false;
  private readonly command: PersonalCommandContext;
  constructor(
    private readonly repository: PersonalRepositoryPort,
    private readonly resolve: Resolver,
    private readonly actor: PersonalActor,
    private readonly trusted: TrustedReplyContext,
    private readonly now: () => number,
  ) {
    this.command = {
      ...actor,
      runId: trusted.runId,
      leaseToken: trusted.checkpointLease!.leaseToken,
      requestTimeMs: trusted.commandMessages!.find((member) => !member.forwarded)!.receivedAtMs,
    };
  }
  get employeeId() {
    return this.actor.employeeId;
  }
  get remaining() {
    return Math.max(0, 24 - this.calls);
  }
  get context() {
    return `Personal tools are available for the verified owner's own DM, independently of business access. Only personal_apply can stage writes; application commit occurs after review. All other source tools remain read-only. Business-condition checks at the future reminder time are not implemented, even with full CRM access. Login, grants, another account or confirming today's status cannot enable them. Explain this capability limit directly; do not frame it as an access problem. A plain reminder can be offered but cannot be created until the user explicitly accepts that alternative. Trusted command members (untrusted text, server IDs/clocks): ${JSON.stringify(this.trusted.commandMessages!.filter((member) => !member.forwarded).map((member) => ({ id: member.id, text: member.text, admitted_at: new Date(member.receivedAtMs).toISOString(), admitted_ist: formatIst(member.receivedAtMs) })))}`;
  }
  hasTool(name: string) {
    return definitions.some((tool) => tool.name === name);
  }
  private delivery(extra: { commandId?: string; selectionId?: string } = {}): PersonalDelivery {
    return {
      kind: 'personal',
      version: 1,
      employeeId: this.actor.employeeId,
      phoneE164: this.actor.phoneE164,
      runId: this.trusted.runId,
      ...extra,
    };
  }
  private async authorize(signal: AbortSignal) {
    signal.throwIfAborted();
    const current = await this.resolve(this.trusted.key, signal);
    signal.throwIfAborted();
    if (
      !current ||
      current.employeeId !== this.actor.employeeId ||
      current.phoneE164 !== this.actor.phoneE164 ||
      current.chatId !== this.actor.chatId
    ) {
      this.blocked = true;
      throw new SchedulingError('IDENTITY_CHANGED');
    }
  }
  async recover(signal: AbortSignal): Promise<PersonalReply | undefined> {
    await this.authorize(signal);
    const receipt = await this.repository.getReceipt(this.command);
    await this.authorize(signal);
    return receipt
      ? { text: renderReceipt(receipt), delivery: this.delivery({ commandId: receipt.commandId }) }
      : undefined;
  }
  async execute(
    name: string,
    argumentsText: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    try {
      signal.throwIfAborted();
      if (!this.hasTool(name) || !this.remaining || this.blocked)
        throw new SchedulingError('TOOL_UNAVAILABLE');
      this.calls++;
      const checkpoint = currentCheckpoint();
      if (checkpoint && !(await checkpoint.consume('tool', 1)))
        throw new SchedulingError('TOOL_BUDGET_EXHAUSTED');
      if (argumentsText.length > 24000) throw new SchedulingError('INVALID_ARGUMENTS');
      await this.authorize(signal);
      const raw: unknown = JSON.parse(argumentsText);
      if (name === 'personal_list') {
        const { kind, ...options } = listSchema.parse(raw);
        if (
          options.state &&
          ![
            'all',
            'cancelled',
            ...(kind === 'task' ? ['open', 'done'] : ['scheduled', 'completed']),
          ].includes(options.state)
        )
          throw new SchedulingError('INVALID_STATE');
        const result = await this.repository.list(this.actor, kind, this.trusted.runId, {
          ...options,
          limit: options.limit ?? 10,
        });
        await this.authorize(signal);
        this.lists.set(kind, result);
        const output = { ok: true, kind, ...result };
        this.evidence.push(output);
        return output;
      }
      const parsed = applySchema.parse(raw);
      const operations: PersonalOperation[] = [];
      for (const proposal of parsed.operations) {
        const member = this.trusted.commandMessages!.find(
          (entry) => entry.id === proposal.source.messageId,
        );
        if (!member || member.forwarded || !member.text.includes(proposal.source.quote))
          throw new SchedulingError('UNTRUSTED_COMMAND_SOURCE');
        const textMember =
          'text' in proposal && proposal.text !== undefined
            ? this.trusted.commandMessages!.find(
                (entry) => !entry.forwarded && entry.text.includes(proposal.text!),
              )
            : undefined;
        if ('text' in proposal && proposal.text !== undefined && !textMember)
          throw new SchedulingError('TEXT_MUST_BE_USER_AUTHORED');
        // First-slice guard for explicit conditions, not a general natural-language parser.
        // "Ask when the shipment arrives" remains ordinary reminder text.
        if (
          ['reminder_create', 'reminder_reschedule'].includes(proposal.kind) &&
          /\b(if|unless|provided that|only when)\b|\bremind\s+me\s+when\b|अगर|यदि|जब/iu.test(
            [member.text, textMember?.text ?? ''].join('\n'),
          )
        )
          throw new SchedulingError('CONDITIONAL_REMINDERS_UNAVAILABLE');
        const target =
          'target' in proposal
            ? 'id' in proposal.target
              ? proposal.target
              : await this.repository.resolveSelection(
                  this.actor,
                  proposal.kind.startsWith('task_') ? 'task' : 'reminder',
                  proposal.target.selectionId,
                  proposal.target.ordinal,
                )
            : undefined;
        switch (proposal.kind) {
          case 'task_create':
            operations.push({
              kind: proposal.kind,
              text: proposal.text,
              ...(proposal.alias ? { alias: proposal.alias } : {}),
              ...(proposal.deadline ? { deadline: validateTaskDeadline(proposal.deadline) } : {}),
            });
            break;
          case 'task_update':
            if (proposal.text === undefined && proposal.deadline === undefined)
              throw new SchedulingError('EMPTY_UPDATE');
            operations.push({
              kind: proposal.kind,
              ...target!,
              ...(proposal.text !== undefined ? { text: proposal.text } : {}),
              ...(proposal.deadline !== undefined
                ? {
                    deadline:
                      proposal.deadline === null ? null : validateTaskDeadline(proposal.deadline),
                  }
                : {}),
            });
            break;
          case 'task_complete':
          case 'task_cancel':
          case 'reminder_cancel':
            operations.push({ kind: proposal.kind, ...target! });
            break;
          case 'reminder_create':
            operations.push({
              kind: proposal.kind,
              text: proposal.text,
              schedule: resolveSchedule(proposal.time, member.receivedAtMs),
              ...(proposal.taskRef ? { taskRef: proposal.taskRef } : {}),
            });
            break;
          case 'reminder_reschedule':
            operations.push({
              kind: proposal.kind,
              ...target!,
              schedule: resolveSchedule(proposal.time, member.receivedAtMs),
            });
            break;
          case 'reminder_snooze':
            if (proposal.time.recurrence)
              throw new SchedulingError('SNOOZE_DOES_NOT_CHANGE_RECURRENCE');
            operations.push({
              kind: proposal.kind,
              ...target!,
              occurrenceId: proposal.occurrenceId,
              dueAt: resolveSchedule(proposal.time, member.receivedAtMs).dueAt,
            });
            break;
        }
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(operations)).digest('hex');
      if (this.staged && this.staged.fingerprint !== fingerprint)
        throw new SchedulingError('ONE_MUTATION_BATCH_PER_TURN');
      await this.authorize(signal);
      if (checkpoint)
        await checkpoint.policy<{ employeeId: number; fingerprint: string }>(
          'personal_batch',
          (previous) => {
            if (
              previous &&
              (previous.employeeId !== this.employeeId || previous.fingerprint !== fingerprint)
            )
              throw new SchedulingError('COMMAND_REPLAY_CONFLICT');
            return { employeeId: this.employeeId, fingerprint };
          },
        );
      this.staged = { operations, fingerprint };
      const output = {
        ok: true,
        status: 'staged_not_committed',
        operations,
        source_instructions: parsed.operations.map((proposal) => proposal.source),
        requires_verified_finish: true,
      };
      this.evidence.push(output);
      return output;
    } catch (error) {
      if (error instanceof CheckpointError) throw error;
      signal.throwIfAborted();
      const code =
        error instanceof SchedulingError
          ? error.code
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 'INVALID_ARGUMENTS'
            : 'UNAVAILABLE';
      if (['ONE_MUTATION_BATCH_PER_TURN', 'COMMAND_REPLAY_CONFLICT'].includes(code))
        this.mutationConflict = true;
      this.failures.push({ tool: name, code });
      return {
        ok: false,
        code,
        mutation_committed: false,
        recovery:
          'Do not claim success. Resolve material ambiguity or ask the user for the missing instruction; never substitute another target.',
      };
    }
  }
  async finish(signal: AbortSignal): Promise<PersonalReply | undefined> {
    if (!this.staged && !this.lists.size && !this.failures.length) return undefined;
    await this.authorize(signal);
    if (this.mutationConflict || (!this.staged && !this.lists.size))
      return {
        text: "I couldn't save that personal change. Please clarify the exact task or reminder and its time; nothing from this request was changed.",
        delivery: this.delivery(),
      };
    if (this.staged) {
      // The repository fences the original inbound lease and commits every mutation with its receipt.
      const receipt = await this.repository.applyBatch(this.command, this.staged.operations);
      await this.authorize(signal);
      return {
        text: renderReceipt(receipt),
        delivery: this.delivery({ commandId: receipt.commandId }),
      };
    }
    const text = [...this.lists].map(([kind, result]) => renderList(kind, result)).join('\n\n');
    signal.throwIfAborted();
    await this.repository.finalizeSelections(
      this.command,
      [...this.lists.values()].map((result) => result.selectionId),
    );
    await this.authorize(signal);
    return {
      text,
      delivery: this.delivery({ selectionId: [...this.lists.values()].at(-1)!.selectionId }),
    };
  }
}

function describe(record: PersonalRecord, receipt = false): string {
  const pendingOccurrence =
    record.occurrenceDueAt &&
    ['pending', 'preparing', 'waiting_source', 'queued'].includes(record.occurrenceState ?? '')
      ? record.occurrenceDueAt
      : undefined;
  const nextDue = [record.nextDueAt, pendingOccurrence]
    .filter((value): value is string => !!value)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const reminderTime = receipt
    ? `; ${formatIst(record.occurrenceDueAt ?? record.nextDueAt ?? record.schedule?.dueAt ?? record.createdAt)}`
    : nextDue
      ? `; next ${formatIst(nextDue)}${pendingOccurrence && pendingOccurrence !== nextDue ? `; pending notification ${formatIst(pendingOccurrence)}` : ''}`
      : `; ${record.occurrenceDueAt ? 'last scheduled' : 'scheduled'} ${formatIst(record.occurrenceDueAt ?? record.schedule?.dueAt ?? record.createdAt)}`;
  const time = record.schedule
    ? reminderTime
    : record.deadline?.precision === 'instant'
      ? `; due ${formatIst(record.deadline.at)}`
      : record.deadline
        ? `; due ${record.deadline.localDate} (IST date)`
        : '';
  const rule = record.schedule?.recurrence;
  const recurrence = !rule
    ? ''
    : rule.frequency === 'daily'
      ? '; daily'
      : rule.frequency === 'weekly'
        ? `; weekly on ${rule.weekdays!.map((day) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day - 1]).join(', ')}`
        : `; monthly ${rule.dayOfMonth === 'last' ? 'on the last day' : `on day ${rule.dayOfMonth} (months without that date are skipped)`}`;
  const compactText = record.text.replace(/\s+/g, ' ').trim();
  return `${compactText.length > 280 ? compactText.slice(0, 277) + '...' : compactText}${time}${recurrence}${rule?.until ? `; until ${formatIst(rule.until)}` : ''}`;
}
export function renderReceipt(receipt: PersonalCommandReceipt): string {
  return receipt.records
    .map(
      (record) =>
        `${record.kind === 'task' ? (record.state === 'done' ? 'Completed task' : record.state === 'cancelled' ? 'Cancelled task' : 'Saved task') : record.state === 'cancelled' ? 'Cancelled reminder' : 'Saved reminder'}: ${describe(record, true)}.${record.affectedReminders ? ` Cancelled ${record.affectedReminders} linked reminder${record.affectedReminders === 1 ? '' : 's'}.` : ''}${record.alreadySending ? ' A notification has already started sending and may still arrive.' : ''}`,
    )
    .join('\n');
}
export function renderList(kind: 'task' | 'reminder', result: PersonalListResult): string {
  if (!result.records.length)
    return `No personal ${kind === 'task' ? 'tasks' : 'reminders'} match that filter.`;
  return `Your ${kind === 'task' ? 'tasks' : 'reminders'} (this page):\n${result.records.map((record, index) => `${index + 1}. ${describe(record)} [${record.state}${record.occurrenceState ? `; ${['pending', 'preparing', 'waiting_source', 'queued'].includes(record.occurrenceState) ? 'notification' : 'last occurrence'} ${record.occurrenceState}` : ''}]`).join('\n')}${result.nextCursor ? '\nMore entries are available.' : ''}`;
}
