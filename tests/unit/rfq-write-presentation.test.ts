import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rfqWriteRecoveryText,
  rfqWriteResultText,
} from '../../src/modules/writes/rfq-write-presentation.js';
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
      data: { id: recordId, name: 'Test Logistics', url: recordUrl, undo_available: true },
    },
  };
}

test('RFQ receipt shows the authoritative title, full-brief confirmation and verified server link', () => {
  const text = rfqWriteResultText(operation(), allTools)!;
  assert.equal(
    text,
    [
      'Saved RFQ: Test Logistics',
      'Full brief saved in the description.',
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

test('direct RFQ validation failures name only public fields and give a conversational next step', () => {
  const op = operation();
  op.payload.executionMode = 'direct_request';
  op.state = 'APPROVED';
  op.result = {
    operation_id: op.operationId,
    outcome: 'not_dispatched',
    code: 'CRM_RFQ_INCOMPLETE',
    message:
      'Please supply or correct: poc_phone (unambiguous Indian number). PRIVATE_PROVIDER_BODY',
  };
  const text = rfqWriteRecoveryText(op, Date.parse(op.createdAt))!;
  assert.match(text, /Nothing was sent to CRM/);
  assert.match(text, /contact number needs checking/);
  assert.match(text, /cancel that RFQ attempt/);
  assert.match(text, /don’t need to repeat the full brief/);
  assert.doesNotMatch(text, /CRM_RFQ|poc_phone|PRIVATE_|9A814C06|private original|Test Logistics/);
  op.payload.executionMode = 'confirmation';
  assert.equal(rfqWriteRecoveryText(op, Date.parse(op.createdAt)), undefined);
});

test('uncertainty takes priority over a later unsent result, while verified success wins over old uncertainty', () => {
  const op = operation();
  op.payload.executionMode = 'direct_request';
  op.state = 'UNKNOWN';
  op.hasUncertainAttempt = true;
  op.result = {
    operation_id: op.operationId,
    outcome: 'not_dispatched',
    code: 'CRM_RFQ_INCOMPLETE',
    message: 'PRIVATE_BODY',
  };
  const text = rfqWriteRecoveryText(op, Date.parse(op.createdAt))!;
  assert.match(text, /may or may not be there/);
  assert.match(text, /Say “retry”/);
  assert.doesNotMatch(
    text,
    /Nothing was sent|cancel|PRIVATE_|Test Logistics|9A814C06|submitting again/,
  );
  op.dispatchAttempts = 2;
  const retried = rfqWriteRecoveryText(op, Date.parse(op.createdAt))!;
  assert.match(retried, /still can’t confirm/);
  assert.match(retried, /administrator to look for it in CRM first/);
  assert.doesNotMatch(retried, /Say “retry”|Nothing was sent|cancel|PRIVATE_|Test Logistics/);
  assert.doesNotMatch(retried, /submitting again|resubmit|new submission/);
  op.dispatchAttempts = 1;
  const expired = rfqWriteRecoveryText(op, Date.parse(op.expiresAt) + 1)!;
  assert.match(expired, /administrator/);
  assert.doesNotMatch(expired, /Say “retry”|submitting again|resubmit|new submission/);
  op.state = 'SUCCEEDED';
  op.result = {
    operation_id: op.operationId,
    outcome: 'replayed',
    code: 'OK',
    message: 'Historical success',
  };
  assert.equal(rfqWriteRecoveryText(op, Date.parse(op.createdAt)), undefined);
  assert.match(rfqWriteResultText(op)!, /^This RFQ was already saved/);
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
  assert.match(text, /^Saved RFQ\./);
  assert.doesNotMatch(text, /https:|undo|Test Logistics|50k sqft/);
});

test('replayed saves and edits describe historical changes instead of current record state', () => {
  for (const tool of ['create_crm_rfq', 'update_crm_rfq']) {
    const op = operation();
    op.payload.toolName = tool;
    op.result!.outcome = 'replayed';
    const text = rfqWriteResultText(op)!;
    assert.match(text, /^This RFQ was already (saved|updated)/);
    if (tool === 'update_crm_rfq')
      assert.match(text, /details recorded at the time of that change/);
    else assert.doesNotMatch(text, /Location:|Requirement:|Budget:|Full brief saved/);
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
  assert.doesNotMatch(text, /private update|unrecognized|do not render|50k|Full brief saved/);
  op.payload.toolName = 'undo_crm_rfq';
  op.result!.outcome = 'rolled_back';
  assert.equal(rfqWriteResultText(op, allTools), 'Undid that RFQ change.');
  op.result!.outcome = 'replayed';
  assert.equal(rfqWriteResultText(op, allTools), 'That RFQ change was already undone.');
});

test('edit receipts cover every supported changed field using readable labels', () => {
  const op = operation();
  op.payload.toolName = 'update_crm_rfq';
  op.result!.outcome = 'updated';
  op.payload.arguments = {
    changes: {
      title: 'Updated Logistics - 60k sqft - Devanahalli',
      company_name: 'Updated Logistics',
      requirement: '60k sqft',
      budget: null,
      city: 'Bangalore',
      micro_market: 'Devanahalli',
      poc_name: 'Ramesh',
      poc_phone: '+919999000111',
      lead_source: 'WHATSAPP_INBOUND',
      lease_duration: 'LONG_TERM',
      repeat_client: false,
    },
  };
  op.result!.data = { id: recordId, name: 'Updated Logistics', description_unchanged: true };
  assert.equal(
    rfqWriteResultText(op),
    [
      'Updated RFQ: Updated Logistics',
      'Title: Updated Logistics - 60k sqft - Devanahalli',
      'Company: Updated Logistics',
      'Requirement: 60k sqft',
      'Budget: cleared',
      'City: Bangalore',
      'Locality: Devanahalli',
      'Contact: Ramesh',
      'Phone: +919999000111',
      'Lead source: WhatsApp inbound',
      'Lease duration: Long term',
      'Repeat client: No',
      'This edit left the description unchanged.',
    ].join('\n'),
  );
});

test('edit receipts distinguish repeat-client Yes, No, clearing and omission', () => {
  for (const [value, expected] of [
    [true, 'Yes'],
    [false, 'No'],
    [null, 'cleared'],
  ] as const) {
    const op = operation();
    op.payload.toolName = 'update_crm_rfq';
    op.result!.outcome = 'updated';
    op.payload.arguments = { changes: { repeat_client: value } };
    assert.ok(rfqWriteResultText(op)!.split('\n').includes(`Repeat client: ${expected}`));
  }
  for (const changes of [
    { budget: 'TBD' },
    { repeat_client: undefined },
    { repeat_client: 'false' },
  ]) {
    const op = operation();
    op.payload.toolName = 'update_crm_rfq';
    op.result!.outcome = 'updated';
    op.payload.arguments = { changes };
    assert.doesNotMatch(rfqWriteResultText(op)!, /Repeat client:/);
  }
});

test('all nullable RFQ detail clears are acknowledged without inventing unchanged fields', () => {
  const op = operation();
  op.payload.toolName = 'update_crm_rfq';
  op.result!.outcome = 'updated';
  op.payload.arguments = {
    changes: {
      title: 'RFQ',
      company_name: null,
      city: null,
      micro_market: null,
      budget: null,
      poc_name: null,
      poc_phone: null,
      lead_source: null,
      lease_duration: null,
      repeat_client: null,
    },
  };
  const text = rfqWriteResultText(op)!;
  for (const label of [
    'Company',
    'City',
    'Locality',
    'Budget',
    'Contact',
    'Phone',
    'Lead source',
    'Lease duration',
    'Repeat client',
  ])
    assert.ok(text.split('\n').includes(`${label}: cleared`), label);
  assert.doesNotMatch(text, /Requirement:|Location:|description unchanged/);
});

test('description preservation is stated only from the current authenticated comparison', () => {
  for (const comparison of [true, false, undefined, 'true']) {
    const op = operation();
    op.payload.toolName = 'update_crm_rfq';
    op.result!.outcome = 'updated';
    op.payload.arguments = { changes: { budget: null } };
    op.result!.data = { id: recordId, description_unchanged: comparison };
    const text = rfqWriteResultText(op)!;
    if (comparison === true) assert.match(text, /This edit left the description unchanged/);
    else if (comparison === false) assert.match(text, /description differs from before this edit/);
    else assert.doesNotMatch(text, /description/);
    assert.doesNotMatch(text, /original brief|exact copy|byte-for-byte/);
    op.result!.outcome = 'replayed';
    assert.doesNotMatch(rfqWriteResultText(op)!, /description/);
    op.state = 'UNKNOWN';
    op.result!.outcome = 'outcome_unknown';
    assert.equal(rfqWriteResultText(op), undefined);
  }
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

test('create receipts do not claim rejected or omitted optional extractions were saved', () => {
  const op = operation();
  op.payload.arguments = {
    company_name: `Test\n\u202e${'A'.repeat(400)}`,
    location: 'Bangalore\nBudget: invented',
    requirement: { value: 'untrusted object' },
    raw_text: 'do not render',
  };
  const text = rfqWriteResultText(op)!;
  assert.ok(text.split('\n')[0]!.length <= 'Saved RFQ: '.length + 120);
  assert.match(text, /^Saved RFQ: Test Logistics/);
  assert.doesNotMatch(
    text,
    /\u202e|Requirement:|Location:|Budget:|untrusted object|do not render|Bangalore/,
  );
});

test('a brief-only save is acknowledged without exposing source text or inventing fields', () => {
  const op = operation();
  op.payload.arguments = {
    operation_id: operationId,
    raw_text: 'Private, incomplete original brief',
  };
  op.result!.data = { id: recordId, name: 'New RFQ', url: recordUrl };
  assert.equal(
    rfqWriteResultText(op),
    `Saved RFQ: New RFQ\nFull brief saved in the description.\nOpen in CRM: ${recordUrl}`,
  );
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

test('opportunity deletion names only the verified provider record and does not offer edit or undo', () => {
  const op = operation();
  op.payload.toolName = 'delete_crm_rfq';
  op.result!.outcome = 'deleted';
  op.result!.data = {
    id: recordId,
    name: 'Verified Opportunity',
    url: recordUrl,
    undo_available: false,
    deletion_kind: 'trash',
  };
  assert.equal(
    rfqWriteResultText(op, allTools),
    'Moved opportunity to CRM trash: Verified Opportunity',
  );
  op.result!.outcome = 'replayed';
  assert.match(
    rfqWriteResultText(op)!,
    /^This opportunity was already moved to CRM trash: Verified Opportunity/,
  );
  assert.match(rfqWriteResultText(op)!, /details recorded when that change completed/);
  op.result!.data = undefined;
  assert.equal(
    rfqWriteResultText(op, allTools),
    'That opportunity was already moved to CRM trash.',
  );
});

test('opportunity deletion requires authoritative identity and deletion facts without falling back to arguments', () => {
  const valid = {
    id: recordId,
    name: 'Verified Opportunity',
    undo_available: false,
    deletion_kind: 'trash',
  };
  for (const invalid of [
    undefined,
    {},
    { ...valid, id: 'not-a-record' },
    { ...valid, name: undefined },
    { ...valid, name: '' },
    { ...valid, name: 'A'.repeat(501) },
    { ...valid, name: 'Company\nFake Receipt' },
    { ...valid, undo_available: true },
    { ...valid, deletion_kind: 'destroyed' },
  ]) {
    const op = operation();
    op.payload.toolName = 'delete_crm_rfq';
    op.result!.outcome = 'deleted';
    op.result!.data = invalid;
    const text = rfqWriteResultText(op, allTools)!;
    assert.match(text, /could not verify/);
    assert.doesNotMatch(text, /Moved|ask me|Test Logistics|Verified Opportunity|Open in CRM/);
  }
});
