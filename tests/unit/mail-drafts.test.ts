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
    expiresAt: '2026-10-04T07:00:00Z',
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

test('draft proposals show every email field exactly without exposing technical connection bindings', () => {
  const value = proposal();
  const before = structuredClone(value);
  const text = mailDraftProposalText(value)!;
  assert.match(text, /Save a draft in your connected work Gmail; this does not send email\./);
  for (const [label, key] of [
    ['To', 'to'],
    ['CC', 'cc'],
    ['Subject', 'subject'],
    ['Body', 'body'],
  ])
    assert.ok(text.includes(`${label}: ${JSON.stringify(value.payload.arguments[key!])}`));
  assert.doesNotMatch(text, /connection|operation_id|11111111|22222222|business change/);
  assert.deepEqual(value, before);
  delete value.payload.arguments.to;
  delete value.payload.arguments.cc;
  assert.match(mailDraftProposalText(value)!, /To: \[\]\nCC: \[\]/);
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

test('successful draft receipts show the bound mailbox, subject and application-owned folder link', () => {
  const text = mailDraftResultText(operation())!;
  assert.match(text, /Email draft saved\. This action did not send it\./);
  assert.match(text, /Mailbox: employee@example\.com/);
  assert.match(text, /Subject: "Warehouse options"/);
  assert.match(text, /https:\/\/mail\.google\.com\/mail\/#drafts/);
  assert.match(text, /Choose employee@example\.com/);
  assert.match(text, /Drafts folder, not a specific draft/);
  assert.doesNotMatch(text, /22222222|confirm|compose=|draft_ref/);
  const replay = operation();
  replay.result!.outcome = 'replayed';
  assert.match(mailDraftResultText(replay)!, /previously saved/);
  assert.match(mailDraftResultText(replay)!, /does not check its current Gmail status/);
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
