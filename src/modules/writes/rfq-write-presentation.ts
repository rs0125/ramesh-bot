/** Concise, grounded RFQ receipts. Only authenticated result data can supply a CRM link. */
import type { WriteOperation } from './write.types.js';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function field(value: unknown, limit = 160): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return undefined;
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).trimEnd()}…`;
}

function crmLink(value: unknown, recordId: unknown): string | undefined {
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
      !/^\/object\/opportunity\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        url.pathname,
      ) ||
      (typeof recordId === 'string' && !url.pathname.endsWith(`/${recordId}`))
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function offers(tools: readonly string[], data: Record<string, unknown>): string | undefined {
  const edit = tools.includes('update_crm_rfq');
  const undo = tools.includes('undo_crm_rfq') && data.undo_available === true;
  if (edit && undo) return 'You can ask me to edit it or undo this change.';
  if (edit) return 'You can ask me to edit it.';
  if (undo) return 'You can ask me to undo this change.';
  return undefined;
}

function details(args: Record<string, unknown>, editing: boolean): string[] {
  return (
    [
      ['Location', args.location],
      ['Requirement', args.requirement],
      ['Budget', args.budget],
      ...(editing
        ? ([
            ['City', args.city],
            ['Locality', args.micro_market],
            ['Contact', args.poc_name],
            ['Phone', args.poc_phone],
          ] as const)
        : []),
    ] as const
  ).flatMap(([label, value]) => {
    if (editing && value === null) return [`${label}: cleared`];
    const text = field(value);
    return text ? [`${label}: ${text}`] : [];
  });
}

/** Historical redisclosure must already be authorized by the caller. */
export function rfqWriteResultText(
  operation: WriteOperation,
  availableToolNames: readonly string[] = [],
): string | undefined {
  const tool = operation.payload.toolName;
  if (
    !['create_crm_rfq', 'update_crm_rfq', 'undo_crm_rfq', 'delete_crm_rfq'].includes(tool) ||
    operation.payload.sourceFamily !== 'crm' ||
    operation.payload.idempotencyArgument !== 'operation_id' ||
    operation.state !== 'SUCCEEDED' ||
    operation.result?.operation_id !== operation.operationId ||
    !(
      tool === 'delete_crm_rfq'
        ? ['deleted', 'replayed']
        : tool === 'undo_crm_rfq'
          ? ['rolled_back', 'replayed']
          : tool === 'update_crm_rfq'
            ? ['updated', 'replayed']
            : ['created', 'replayed']
    ).includes(operation.result.outcome)
  )
    return undefined;

  const replayed = operation.result.outcome === 'replayed';
  if (tool === 'undo_crm_rfq')
    return replayed ? 'That RFQ change was already undone.' : 'Undid that RFQ change.';

  const data = object(operation.result.data);
  if (tool === 'delete_crm_rfq') {
    if (replayed && operation.result.data === undefined)
      return 'That opportunity was already moved to CRM trash.';
    if (
      typeof data.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(data.id) ||
      typeof data.name !== 'string' ||
      !data.name.trim() ||
      data.name.length > 500 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(data.name) ||
      data.deletion_kind !== 'trash' ||
      data.undo_available !== false
    )
      return 'I could not verify the deleted opportunity details from this receipt. Check CRM before retrying.';
    return `${replayed ? 'This opportunity was already moved' : 'Moved opportunity'} to CRM trash: ${data.name}${replayed ? '\nThese are the details recorded when that change completed.' : ''}`;
  }
  const args = operation.payload.arguments;
  const editing = tool === 'update_crm_rfq';
  const values = editing ? object(args.changes ?? args.patch) : args;
  const name = field(values.company_name ?? values.companyName ?? data.name ?? data.title, 120);
  const headline = replayed
    ? `This RFQ was already ${editing ? 'updated' : 'saved'}${name ? `: ${name}` : '.'}`
    : `${editing ? 'Updated' : 'Saved'} RFQ${name ? `: ${name}` : '.'}`;
  const url = crmLink(data.url, data.id);
  return [
    headline,
    ...details(values, editing),
    ...(replayed ? ['These are the details recorded at the time of that change.'] : []),
    ...(url ? [`Open in CRM: ${url}`] : []),
    offers(availableToolNames, data),
  ]
    .filter(Boolean)
    .join('\n');
}
