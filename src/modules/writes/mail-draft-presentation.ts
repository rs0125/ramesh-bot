/** Readable Gmail draft previews and receipts. The application owns the outgoing link. */
import { z } from 'zod';
import type { ContextToolDefinition } from '../context-engine/context.types.js';
import { gmailWriteRecoverySchema, writeContract } from '../context-engine/write-contract.js';
import type { WriteOperation } from './write.types.js';

const draftSubject = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value));
const address = z
  .string()
  .email()
  .max(254)
  .regex(
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/,
  )
  .refine((value) => value.split('@')[0]!.length <= 64);
const draftArguments = z
  .object({
    operation_id: z.string().uuid(),
    connection_id: z.string().uuid(),
    connection_version: z.number().int().positive().max(2147483647),
    to: z.array(address).max(10).default([]),
    cc: z.array(address).max(10).default([]),
    subject: draftSubject,
    body: z
      .string()
      .min(1)
      .max(12000)
      .refine((value) => !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 20000),
  })
  .strict();

const updateArguments = draftArguments.extend({
  draft_ref: z.string().uuid(),
  expected_message_id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
});

function isMailDraft(operation: WriteOperation): boolean {
  return (
    ['create_email_draft', 'update_email_draft'].includes(operation.payload.toolName) &&
    operation.payload.sourceFamily === 'mail' &&
    operation.payload.idempotencyArgument === 'operation_id' &&
    !operation.payload.parentOperationId
  );
}

function mailArguments(operation: WriteOperation) {
  return (
    operation.payload.toolName === 'update_email_draft' ? updateArguments : draftArguments
  ).safeParse(operation.payload.arguments);
}

function readableContent(args: z.infer<typeof draftArguments>): string {
  return [
    `To: ${args.to.length ? args.to.join(', ') : 'Not added'}`,
    ...(args.cc.length ? [`CC: ${args.cc.join(', ')}`] : []),
    `Subject: ${args.subject}`,
    '',
    args.body,
  ].join('\n');
}

/** Match CE's normalization before arguments are frozen and reviewed. */
export function normalizeMailDraftArguments(
  tool: ContextToolDefinition,
  args: Record<string, unknown>,
) {
  const contract = writeContract(tool);
  if (
    !['create_email_draft', 'update_email_draft'].includes(tool.name) ||
    contract?.sourceFamily !== 'mail' ||
    contract.effect !== (tool.name === 'update_email_draft' ? 'update' : 'create') ||
    contract.idempotencyArgument !== 'operation_id'
  )
    return args;
  const schema = tool.name === 'update_email_draft' ? updateArguments : draftArguments;
  const parsed = schema.omit({ operation_id: true }).safeParse(args);
  return parsed.success ? { ...args, subject: parsed.data.subject } : args;
}
const draftReceipt = z
  .object({
    draft_ref: z.string().uuid(),
    mailbox: z.string().email().max(254),
    subject: draftSubject,
    status: z.literal('draft'),
    provider: z.literal('gmail'),
    // Optional provider navigation must not invalidate an otherwise valid save.
    // Validate it separately before rendering, never accept a model-supplied URL.
    draft_url: z.unknown().optional(),
  })
  .strict();

function verifiedDraftUrl(value: unknown, mailbox: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\p{Cc}\p{Cf}]/u.test(value))
    return undefined;
  // Check the original spelling too: URL parsing alone normalizes backslashes,
  // default ports and some malformed paths that we never need to accept here.
  if (
    !/^https:\/\/mail\.google\.com\/mail\/\?authuser=[^&#]+#drafts\?compose=[BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz]{1,512}$/.test(
      value,
    )
  )
    return undefined;
  try {
    const url = new URL(value);
    return url.searchParams.get('authuser') === mailbox ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Hide server bindings only for the complete known payload; future fields stay visible generically. */
export function mailDraftProposalText(operation: WriteOperation): string | undefined {
  if (!isMailDraft(operation) || !['DRAFT', 'PROPOSED'].includes(operation.state)) return undefined;
  const parsed = mailArguments(operation);
  if (!parsed.success || parsed.data.operation_id !== operation.operationId) return undefined;
  return [
    operation.payload.toolName === 'update_email_draft'
      ? '*Review the draft changes*'
      : '*Review this email draft*',
    'This saves to Gmail Drafts for you to review and send.',
    '',
    readableContent(parsed.data),
  ].join('\n');
}

/** Public recovery guidance uses state and allowlisted codes, never stored mail content or provider prose. */
export function mailDraftRecoveryText(
  operation: WriteOperation,
  now = Date.now(),
): string | undefined {
  if (
    !isMailDraft(operation) ||
    ![
      'APPROVED',
      'UNKNOWN',
      'DISPATCHING',
      ...(operation.payload.executionMode === 'direct_request' ? ['REJECTED'] : []),
    ].includes(operation.state) ||
    (operation.payload.executionMode !== 'direct_request' &&
      !/^[A-F0-9]{8}$/.test(operation.confirmationCode)) ||
    (operation.result && operation.result.operation_id !== operation.operationId)
  )
    return undefined;
  const code = operation.confirmationCode;
  const recovery = gmailWriteRecoverySchema.safeParse(operation.result?.recovery);
  const retry = z.string().datetime().safeParse(operation.result?.retry_at);
  const retryAt = retry.success ? Date.parse(retry.data) : undefined;
  const when = (time: number) =>
    new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(time)) + ' (IST)';
  if (operation.payload.executionMode === 'direct_request') {
    const updating = operation.payload.toolName === 'update_email_draft';
    const saved = updating ? 'these changes were saved' : 'this draft was saved';
    const unchanged = updating ? "I haven't changed the draft." : "I haven't saved the draft.";
    const repair = !recovery.success
      ? ''
      : recovery.data.action === 'finish_gmail_disconnect'
        ? ' Finish disconnecting Gmail on the connection page, then reconnect the same Google account.'
        : recovery.data.action === 'check_gmail_connection'
          ? ' Ask me to check your Gmail connection.'
          : ' Reconnect the same Google account through the Gmail connection page.';
    if (
      operation.hasUncertainAttempt ||
      operation.state === 'UNKNOWN' ||
      operation.state === 'DISPATCHING' ||
      operation.result?.outcome === 'outcome_unknown'
    ) {
      const expiresAt = Date.parse(operation.expiresAt);
      const canRetry = expiresAt > now && (retryAt === undefined || retryAt < expiresAt);
      const wait =
        retryAt !== undefined && retryAt > now
          ? ` Wait until ${when(retryAt)} before asking me to check again.`
          : '';
      return `I couldn't confirm whether ${saved}.${repair}${wait} Check Gmail Drafts before trying again. I won't create a replacement while the result is uncertain.${canRetry ? ' You can say “try that draft again” to check the same attempt.' : ' This request can no longer be retried automatically.'}`;
    }
    if (
      !(
        (operation.state === 'APPROVED' && operation.result?.outcome === 'not_dispatched') ||
        (operation.state === 'REJECTED' && operation.result?.outcome === 'rejected')
      )
    )
      return undefined;
    switch (operation.result.code) {
      case 'GMAIL_APPROVAL_EXPIRED':
        return `This request expired before it could be saved. ${unchanged} Ask me to prepare it again as a new request.`;
      case 'GMAIL_CONNECTION_CHANGED':
        return `Your Gmail connection changed. ${unchanged} Say “cancel that draft attempt”, then ask me to prepare it again with the current connection.`;
      case 'GMAIL_CONNECT_REQUIRED':
      case 'GMAIL_RECONNECT_REQUIRED':
      case 'GMAIL_AUTH_REQUIRED':
      case 'GMAIL_SCOPE_REQUIRED':
        return `${unchanged} Connect your work Gmail with draft access. Then say “cancel that draft attempt” and ask me to prepare it again. I can get you the connection link.`;
      case 'GMAIL_REVOCATION_PENDING':
        return `${unchanged} Finish disconnecting Gmail on the connection page and reconnect. Then say “cancel that draft attempt” and ask me to prepare it again.`;
      case 'GMAIL_RATE_LIMITED':
      case 'GMAIL_RETRY_LATER':
        return `Gmail is temporarily limiting requests. ${unchanged} ${retryAt !== undefined && retryAt > now ? `Say “try that draft again” after ${when(retryAt)}.` : 'Give it a little time, then say “try that draft again”.'}`;
      case 'GMAIL_UNAVAILABLE':
      case 'GMAIL_OAUTH_UNAVAILABLE':
        return `Gmail is temporarily unavailable. ${unchanged} Say “try that draft again” once it is back.`;
      case 'GMAIL_DRAFT_UPDATE_PENDING':
        return 'An earlier edit to that draft is still unresolved. Say “try that draft again” to check that attempt before making another edit.';
      case 'GMAIL_DRAFT_CHANGED':
      case 'GMAIL_DRAFT_VERSION_CHANGED':
        return "The draft changed in Gmail. I haven't overwritten it. I'll need to read the latest version before applying your edit.";
      case 'GMAIL_DRAFT_UNAVAILABLE':
      case 'GMAIL_DRAFT_NOT_EDITABLE':
        return "I couldn't edit that draft. It may have been sent, deleted or changed outside Ramesh. Check Gmail Drafts; I haven't created a replacement.";
      default:
        return undefined;
    }
  }
  // An earlier ambiguous attempt takes precedence over any later definite failure.
  if (
    operation.hasUncertainAttempt ||
    operation.state === 'UNKNOWN' ||
    operation.state === 'DISPATCHING' ||
    operation.result?.outcome === 'outcome_unknown'
  ) {
    const repair = !recovery.success
      ? ''
      : recovery.data.action === 'finish_gmail_disconnect'
        ? ' Ask me for the Gmail connection page, finish disconnecting there, then reconnect the same Google account.'
        : recovery.data.action === 'check_gmail_connection'
          ? ' Ask me to check the Gmail connection and restore access to the same Google account.'
          : ' Ask me for the Gmail connection link and reconnect the same Google account.';
    const wait =
      retryAt !== undefined && retryAt > now ? ` Wait until ${when(retryAt)} before retrying.` : '';
    const expiresAt = Date.parse(operation.expiresAt);
    if (expiresAt <= now)
      return `I cannot yet confirm whether this draft was saved.${repair} This approval has expired, so its code cannot make another draft-creation attempt. Check Gmail Drafts directly; automatic recovery of this operation is unavailable after expiry. Do not create a replacement while its outcome is uncertain.`;
    if (retryAt !== undefined && Number.isFinite(expiresAt) && retryAt >= expiresAt)
      return `I cannot yet confirm whether this draft was saved.${repair} Gmail's retry time is ${when(retryAt)}, after this approval expires at ${when(expiresAt)}. Check Gmail Drafts directly; this code cannot retry after expiry. Do not create a replacement while its outcome is uncertain.`;
    return `I cannot yet confirm whether this draft was saved.${repair}${wait} Check Gmail Drafts, then reply retry ${code} to check the same operation. Do not create a replacement while its outcome is uncertain.`;
  }
  if (operation.state !== 'APPROVED' || operation.result?.outcome !== 'not_dispatched')
    return undefined;
  switch (operation.result.code) {
    case 'GMAIL_APPROVAL_EXPIRED':
      return `This attempt did not create a draft because its approval expired. Reply cancel ${code}, then ask for a fresh reviewed draft proposal.`;
    case 'GMAIL_CONNECTION_CHANGED':
      return `This attempt did not create a draft because your Gmail connection changed. Reply cancel ${code}, then ask me to check your Gmail connection and prepare a fresh draft proposal.`;
    case 'GMAIL_CONNECT_REQUIRED':
    case 'GMAIL_RECONNECT_REQUIRED':
    case 'GMAIL_AUTH_REQUIRED':
    case 'GMAIL_SCOPE_REQUIRED':
      return `This attempt did not create a draft. Ask me for the Gmail connection link and connect your work account with draft access. After reconnecting, reply cancel ${code} and ask for a fresh draft proposal.`;
    case 'GMAIL_REVOCATION_PENDING':
      return `This attempt did not create a draft. Gmail disconnect is still pending. Ask me for the Gmail connection page and finish disconnecting there before reconnecting. Then reply cancel ${code} and ask for a fresh draft proposal.`;
    case 'GMAIL_RATE_LIMITED':
    case 'GMAIL_RETRY_LATER': {
      const expiresAt = Date.parse(operation.expiresAt);
      if (retryAt !== undefined && Number.isFinite(expiresAt)) {
        if (expiresAt <= now || retryAt >= expiresAt)
          return `This attempt did not create a draft. Gmail allows another attempt after ${when(retryAt)}, but this approval ${expiresAt <= now ? 'expired' : 'expires'} at ${when(expiresAt)}. Reply cancel ${code}, then ask for a fresh draft proposal after the wait. The old approval will not be extended.`;
        return `Gmail is temporarily limiting requests. This attempt did not create a draft. Reply retry ${code} after ${when(retryAt)} and before this approval expires at ${when(expiresAt)} to retry the same approved draft.`;
      }
      return `Gmail is temporarily limiting requests. This attempt did not create a draft. Wait before replying retry ${code} to retry the same approved draft.`;
    }
    case 'GMAIL_UNAVAILABLE':
    case 'GMAIL_OAUTH_UNAVAILABLE':
      return `Gmail is temporarily unavailable. This attempt did not create a draft. Reply retry ${code} after the service recovers to retry the same approved draft.`;
    default:
      return undefined;
  }
}

/** Fresh authenticated receipts may display the exact saved payload; history has its own access gate. */
export function mailDraftResultText(operation: WriteOperation): string | undefined {
  const updating = operation.payload.toolName === 'update_email_draft';
  if (
    !isMailDraft(operation) ||
    operation.state !== 'SUCCEEDED' ||
    operation.result?.operation_id !== operation.operationId ||
    ![updating ? 'updated' : 'created', 'replayed'].includes(operation.result.outcome)
  )
    return undefined;
  const parsed = draftReceipt.safeParse(operation.result.data);
  if (
    !parsed.success ||
    (updating && parsed.data.draft_ref !== operation.payload.arguments.draft_ref)
  )
    return 'The operation completed, but I could not verify its draft details. Read the draft again before using it.';
  const { mailbox, subject } = parsed.data;
  const draftUrl = verifiedDraftUrl(parsed.data.draft_url, mailbox);
  const replayed = operation.result.outcome === 'replayed';
  const args = mailArguments(operation);
  // A replay proves the earlier save, not the current body after possible Gmail edits.
  const content =
    !replayed &&
    args.success &&
    args.data.operation_id === operation.operationId &&
    args.data.subject === subject
      ? readableContent(args.data)
      : `Subject: ${subject}`;
  const lead = replayed
    ? `This ${updating ? 'draft edit' : 'draft'} was already saved in ${mailbox}.`
    : `${updating ? 'Draft updated' : 'Draft saved'} in ${mailbox}.`;
  const footer = [
    draftUrl
      ? 'Open this draft in Gmail to review and send when ready:'
      : 'Open it in Gmail to review and send when ready:',
    draftUrl ?? 'https://mail.google.com/mail/#drafts',
    ...(draftUrl ? ['Drafts folder: https://mail.google.com/mail/#drafts'] : []),
    ...(replayed ? ["I haven't checked for later changes in Gmail."] : []),
  ].join('\n');
  const complete = [lead, content, footer].join('\n\n');
  // Show the full short email, or metadata and the link. Never truncate the saved body.
  return complete.length <= 4800
    ? complete
    : [lead, `Subject: ${subject}`, 'The full draft is in Gmail.', footer].join('\n\n');
}
