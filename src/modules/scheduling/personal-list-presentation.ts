/** Personal-domain validation and completion policy, separate from reusable list layout. */
import { z } from 'zod';
import type { TrustedReplyContext } from '../greetings/greeting.types.js';
import {
  ToolPresentationRegistry,
  type PresentationAdapter,
} from '../presentation/tool-presentation.js';
import { personalListDocument } from './personal-presentation.js';
import { validateTaskDeadline } from './schedule-time.js';

// Shared with the executor's advertised schema: the shortcut must interpret exactly
// the same arguments as the actual read, including defaults and continuation semantics.
export const personalListArgumentsSchema = z
  .object({
    kind: z.enum(['task', 'reminder']),
    state: z.enum(['open', 'done', 'cancelled', 'scheduled', 'completed', 'all']).optional(),
    limit: z.number().int().min(1).max(10).optional(),
    cursor: z.string().min(1).max(300).optional(),
    continuation: z.literal('latest').optional(),
  })
  .strict()
  .refine((value) => !(value.cursor && value.continuation), 'Use cursor or continuation, not both');

const id = z.string().min(1).max(200);
const instant = z.iso.datetime({ offset: true });
const recurrence = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    dayOfMonth: z.union([z.number().int().min(1).max(31), z.literal('last')]).optional(),
    until: instant.optional(),
  })
  .strict()
  .refine((rule) =>
    rule.frequency === 'weekly'
      ? !!rule.weekdays && !rule.dayOfMonth
      : rule.frequency === 'monthly'
        ? !!rule.dayOfMonth && !rule.weekdays
        : !rule.weekdays && !rule.dayOfMonth,
  );
const deadline = z.discriminatedUnion('precision', [
  z
    .object({
      precision: z.literal('date'),
      localDate: z.string(),
      timezone: z.literal('Asia/Kolkata'),
    })
    .strict(),
  z
    .object({ precision: z.literal('instant'), at: instant, timezone: z.literal('Asia/Kolkata') })
    .strict(),
]);
const record = z
  .object({
    kind: z.enum(['task', 'reminder']),
    id,
    version: z.number().int().positive(),
    text: z
      .string()
      .min(1)
      .max(2000)
      .refine((text) => !!text.trim()),
    state: z.enum(['open', 'done', 'cancelled', 'scheduled', 'completed']),
    createdAt: instant,
    updatedAt: instant,
    deadline: deadline.optional(),
    schedule: z
      .object({
        dueAt: instant,
        timezone: z.literal('Asia/Kolkata'),
        recurrence: recurrence.optional(),
      })
      .strict()
      .optional(),
    nextDueAt: instant.nullable().optional(),
    lastOutcome: z
      .string()
      .regex(/^[a-z_]{1,80}$/)
      .optional(),
    taskId: id.optional(),
    occurrenceId: id.optional(),
    occurrenceState: z
      .string()
      .regex(/^[a-z_]{1,80}$/)
      .optional(),
    occurrenceDueAt: instant.optional(),
    occurrenceAcknowledgedAt: instant.optional(),
    alreadySending: z.boolean().optional(),
    affectedReminders: z.number().int().nonnegative().optional(),
  })
  .strict();
const resultSchema = z
  .object({
    ok: z.literal(true),
    kind: z.enum(['task', 'reminder']),
    records: z.array(record).max(50),
    selectionId: id,
    nextCursor: z.string().min(1).max(300).nullable(),
  })
  .strict();

export const personalListAdapter: PresentationAdapter = {
  id: 'personal-list-v1',
  owner: 'personal',
  tool: 'personal_list',
  renderer: 'list-v1',
  adapt(argumentsValue, result) {
    const args = personalListArgumentsSchema.safeParse(argumentsValue);
    const parsed = resultSchema.safeParse(result);
    if (!args.success || !parsed.success || args.data.kind !== parsed.data.kind) return undefined;
    const { kind, state } = args.data;
    const states =
      kind === 'task' ? ['open', 'done', 'cancelled'] : ['scheduled', 'completed', 'cancelled'];
    if (state && state !== 'all' && !states.includes(state)) return undefined;
    const expectedState =
      state ?? (args.data.cursor || args.data.continuation ? undefined : states[0]);
    const data = parsed.data;
    if (new Set(data.records.map((item) => item.id)).size !== data.records.length) return undefined;
    for (const item of data.records) {
      if (
        item.kind !== kind ||
        !states.includes(item.state) ||
        (expectedState && expectedState !== 'all' && item.state !== expectedState) ||
        (kind === 'reminder' ? !item.schedule || !!item.deadline : !!item.schedule)
      )
        return undefined;
      // The renderer formats dates rather than validating calendars. Do that here,
      // including date-only deadlines, before a presentation can replace model review.
      if (item.deadline) {
        try {
          validateTaskDeadline(item.deadline);
        } catch {
          return undefined;
        }
      }
    }
    return personalListDocument(kind, data);
  },
};

export const personalPresentations = new ToolPresentationRegistry([personalListAdapter]);

/**
 * Shared wording for a default list request. The mutation guard must recognize
 * every phrase accepted by the completion proof, even if the worker chooses a
 * write and the reviewer approves it by mistake. This recognizes intent only;
 * trusted-source checks and the executed-result proof still belong to callers.
 */
export function defaultPersonalListKind(input: string): 'task' | 'reminder' | undefined {
  const text = input.trim().replace(/\s+/g, ' ');
  const match =
    /^(?:please[, ]+)?(?:(?:(?:can|could|would) you )?(?:show|list|display|view)(?: me)? (?:my |my personal |personal )?|(?:what are|what's|what is) my )(tasks|reminders)(?: list)?(?: please)?[.!?]*$/i.exec(
      text,
    );
  return match?.[1]?.toLowerCase() === 'tasks' ? 'task' : match ? 'reminder' : undefined;
}

/**
 * A narrow whole-request proof, NOT routing or permission to execute a tool. Keep
 * Luna routing and Sol's initial tool choice; compare their executed read against
 * this original server-bound instruction afterwards. An unrecognized phrase uses
 * the ordinary graph; it is not rejected or turned into a clarification by this code.
 *
 * Explicit filters, "all", multiple lists, continuation, quoted/forwarded commands,
 * media, bursts and extra clauses are intentionally outside this first proof. A
 * future tool needs its own coverage rule, not just presentation metadata.
 */
export function simplePersonalListKind(
  input: string,
  trusted: TrustedReplyContext,
): 'task' | 'reminder' | undefined {
  const members = trusted.commandMessages;
  const member = members?.[0];
  if (
    members?.length !== 1 ||
    !member ||
    member.forwarded ||
    member.quotedMessageId ||
    member.hasQuotedMessage ||
    trusted.mediaContext ||
    trusted.locationMessages?.length ||
    member.text.trim() !== input.trim()
  )
    return undefined;
  return defaultPersonalListKind(input);
}
