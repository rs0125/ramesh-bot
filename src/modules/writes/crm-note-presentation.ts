/** CRM note receipts render only the authoritative text returned by the write service. */
import type { WriteOperation } from './write.types.js';

const noteTools = ['create_crm_note', 'update_crm_note', 'undo_crm_note'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Do not trim, normalize, or truncate the verified note text. */
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !value.includes('\0')
  );
}

function dealLink(value: unknown, id: string): string | undefined {
  if (typeof value !== 'string' || value.length > 500 || /[\s\p{Cc}\p{Cf}?#]/u.test(value))
    return undefined;
  try {
    const url = new URL(value);
    if (
      url.origin !== 'https://crm.wareongo.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/object/opportunity/${id}`
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function offer(tools: readonly string[], undoAvailable: boolean): string | undefined {
  const edit = tools.includes('update_crm_note');
  const undo = tools.includes('undo_crm_note') && undoAvailable;
  if (edit && undo) return 'You can ask me to edit this note or undo this change.';
  if (edit) return 'You can ask me to edit this note.';
  if (undo) return 'You can ask me to undo this change.';
  return undefined;
}

/** The caller must separately authorize historical redisclosure; a receipt is not access permission. */
export function crmNoteResultText(
  operation: WriteOperation,
  availableToolNames: readonly string[] = [],
): string | undefined {
  const tool = operation.payload.toolName;
  const undo = tool === 'undo_crm_note';
  const editing = tool === 'update_crm_note';
  if (
    !noteTools.includes(tool) ||
    operation.payload.sourceFamily !== 'crm' ||
    operation.payload.idempotencyArgument !== 'operation_id' ||
    operation.state !== 'SUCCEEDED' ||
    operation.result?.operation_id !== operation.operationId ||
    !(
      undo
        ? ['rolled_back', 'replayed']
        : editing
          ? ['updated', 'replayed']
          : ['created', 'replayed']
    ).includes(operation.result.outcome)
  )
    return undefined;

  if (operation.result.outcome === 'replayed' && operation.result.data === undefined)
    return `That note ${undo ? 'change was already undone' : editing ? 'was already updated' : 'was already saved'}. Its stored text needs a fresh authorized read before I can show it.`;

  const data = object(operation.result.data);
  const deal = object(data.deal);
  const note = object(data.note);
  if (
    typeof data.id !== 'string' ||
    !uuid.test(data.id) ||
    typeof deal.id !== 'string' ||
    !uuid.test(deal.id) ||
    !text(deal.name, 500) ||
    !text(note.title, 160) ||
    !text(note.body, 2000) ||
    (undo && data.undo_kind !== 'creation' && data.undo_kind !== 'edit')
  )
    return 'I could not verify the note details from this receipt. Check CRM before retrying.';

  const replayed = operation.result.outcome === 'replayed';
  const removed = undo && data.undo_kind === 'creation';
  const headline = undo
    ? removed
      ? `${replayed ? 'This note was already removed from' : 'Removed this note from'} deal: ${deal.name}`
      : `${replayed ? 'This note edit was already undone on' : 'Undid the note edit on'} deal: ${deal.name}`
    : `${replayed ? `This note was already ${editing ? 'updated' : 'saved'} on` : `${editing ? 'Updated' : 'Saved'} note on`} deal: ${deal.name}`;
  const link = dealLink(deal.url, deal.id);
  return [
    headline,
    `${undo && !removed ? 'Restored title' : 'Title'}: ${note.title}`,
    `${undo ? (removed ? 'Removed note' : 'Restored note') : 'Note'}:\n${note.body}`,
    replayed ? 'These are the details recorded when that change completed.' : undefined,
    link ? `Open deal in CRM: ${link}` : undefined,
    !undo ? offer(availableToolNames, data.undo_available === true) : undefined,
  ]
    .filter((value) => value !== undefined)
    .join('\n\n');
}
