import assert from 'node:assert/strict';
import test from 'node:test';
import { crmNoteResultText } from '../../src/modules/writes/crm-note-presentation.js';
import type { WriteOperation } from '../../src/modules/writes/write.types.js';

const operationId = '00000000-0000-4000-8000-000000000001';
const dealId = '00000000-0000-4000-8000-000000000002';
const noteId = '00000000-0000-4000-8000-000000000003';
const dealUrl = `https://crm.wareongo.com/object/opportunity/${dealId}`;
const tools = ['create_crm_note', 'update_crm_note', 'undo_crm_note'];

function data() {
  return {
    id: noteId,
    deal: { id: dealId, name: 'Test Logistics – Bangalore', url: dealUrl },
    note: { title: 'Site visit', body: 'Visited the site.\n\n  Follow up on Friday at 10 am.' },
    undo_available: true,
  };
}

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
      toolName: 'create_crm_note',
      toolSchema: {},
      sourceFamily: 'crm',
      arguments: {
        operation_id: operationId,
        title: 'Model title must not be shown',
        body: 'Model body must not be shown',
        raw_text: 'Private command must not be shown',
      },
      idempotencyArgument: 'operation_id',
      executionMode: 'direct_request',
      summary: 'Model summary must not be shown',
      source: {},
    },
    confirmationCode: '9A814C06',
    proposalRunId: 'run',
    sourceMessageId: 'message',
    approvalRunId: 'run',
    approvalSourceMessageId: 'message',
    deliveryMode: 'production',
    createdAt: '2026-10-05T10:00:00Z',
    updatedAt: '2026-10-05T10:00:00Z',
    expiresAt: '2026-10-05T11:00:00Z',
    dispatchAttempts: 1,
    hasUncertainAttempt: false,
    result: {
      operation_id: operationId,
      outcome: 'created',
      code: 'CRM_NOTE_CREATED',
      message: 'Provider prose must not be shown',
      data: data(),
    },
  };
}

test('create and edit show the exact verified saved note and target deal, never model arguments', () => {
  for (const editing of [false, true]) {
    const op = operation();
    if (editing) {
      op.payload.toolName = 'update_crm_note';
      op.result!.outcome = 'updated';
    }
    const text = crmNoteResultText(op, tools)!;
    assert.equal(
      text,
      [
        `${editing ? 'Updated' : 'Saved'} note on deal: Test Logistics – Bangalore`,
        'Title: Site visit',
        `Note:\n${data().note.body}`,
        `Open deal in CRM: ${dealUrl}`,
        'You can ask me to edit this note or undo this change.',
      ].join('\n\n'),
    );
    assert.doesNotMatch(text, /Model|Private command|Provider prose|9A814C06|audit|confirm/);
    assert.ok(!text.includes(operationId));
    assert.ok(!text.includes(noteId));
  }
});

test('undo creation shows the removed note while undo edit shows the restored note', () => {
  for (const undoKind of ['creation', 'edit'] as const) {
    const op = operation();
    op.payload.toolName = 'undo_crm_note';
    op.result!.outcome = 'rolled_back';
    op.result!.data = { ...data(), undo_kind: undoKind };
    const text = crmNoteResultText(op, tools)!;
    assert.match(
      text,
      undoKind === 'creation'
        ? /^Removed this note from deal: Test Logistics/
        : /^Undid the note edit on deal: Test Logistics/,
    );
    assert.ok(
      text.includes(
        `${undoKind === 'creation' ? 'Removed' : 'Restored'} note:\n${data().note.body}`,
      ),
    );
    assert.ok(text.includes(`${undoKind === 'creation' ? 'Title' : 'Restored title'}: Site visit`));
    assert.doesNotMatch(text, /ask me|already|Model/);
  }
});

test('replays say already completed and do not imply the historical receipt is current state', () => {
  for (const tool of tools) {
    const op = operation();
    op.payload.toolName = tool;
    op.result!.outcome = 'replayed';
    op.result!.data = { ...data(), undo_kind: 'edit' };
    const text = crmNoteResultText(op, tools)!;
    assert.match(text, /^This note(?: edit)? was already/);
    assert.match(text, /details recorded when that change completed/);
    assert.ok(text.includes(data().note.body));
  }
});

test('full maximum-length note strings retain whitespace without truncation', () => {
  const op = operation();
  const note = { title: ` ${'T'.repeat(158)} `, body: `\n${'B'.repeat(1997)}\n\n` };
  op.result!.data = { ...data(), note };
  const text = crmNoteResultText(op)!;
  assert.ok(text.includes(`Title: ${note.title}`));
  assert.ok(text.includes(`Note:\n${note.body}`));
  assert.doesNotMatch(text, /…|unavailable/);
});

test('a replay without redisclosure acknowledges completion without inviting a duplicate retry', () => {
  for (const tool of tools) {
    const op = operation();
    op.payload.toolName = tool;
    op.result!.outcome = 'replayed';
    op.result!.data = undefined;
    const text = crmNoteResultText(op, tools)!;
    assert.match(text, /already (saved|updated|undone)/);
    assert.match(text, /fresh authorized read/);
    assert.doesNotMatch(text, /retry|Model|Site visit|Test Logistics|ask me to/);
  }
});

test('edit and undo suggestions require live tools and undo eligibility', () => {
  const op = operation();
  assert.doesNotMatch(crmNoteResultText(op)!, /ask me/);
  assert.match(crmNoteResultText(op, ['update_crm_note'])!, /ask me to edit this note\.$/);
  assert.match(crmNoteResultText(op, ['undo_crm_note'])!, /ask me to undo this change\.$/);
  for (const undoAvailable of [false, undefined, 'true']) {
    op.result!.data = { ...data(), undo_available: undoAvailable };
    assert.doesNotMatch(crmNoteResultText(op, tools)!, /undo/);
  }
});

test('missing, malformed and overlong authoritative data never falls back to model fields', () => {
  for (const invalid of [
    undefined,
    {},
    { ...data(), id: undefined },
    { ...data(), id: 'not-a-note-id' },
    { ...data(), deal: undefined },
    { ...data(), deal: { ...data().deal, id: noteId, name: '' } },
    { ...data(), note: undefined },
    { ...data(), note: { title: undefined, body: data().note.body } },
    { ...data(), note: { title: 'T'.repeat(161), body: data().note.body } },
    { ...data(), note: { title: data().note.title, body: 'B'.repeat(2001) } },
    { ...data(), note: { title: data().note.title, body: '  ' } },
    { ...data(), note: { title: data().note.title, body: 'Body\0' } },
  ]) {
    const op = operation();
    op.result!.data = invalid;
    const text = crmNoteResultText(op, tools)!;
    assert.match(text, /could not verify.*Check CRM before retrying/);
    assert.doesNotMatch(text, /Model|Private|Site visit|ask me|Open deal/);
  }
  const undo = operation();
  undo.payload.toolName = 'undo_crm_note';
  undo.result!.outcome = 'rolled_back';
  assert.match(crmNoteResultText(undo)!, /could not verify/);
});

test('only server CRM links for the exact verified deal are displayed', () => {
  for (const url of [
    'https://example.com/deal',
    dealUrl.replace('https:', 'http:'),
    dealUrl.replace('crm.wareongo.com', 'crm.wareongo.com.evil.test'),
    dealUrl.replace('https://', 'https://person:secret@'),
    `${dealUrl}?token=private`,
    `${dealUrl}#private`,
    `${dealUrl}?`,
    `${dealUrl}#`,
    `${dealUrl}\n`,
    'https://crm.wareongo.com/settings',
    dealUrl.replace(dealId, noteId),
  ]) {
    const op = operation();
    op.result!.data = { ...data(), deal: { ...data().deal, url } };
    const text = crmNoteResultText(op)!;
    assert.doesNotMatch(text, /Open deal/, url);
    assert.ok(text.includes(data().note.body));
  }
});

test('unrelated, incomplete or contradictory receipts are not note successes', () => {
  const mutations: Array<(op: WriteOperation) => void> = [
    (op) => {
      op.state = 'UNKNOWN';
    },
    (op) => {
      op.result!.operation_id = noteId;
    },
    (op) => {
      op.result = undefined;
    },
    (op) => {
      op.result!.outcome = 'outcome_unknown';
    },
    (op) => {
      op.result!.outcome = 'updated';
    },
    (op) => {
      op.payload.toolName = 'create_crm_rfq';
    },
    (op) => {
      op.payload.sourceFamily = 'mail';
    },
    (op) => {
      op.payload.idempotencyArgument = 'id';
    },
    (op) => {
      op.payload.toolName = 'undo_crm_note';
    },
  ];
  for (const mutate of mutations) {
    const op = operation();
    mutate(op);
    assert.equal(crmNoteResultText(op), undefined);
  }
});
