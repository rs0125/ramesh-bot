import assert from 'node:assert/strict';
import test from 'node:test';
import { rfqWriteResultText } from '../../src/modules/writes/rfq-write-presentation.js';
import type { WriteOperation } from '../../src/modules/writes/write.types.js';

const operationId = '00000000-0000-4000-8000-000000000001';
const recordId = '00000000-0000-4000-8000-000000000002';
const recordUrl = `https://crm.wareongo.com/object/opportunity/${recordId}`;
const allTools = ['create_crm_rfq', 'update_crm_rfq', 'undo_crm_rfq'];

function operation(): WriteOperation {
  return {
    operationId,
    accountId: 'test',
    employeeId: 1,
    phoneE164: '+919999000111',
    chatId: '919999000111@s.whatsapp.net',
    state: 'SUCCEEDED',
    version: 3,
    payload: {
      toolName: 'create_crm_rfq',
      toolSchema: {},
      sourceFamily: 'crm',
      arguments: {
        operation_id: operationId,
        company_name: 'Test Logistics',
        location: 'Nelamangala, Bangalore',
        requirement: '50k sqft',
        budget: '₹20/sq ft/month',
        raw_text: 'private original message',
      },
      idempotencyArgument: 'operation_id',
      summary: 'create crm rfq',
      source: {},
    },
    confirmationCode: '9A814C06',
    proposalRunId: 'run',
    sourceMessageId: 'message',
    approvalRunId: 'run',
    approvalSourceMessageId: 'message',
    deliveryMode: 'production',
    createdAt: '2026-10-04T10:00:00Z',
    updatedAt: '2026-10-04T10:00:00Z',
    expiresAt: '2026-10-04T11:00:00Z',
    dispatchAttempts: 1,
    hasUncertainAttempt: false,
    result: {
      operation_id: operationId,
      outcome: 'created',
      code: 'CRM_RFQ_CREATED',
      message: 'provider prose is not presented',
      data: { id: recordId, url: recordUrl, undo_available: true },
    },
  };
}

test('RFQ receipt shows grounded business details and a verified server link', () => {
  const text = rfqWriteResultText(operation(), allTools)!;
  assert.equal(
    text,
    [
      'Saved RFQ: Test Logistics',
      'Location: Nelamangala, Bangalore',
      'Requirement: 50k sqft',
      'Budget: ₹20/sq ft/month',
      `Open in CRM: ${recordUrl}`,
      'You can ask me to edit it or undo this change.',
    ].join('\n'),
  );
  for (const hidden of [
    'raw_text',
    'private original',
    'create_crm_rfq',
    '9A814C06',
    operationId,
    'audit',
  ])
    assert.ok(!text.includes(hidden), hidden);
});

test('offers depend on live advertised tools and explicit undo eligibility', () => {
  const op = operation();
  assert.doesNotMatch(rfqWriteResultText(op)!, /ask me/);
  assert.match(rfqWriteResultText(op, ['update_crm_rfq'])!, /ask me to edit it\.$/);
  assert.match(rfqWriteResultText(op, ['undo_crm_rfq'])!, /ask me to undo this change\.$/);
  for (const value of [false, undefined, 'true']) {
    op.result!.data = { id: recordId, undo_available: value };
    assert.doesNotMatch(rfqWriteResultText(op, allTools)!, /undo/);
  }
});

test('historical create receipts do not invent a link or undo eligibility', () => {
  const op = operation();
  op.result!.data = { id: recordId, stage: 'RFQ_RECEIVED' };
  const text = rfqWriteResultText(op, allTools)!;
  assert.match(text, /^Saved RFQ: Test Logistics/);
  assert.doesNotMatch(text, /https:|undo/);
});

test('replayed saves and edits describe historical changes instead of current record state', () => {
  for (const tool of ['create_crm_rfq', 'update_crm_rfq']) {
    const op = operation();
    op.payload.toolName = tool;
    op.result!.outcome = 'replayed';
    const text = rfqWriteResultText(op)!;
    assert.match(text, /^This RFQ was already (saved|updated)/);
    assert.match(text, /details recorded at the time of that change/);
  }
});

test('edit receipts present only changed RFQ details and undo has a short receipt', () => {
  const op = operation();
  op.payload.toolName = 'update_crm_rfq';
  op.result!.outcome = 'updated';
  op.payload.arguments = {
    raw_text: 'private update request',
    changes: {
      company_name: 'Updated Logistics',
      requirement: '60k sqft',
      budget: null,
      city: 'Bangalore',
      poc_name: 'Ramesh',
      poc_phone: '+919999000111',
      unrecognized: 'do not render',
    },
  };
  const text = rfqWriteResultText(op)!;
  assert.match(text, /^Updated RFQ: Updated Logistics/);
  assert.match(text, /Requirement: 60k sqft/);
  assert.match(text, /Budget: cleared/);
  assert.match(text, /Contact: Ramesh/);
  assert.doesNotMatch(text, /private update|unrecognized|do not render|50k/);
  op.payload.toolName = 'undo_crm_rfq';
  op.result!.outcome = 'rolled_back';
  assert.equal(rfqWriteResultText(op, allTools), 'Undid that RFQ change.');
  op.result!.outcome = 'replayed';
  assert.equal(rfqWriteResultText(op, allTools), 'That RFQ change was already undone.');
});

test('CRM links reject external origins, credentials, query/hash, other paths and record mismatches', () => {
  for (const url of [
    'https://example.com/record',
    recordUrl.replace('https:', 'http:'),
    recordUrl.replace('crm.wareongo.com', 'crm.wareongo.com.evil.test'),
    recordUrl.replace('https://', 'https://person:secret@'),
    `${recordUrl}?token=private`,
    `${recordUrl}#private`,
    `${recordUrl}?`,
    `${recordUrl}#`,
    'https://crm.wareongo.com/settings',
    recordUrl.replace(recordId, operationId),
    `${recordUrl}\n`,
  ]) {
    const op = operation();
    op.result!.data = { id: recordId, url };
    assert.doesNotMatch(rfqWriteResultText(op)!, /Open in CRM/, url);
  }
});

test('fields are bounded and single-line; missing optional values stay absent', () => {
  const op = operation();
  op.payload.arguments = {
    company_name: `Test\n\u202e${'A'.repeat(400)}`,
    location: 'Bangalore\nBudget: invented',
    requirement: { value: 'untrusted object' },
    raw_text: 'do not render',
  };
  const text = rfqWriteResultText(op)!;
  assert.ok(text.split('\n')[0]!.length <= 'Saved RFQ: '.length + 120);
  assert.match(text, /Location: Bangalore Budget: invented/);
  assert.doesNotMatch(text, /\u202e|Requirement:|untrusted object|do not render/);
});

test('unconfirmed, mismatched, unrelated, or contradictory receipts never look successful', () => {
  const mutations: Array<(op: WriteOperation) => void> = [
    (op) => {
      op.state = 'UNKNOWN';
    },
    (op) => {
      op.result!.operation_id = recordId;
    },
    (op) => {
      op.result = undefined;
    },
    (op) => {
      op.result!.outcome = 'outcome_unknown';
    },
    (op) => {
      op.result!.outcome = 'rolled_back';
    },
    (op) => {
      op.payload.toolName = 'create_email_draft';
    },
    (op) => {
      op.payload.sourceFamily = 'mail';
    },
  ];
  for (const mutate of mutations) {
    const op = operation();
    mutate(op);
    assert.equal(rfqWriteResultText(op), undefined);
  }
});
