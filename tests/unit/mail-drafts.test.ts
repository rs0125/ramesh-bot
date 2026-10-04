/** Draft metadata and presentation only: no Google, model, database, or WhatsApp calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { loadContextSigningConfig } from '../../src/infrastructure/context-engine/request-credentials.js';
import { oauthScopesSchema } from '../../src/infrastructure/context-engine/oauth-client.js';
import { admittedReadTool } from '../../src/modules/context-engine/read-contract.js';
import {
  admittedWriteTool,
  contextWriteDescriptor,
} from '../../src/modules/context-engine/write-contract.js';
import type { ContextToolDefinition } from '../../src/modules/context-engine/context.types.js';
import {
  mailDraftProposalText,
  mailDraftRecoveryText,
  mailDraftResultText,
  normalizeMailDraftArguments,
} from '../../src/modules/writes/mail-draft-presentation.js';
import type { WriteOperation } from '../../src/modules/writes/write.types.js';

const operationId = '11111111-1111-4111-8111-111111111111';
const receipt = {
  draft_ref: '22222222-2222-4222-8222-222222222222',
  mailbox: 'employee@example.com',
  subject: 'Warehouse options',
  status: 'draft',
  provider: 'gmail',
};
const object = (properties: Record<string, z.ZodType>) =>
  z.toJSONSchema(z.object(properties).strict());
const descriptor = (): ContextToolDefinition => ({
  name: 'create_email_draft',
  inputSchema: object({ operation_id: z.string().uuid(), subject: z.string().min(1).max(200) }),
  outputSchema: object({
    operation_id: z.string().uuid(),
    outcome: z.enum(['created', 'replayed', 'outcome_unknown']),
    code: z.string(),
    message: z.string(),
    meta: z
      .object({
        toolName: z.literal('create_email_draft'),
        argumentsSha256: z.string(),
        employeeId: z.number().int(),
      })
      .strict(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  _meta: {
    'wareongo/context-write-v1': {
      requiredScopes: ['mail:drafts'],
      sourceFamily: 'mail',
      effect: 'create',
      idempotencyArgument: 'operation_id',
    },
  },
});

function operation(): WriteOperation {
  return {
    operationId,
    accountId: 'synthetic',
    employeeId: 7,
    phoneE164: '+919000000007',
    chatId: '919000000007@s.whatsapp.net',
    state: 'SUCCEEDED',
    version: 4,
    payload: {
      toolName: 'create_email_draft',
      sourceFamily: 'mail',
      arguments: { operation_id: operationId, subject: receipt.subject },
      toolSchema: descriptor().inputSchema,
      idempotencyArgument: 'operation_id',
      summary: 'Prepare warehouse options email',
      source: {},
    },
    confirmationCode: 'ABCDEF12',
    proposalRunId: 'proposal',
    sourceMessageId: 'source',
    approvalRunId: 'approval',
    approvalSourceMessageId: 'confirmation',
    deliveryMode: 'production',
    createdAt: '2026-10-04T06:00:00Z',
    updatedAt: '2026-10-04T06:01:00Z',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    dispatchAttempts: 1,
    hasUncertainAttempt: false,
    result: {
      operation_id: operationId,
      outcome: 'created',
      code: 'EMAIL_DRAFT_CREATED',
      message: 'Draft created.',
      data: { ...receipt },
    },
  };
}

function proposal(): WriteOperation {
  const value = operation();
  value.state = 'PROPOSED';
  value.payload.arguments = {
    operation_id: operationId,
    connection_id: receipt.draft_ref,
    connection_version: 3,
    to: ['recipient@example.com'],
    cc: ['colleague@example.com'],
    subject: 'Warehouse "options"',
    body: 'Hi,\nPlease review these exact warehouse options.\nThanks.',
  };
  return value;
}

test('mail:drafts is an explicit signing and enrollment scope without wildcard or send grants', () => {
  const signing = {
    kid: 'synthetic',
    privateKey: { kty: 'OKP', crv: 'Ed25519', x: 'a'.repeat(43), d: 'b'.repeat(43) },
    scopes: ['crm:read', 'mail:drafts'],
  };
  assert.deepEqual(
    loadContextSigningConfig({ CONTEXT_RAMESH_SIGNING_KEY_JSON: JSON.stringify(signing) })?.scopes,
    signing.scopes,
  );
  assert.equal(oauthScopesSchema.safeParse(['mail:drafts']).success, true);
  for (const scopes of [
    ['mail:send'],
    ['other:drafts'],
    ['mail:*'],
    ['mail:drafts', 'mail:drafts'],
  ]) {
    assert.throws(() =>
      loadContextSigningConfig({
        CONTEXT_RAMESH_SIGNING_KEY_JSON: JSON.stringify({ ...signing, scopes }),
      }),
    );
    assert.equal(oauthScopesSchema.safeParse(scopes).success, false);
  }
});

test('mail reads and draft writes remain separately admitted under the explicit capability', () => {
  const write = descriptor();
  assert.equal(contextWriteDescriptor(write), true);
  assert.equal(admittedWriteTool(write, ['mail:drafts']), true);
  assert.equal(admittedWriteTool(write, ['mail:read']), false);
  assert.equal(admittedReadTool(write, ['mail:drafts']), false);
  for (const name of ['get_email_connection', 'read_email_draft']) {
    const read: ContextToolDefinition = {
      name,
      inputSchema: object({}),
      outputSchema: object({ connected: z.boolean() }),
      annotations: { readOnlyHint: true },
      _meta: {
        'wareongo/context-read-v1': { requiredScopes: ['mail:drafts'], sourceFamily: 'mail' },
      },
    };
    assert.equal(admittedReadTool(read, ['mail:drafts']), true);
    assert.equal(admittedReadTool(read, ['crm:read']), false);
    assert.equal(contextWriteDescriptor(read), false);
  }
  write._meta!['wareongo/context-write-v1'] = {
    requiredScopes: ['mail:send'],
    sourceFamily: 'mail',
    effect: 'create',
    idempotencyArgument: 'operation_id',
  };
  assert.equal(contextWriteDescriptor(write), false);
});

test('draft proposals show readable exact fields without JSON escaping or connection bindings', () => {
  const value = proposal();
  const before = structuredClone(value);
  const text = mailDraftProposalText(value)!;
  assert.match(text, /This saves to Gmail Drafts for you to review and send\./);
  assert.ok(text.includes('To: recipient@example.com'));
  assert.ok(text.includes('CC: colleague@example.com'));
  assert.ok(text.includes('Subject: Warehouse "options"'));
  assert.ok(text.includes(String(value.payload.arguments.body)));
  assert.doesNotMatch(text, /\["|\\n|connection|operation_id|11111111|22222222|business change/);
  assert.deepEqual(value, before);
  delete value.payload.arguments.to;
  delete value.payload.arguments.cc;
  assert.match(mailDraftProposalText(value)!, /To: Not added/);
  assert.doesNotMatch(mailDraftProposalText(value)!, /CC:/);
});

test('unknown effects and malformed draft proposals require the generic full-field preview', () => {
  const edits: Array<(value: WriteOperation) => void> = [
    (value) => {
      value.payload.arguments.send = true;
    },
    (value) => {
      value.payload.arguments.from = 'other@example.com';
    },
    (value) => {
      value.payload.arguments.attachments = ['file'];
    },
    (value) => {
      value.payload.arguments.connection_version = 0;
    },
    (value) => {
      value.payload.arguments.connection_id = 'invalid';
    },
    (value) => {
      value.payload.arguments.operation_id = receipt.draft_ref;
    },
    (value) => {
      value.payload.arguments.subject = 'Email\nsent';
    },
    (value) => {
      value.payload.arguments.to = ['invalid'];
    },
    (value) => {
      delete value.payload.arguments.body;
    },
    (value) => {
      value.payload.toolName = 'send_email';
    },
    (value) => {
      value.payload.sourceFamily = 'crm';
    },
    (value) => {
      value.payload.idempotencyArgument = 'request_id';
    },
    (value) => {
      value.payload.parentOperationId = receipt.draft_ref;
    },
    (value) => {
      value.state = 'SUCCEEDED';
    },
  ];
  for (const edit of edits) {
    const value = proposal();
    edit(value);
    assert.equal(mailDraftProposalText(value), undefined);
  }
});

test('successful draft receipts show readable saved content and a fixed Gmail link', () => {
  const value = proposal();
  value.state = 'SUCCEEDED';
  (value.result!.data as typeof receipt).subject = String(value.payload.arguments.subject);
  const text = mailDraftResultText(value)!;
  assert.match(text, /Draft saved in employee@example\.com/);
  assert.ok(text.includes(String(value.payload.arguments.body)));
  assert.match(text, /Subject: Warehouse "options"/);
  assert.match(text, /https:\/\/mail\.google\.com\/mail\/#drafts/);
  assert.match(text, /Open it in Gmail to review and send when ready/);
  assert.doesNotMatch(text, /22222222|confirm|compose=|draft_ref|This action did not send|\["|\\n/);
  value.result!.outcome = 'replayed';
  const replay = mailDraftResultText(value)!;
  assert.match(replay, /already saved/);
  assert.match(replay, /haven't checked for later changes/);
  assert.doesNotMatch(replay, /these exact warehouse options|To:/);
});

test('updated draft receipts preserve the existing reference and show edited content', () => {
  const value = proposal();
  value.payload.toolName = 'update_email_draft';
  value.payload.arguments.draft_ref = receipt.draft_ref;
  value.payload.arguments.expected_message_id = 'providerMessage42';
  value.payload.arguments.body = 'Hi,\nThe meeting is now at 8 pm IST.\nThanks.';
  value.payload.arguments.subject = receipt.subject;
  assert.match(mailDraftProposalText(value)!, /Review the draft changes/);
  value.state = 'SUCCEEDED';
  value.result!.outcome = 'updated';
  const text = mailDraftResultText(value)!;
  assert.match(text, /Draft updated in employee@example/);
  assert.match(text, /now at 8 pm IST/);
  assert.doesNotMatch(text, /providerMessage42|expected_message_id|22222222|confirm/);
  value.result!.outcome = 'replayed';
  assert.match(mailDraftResultText(value)!, /draft edit was already saved/);
  (value.result!.data as typeof receipt).draft_ref = operationId;
  assert.match(mailDraftResultText(value)!, /could not verify its draft details/);
  value.result!.outcome = 'created';
  assert.equal(mailDraftResultText(value), undefined, 'an edit cannot accept a creation receipt');
});

test('long saved drafts use the full Gmail content without changing or clipping the saved body', () => {
  const value = proposal();
  value.state = 'SUCCEEDED';
  value.payload.arguments.subject = receipt.subject;
  value.payload.arguments.body = 'A long email sentence. '.repeat(400);
  const before = structuredClone(value);
  const text = mailDraftResultText(value)!;
  assert.match(text, /The full draft is in Gmail/);
  assert.match(text, /review and send when ready/);
  assert.doesNotMatch(text, /A long email sentence/);
  assert.ok(text.length < 4800);
  assert.deepEqual(value, before);
});

test('mail recovery exposes only allowlisted actions without redisclosing stored email or provider prose', () => {
  const cases = [
    ['GMAIL_CONNECTION_CHANGED', /connection changed.*cancel ABCDEF12.*fresh draft proposal/s],
    ['GMAIL_CONNECT_REQUIRED', /Gmail connection link.*cancel ABCDEF12.*fresh draft proposal/s],
    ['GMAIL_RECONNECT_REQUIRED', /Gmail connection link.*draft access/s],
    ['GMAIL_AUTH_REQUIRED', /Gmail connection link/],
    ['GMAIL_SCOPE_REQUIRED', /draft access/],
    [
      'GMAIL_REVOCATION_PENDING',
      /finish disconnecting there before reconnecting.*cancel ABCDEF12/s,
    ],
    ['GMAIL_RATE_LIMITED', /Wait before replying retry ABCDEF12.*same approved draft/],
    ['GMAIL_RETRY_LATER', /Wait before replying retry ABCDEF12/],
    ['GMAIL_UNAVAILABLE', /retry ABCDEF12 after the service recovers/],
    ['GMAIL_OAUTH_UNAVAILABLE', /retry ABCDEF12 after the service recovers/],
  ] as const;
  for (const [code, expected] of cases) {
    const value = operation();
    value.state = 'APPROVED';
    value.result!.outcome = 'not_dispatched';
    value.result!.code = code;
    value.result!.message = 'PRIVATE_PROVIDER_MESSAGE https://untrusted.example';
    const text = mailDraftRecoveryText(value)!;
    assert.match(text, expected);
    assert.match(text, /This attempt did not create a draft/);
    assert.doesNotMatch(
      text,
      /employee@example|Warehouse options|PRIVATE_PROVIDER_MESSAGE|https:|11111111|22222222/,
    );
  }
});

test('earlier uncertainty always forbids replacing a mail draft despite a later definite failure', () => {
  for (const code of [
    'GMAIL_CONNECTION_CHANGED',
    'GMAIL_RECONNECT_REQUIRED',
    'GMAIL_REVOCATION_PENDING',
    'GMAIL_RATE_LIMITED',
  ]) {
    const value = operation();
    value.state = 'UNKNOWN';
    value.hasUncertainAttempt = true;
    value.result!.outcome = 'not_dispatched';
    value.result!.code = code;
    const text = mailDraftRecoveryText(value)!;
    assert.match(text, /retry ABCDEF12 to check the same operation/);
    assert.match(text, /Do not create a replacement/);
    assert.doesNotMatch(
      text,
      /did not create|cancel ABCDEF12|fresh draft proposal|employee@example|Warehouse options/,
    );
  }
  const unknown = operation();
  unknown.state = 'APPROVED';
  unknown.result!.outcome = 'outcome_unknown';
  assert.match(mailDraftRecoveryText(unknown)!, /Do not create a replacement/);
  unknown.state = 'DISPATCHING';
  delete unknown.result;
  assert.match(mailDraftRecoveryText(unknown)!, /cannot yet confirm/);
});

test('uncertain mail recovery keeps the operation while exposing only structured connection repair actions', () => {
  for (const action of [
    'connect_gmail',
    'reconnect_gmail',
    'finish_gmail_disconnect',
    'check_gmail_connection',
  ] as const) {
    const value = operation();
    value.state = 'UNKNOWN';
    value.hasUncertainAttempt = true;
    value.result = {
      operation_id: operationId,
      outcome: 'outcome_unknown',
      code: 'GMAIL_OUTCOME_UNKNOWN',
      message: 'PRIVATE_PROVIDER_MESSAGE',
      recovery: { action },
    };
    const text = mailDraftRecoveryText(value)!;
    assert.match(text, /same Google account/);
    assert.match(text, /retry ABCDEF12 to check the same operation/);
    assert.match(text, /Do not create a replacement/);
    if (action === 'finish_gmail_disconnect') assert.match(text, /finish disconnecting/);
    assert.doesNotMatch(
      text,
      /did not create|cancel ABCDEF12|fresh draft|PRIVATE_PROVIDER|employee@example/,
    );
    Object.assign(value.result.recovery!, {
      url: 'https://untrusted.example',
      action: 'send_email',
    });
    assert.doesNotMatch(mailDraftRecoveryText(value)!, /untrusted|send_email|connection link/);
  }
});

test('retry deadlines show IST timing and never extend expired or insufficient approval windows', () => {
  const now = Date.parse('2026-10-04T06:00:00Z');
  const value = operation();
  value.state = 'APPROVED';
  value.expiresAt = new Date(now + 3600000).toISOString();
  value.result = {
    operation_id: operationId,
    outcome: 'not_dispatched',
    code: 'GMAIL_RATE_LIMITED',
    message: 'PRIVATE_PROVIDER_DELAY',
    retry_at: new Date(now + 7200000).toISOString(),
  };
  const original = structuredClone(value);
  const tooLate = mailDraftRecoveryText(value, now)!;
  assert.match(tooLate, /approval expires.*IST/);
  assert.match(tooLate, /cancel ABCDEF12.*fresh draft proposal after the wait/);
  assert.match(tooLate, /will not be extended/);
  assert.doesNotMatch(tooLate, /retry ABCDEF12|PRIVATE_PROVIDER/);
  assert.deepEqual(value, original);
  value.state = 'UNKNOWN';
  value.hasUncertainAttempt = true;
  const uncertain = mailDraftRecoveryText(value, now)!;
  assert.match(uncertain, /after this approval expires.*Check Gmail Drafts directly/s);
  assert.match(uncertain, /Do not create a replacement/);
  assert.doesNotMatch(uncertain, /retry ABCDEF12|cancel ABCDEF12|fresh draft|did not create/);
  value.state = 'APPROVED';
  value.hasUncertainAttempt = false;
  value.result.retry_at = new Date(now + 60000).toISOString();
  assert.match(
    mailDraftRecoveryText(value, now)!,
    /retry ABCDEF12 after .*IST.*before this approval expires.*same approved draft/,
  );
  assert.match(mailDraftRecoveryText(value, now + 3600001)!, /approval expired/);
  value.result.retry_at = 'not-a-date';
  assert.match(mailDraftRecoveryText(value, now)!, /Wait before replying retry/);
});

test('expired uncertain mail approval stays unresolved and cannot invite another write attempt', () => {
  const now = Date.now();
  for (const state of ['UNKNOWN', 'DISPATCHING'] as const) {
    const value = operation();
    value.state = state;
    value.hasUncertainAttempt = true;
    value.expiresAt = new Date(now - 1000).toISOString();
    value.result = {
      operation_id: operationId,
      outcome: 'not_dispatched',
      code: 'GMAIL_APPROVAL_EXPIRED',
      message: 'PRIVATE_PROVIDER_MESSAGE',
      recovery: { action: 'reconnect_gmail' },
    };
    const text = mailDraftRecoveryText(value, now)!;
    assert.match(text, /approval has expired.*automatic recovery.*unavailable after expiry/);
    assert.match(text, /same Google account/);
    assert.match(text, /Do not create a replacement/);
    assert.doesNotMatch(
      text,
      /retry ABCDEF12|cancel ABCDEF12|did not create|fresh draft|PRIVATE_PROVIDER/,
    );
  }
});

test('mail subject normalization changes only a fully known create payload before freezing', () => {
  const tool = descriptor(),
    value = proposal();
  const { operation_id: _operation, ...args } = value.payload.arguments;
  args.subject = '  Approved subject  ';
  const normalized = normalizeMailDraftArguments(tool, args);
  assert.equal(normalized.subject, 'Approved subject');
  assert.equal(args.subject, '  Approved subject  ');
  value.payload.arguments = { ...normalized, operation_id: operationId };
  assert.match(mailDraftProposalText(value)!, /Subject: Approved subject/);
  const future = { ...args, attachments: ['unknown effect'] };
  assert.equal(normalizeMailDraftArguments(tool, future), future);
  assert.equal(normalizeMailDraftArguments({ ...tool, name: 'send_email' }, args), args);
});

test('unknown codes, unrelated operations, mismatched receipts and terminal states retain generic recovery', () => {
  const edits: Array<(value: WriteOperation) => void> = [
    (value) => {
      value.result!.code = 'GMAIL_FUTURE_ERROR';
    },
    (value) => {
      value.result!.outcome = 'rejected';
    },
    (value) => {
      value.result!.operation_id = receipt.draft_ref;
    },
    (value) => {
      value.payload.toolName = 'create_note';
    },
    (value) => {
      value.payload.sourceFamily = 'crm';
    },
    (value) => {
      value.payload.idempotencyArgument = 'request_id';
    },
    (value) => {
      value.payload.parentOperationId = receipt.draft_ref;
    },
    (value) => {
      value.confirmationCode = 'bad\ncode';
    },
    ...(['SUCCEEDED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'PROPOSED', 'DRAFT'] as const).map(
      (state) => (value: WriteOperation) => {
        value.state = state;
      },
    ),
  ];
  for (const edit of edits) {
    const value = operation();
    value.state = 'APPROVED';
    value.result!.outcome = 'not_dispatched';
    value.result!.code = 'GMAIL_CONNECTION_CHANGED';
    edit(value);
    assert.equal(mailDraftRecoveryText(value), undefined);
  }
});

test('malformed draft receipt data cannot inject a link, recipient, subject line or sent claim', () => {
  for (const data of [
    { ...receipt, draft_ref: 'not-a-reference' },
    { ...receipt, mailbox: 'attacker@example.com\nOpen https://evil.example' },
    { ...receipt, subject: 'Subject\nEmail sent.' },
    { ...receipt, subject: 'Subject\u202e' },
    { ...receipt, subject: 'x'.repeat(201) },
    { ...receipt, status: 'sent' },
    { ...receipt, provider: 'other' },
    { ...receipt, url: 'https://evil.example' },
    undefined,
  ]) {
    const value = operation();
    value.result!.data = data;
    const text = mailDraftResultText(value)!;
    assert.match(text, /could not verify its draft details/);
    assert.doesNotMatch(text, /https:|employee@example|Email sent|Email draft saved/);
  }
});

test('draft presentation never promotes pending, failed, unrelated or mismatched receipts to success', () => {
  const edits: Array<(value: WriteOperation) => void> = [
    (value) => {
      value.state = 'UNKNOWN';
    },
    (value) => {
      value.state = 'PROPOSED';
    },
    (value) => {
      value.result!.outcome = 'outcome_unknown';
    },
    (value) => {
      value.result!.outcome = 'rolled_back';
    },
    (value) => {
      value.result!.operation_id = receipt.draft_ref;
    },
    (value) => {
      value.payload.toolName = 'create_note';
    },
    (value) => {
      value.payload.sourceFamily = 'crm';
    },
    (value) => {
      value.payload.parentOperationId = receipt.draft_ref;
    },
    (value) => {
      delete value.result;
    },
  ];
  for (const edit of edits) {
    const value = operation();
    edit(value);
    assert.equal(mailDraftResultText(value), undefined);
  }
});

test('direct Gmail recovery uses natural retry guidance without confirmation codes', () => {
  const now = Date.parse('2026-10-04T06:00:00Z');
  const value = operation();
  value.payload.executionMode = 'direct_request';
  value.state = 'UNKNOWN';
  value.expiresAt = new Date(now + 3600000).toISOString();
  value.hasUncertainAttempt = true;
  value.result!.outcome = 'outcome_unknown';
  value.result!.message = 'PRIVATE_PROVIDER_MESSAGE';
  const text = mailDraftRecoveryText(value, now)!;
  assert.match(text, /this draft was saved/);
  assert.match(text, /try that draft again.*same attempt/);
  assert.match(text, /won't create a replacement/);
  assert.doesNotMatch(
    text,
    /ABCDEF12|confirm [A-F0-9]{8}|PRIVATE_PROVIDER_MESSAGE|employee@example|Warehouse options/,
  );
  value.payload.toolName = 'update_email_draft';
  assert.match(mailDraftRecoveryText(value, now)!, /these changes were saved/);
  value.expiresAt = new Date(now - 1).toISOString();
  const expired = mailDraftRecoveryText(value, now)!;
  assert.match(expired, /no longer be retried automatically/);
  assert.doesNotMatch(expired, /try that draft again/);
});

test('direct definite errors avoid code loops and never overwrite or replace an unavailable edit', () => {
  const value = operation();
  value.payload.executionMode = 'direct_request';
  value.payload.toolName = 'update_email_draft';
  value.state = 'APPROVED';
  value.result!.outcome = 'not_dispatched';
  for (const code of [
    'GMAIL_CONNECTION_CHANGED',
    'GMAIL_RECONNECT_REQUIRED',
    'GMAIL_REVOCATION_PENDING',
    'GMAIL_RATE_LIMITED',
    'GMAIL_UNAVAILABLE',
  ]) {
    value.result!.code = code;
    const text = mailDraftRecoveryText(value)!;
    assert.match(text, /haven't changed the draft/);
    assert.doesNotMatch(text, /ABCDEF12|confirm|proposal|employee@example|Warehouse options/);
  }
  value.state = 'REJECTED';
  value.result!.outcome = 'rejected';
  value.result!.code = 'GMAIL_DRAFT_CHANGED';
  assert.match(mailDraftRecoveryText(value)!, /haven't overwritten it/);
  value.result!.code = 'GMAIL_DRAFT_UNAVAILABLE';
  assert.match(mailDraftRecoveryText(value)!, /haven't created a replacement/);
  value.result!.code = 'GMAIL_DRAFT_UPDATE_PENDING';
  assert.match(
    mailDraftRecoveryText(value)!,
    /earlier edit.*try that draft again.*before making another edit/,
  );
  value.hasUncertainAttempt = true;
  assert.match(mailDraftRecoveryText(value)!, /couldn't confirm/);
  assert.doesNotMatch(
    mailDraftRecoveryText(value)!,
    /haven't changed|haven't overwritten|couldn't edit/,
  );
});

test('a fully validated update normalizes subject but never hides unknown edit fields', () => {
  const value = proposal();
  value.payload.toolName = 'update_email_draft';
  value.payload.arguments.draft_ref = receipt.draft_ref;
  value.payload.arguments.expected_message_id = 'currentMessage';
  const tool = descriptor();
  tool.name = 'update_email_draft';
  (tool._meta!['wareongo/context-write-v1'] as { effect: string }).effect = 'update';
  const { operation_id: _operation, ...args } = value.payload.arguments;
  args.subject = '  Edited subject  ';
  const normalized = normalizeMailDraftArguments(tool, args);
  assert.equal(normalized.subject, 'Edited subject');
  value.payload.arguments = { ...normalized, operation_id: operationId };
  assert.match(mailDraftProposalText(value)!, /Subject: Edited subject/);
  value.payload.arguments.expected_message_id = 'bad\nversion';
  assert.equal(mailDraftProposalText(value), undefined);
});
