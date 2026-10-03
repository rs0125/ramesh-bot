/** Exact Gmail draft previews and receipts. The application owns the outgoing link. */
import { z } from 'zod';
import type { WriteOperation } from './write.types.js';

const draftSubject = z
  .string()
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
const draftReceipt = z
  .object({
    draft_ref: z.string().uuid(),
    mailbox: z.string().email().max(254),
    subject: draftSubject,
    status: z.literal('draft'),
    provider: z.literal('gmail'),
  })
  .strict();

/** Hide server bindings only for the complete known payload; future fields stay visible generically. */
export function mailDraftProposalText(operation: WriteOperation): string | undefined {
  if (
    operation.payload.toolName !== 'create_email_draft' ||
    operation.payload.sourceFamily !== 'mail' ||
    operation.payload.idempotencyArgument !== 'operation_id' ||
    operation.payload.parentOperationId ||
    !['DRAFT', 'PROPOSED'].includes(operation.state)
  )
    return undefined;
  const parsed = draftArguments.safeParse(operation.payload.arguments);
  if (!parsed.success || parsed.data.operation_id !== operation.operationId) return undefined;
  const { to, cc, subject, body } = parsed.data;
  return [
    '*Review this email draft*',
    'Save a draft in your connected work Gmail; this does not send email.',
    `To: ${JSON.stringify(to)}`,
    `CC: ${JSON.stringify(cc)}`,
    `Subject: ${JSON.stringify(subject)}`,
    `Body: ${JSON.stringify(body)}`,
  ].join('\n');
}

/** Public recovery guidance uses state and allowlisted codes, never stored mail content or provider prose. */
export function mailDraftRecoveryText(operation: WriteOperation): string | undefined {
  if (
    operation.payload.toolName !== 'create_email_draft' ||
    operation.payload.sourceFamily !== 'mail' ||
    operation.payload.idempotencyArgument !== 'operation_id' ||
    operation.payload.parentOperationId ||
    !['APPROVED', 'UNKNOWN', 'DISPATCHING'].includes(operation.state) ||
    !/^[A-F0-9]{8}$/.test(operation.confirmationCode) ||
    (operation.result && operation.result.operation_id !== operation.operationId)
  )
    return undefined;
  const code = operation.confirmationCode;
  // An earlier ambiguous attempt takes precedence over any later definite failure.
  if (
    operation.hasUncertainAttempt ||
    operation.state === 'UNKNOWN' ||
    operation.state === 'DISPATCHING' ||
    operation.result?.outcome === 'outcome_unknown'
  )
    return `I cannot yet confirm whether this draft was saved. Check Gmail Drafts, then reply retry ${code} to check the same operation. Do not create a replacement while its outcome is uncertain.`;
  if (operation.state !== 'APPROVED' || operation.result?.outcome !== 'not_dispatched')
    return undefined;
  switch (operation.result.code) {
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
    case 'GMAIL_RETRY_LATER':
      return `Gmail is temporarily limiting requests. This attempt did not create a draft. Wait before replying retry ${code} to retry the same approved draft.`;
    case 'GMAIL_UNAVAILABLE':
    case 'GMAIL_OAUTH_UNAVAILABLE':
      return `Gmail is temporarily unavailable. This attempt did not create a draft. Reply retry ${code} after the service recovers to retry the same approved draft.`;
    default:
      return undefined;
  }
}

/** Only fresh, successful create receipts enter here; historical redisclosure stays separately gated. */
export function mailDraftResultText(operation: WriteOperation): string | undefined {
  if (
    operation.payload.toolName !== 'create_email_draft' ||
    operation.payload.sourceFamily !== 'mail' ||
    operation.state !== 'SUCCEEDED' ||
    operation.payload.parentOperationId ||
    operation.result?.operation_id !== operation.operationId ||
    !['created', 'replayed'].includes(operation.result.outcome)
  )
    return undefined;
  const parsed = draftReceipt.safeParse(operation.result.data);
  if (!parsed.success)
    return 'The operation completed, but I could not verify its draft details. Read the draft again before using it.';
  const { mailbox, subject } = parsed.data;
  const replayed = operation.result.outcome === 'replayed';
  return [
    replayed
      ? 'This email draft was previously saved. This action did not send it.'
      : 'Email draft saved. This action did not send it.',
    `Mailbox: ${mailbox}`,
    `Subject: ${JSON.stringify(subject)}`,
    'Open Gmail Drafts: https://mail.google.com/mail/#drafts',
    `Choose ${mailbox} in Gmail. This opens the Drafts folder, not a specific draft.`,
    ...(replayed ? ['The saved receipt does not check its current Gmail status.'] : []),
  ].join('\n');
}
