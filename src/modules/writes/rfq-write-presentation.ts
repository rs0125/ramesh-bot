/** Concise, grounded RFQ receipts. Only authenticated result data can supply a CRM link. */
import type { WriteOperation } from './write.types.js';

/** Status only: safe on recovery without redisclosing a historical client's brief. */
export function rfqWriteRecoveryText(operation: WriteOperation, now: number): string | undefined {
  if (
    operation.payload.toolName !== 'create_crm_rfq' ||
    operation.payload.sourceFamily !== 'crm' ||
    operation.payload.executionMode !== 'direct_request'
  )
    return undefined;
  if (operation.state === 'SUCCEEDED') return undefined;
  if (
    operation.hasUncertainAttempt ||
    operation.state === 'UNKNOWN' ||
    operation.state === 'DISPATCHING' ||
    operation.result?.outcome === 'outcome_unknown'
  ) {
    const reconcile = 'Ask an administrator to check and resolve the existing submission.';
    if (operation.dispatchAttempts > 1)
      return `I still can’t confirm whether this requirement was saved in CRM. It may already be there. ${reconcile}`;
    const next =
      Date.parse(operation.expiresAt) > now
        ? 'Say “retry” to check the existing submission.'
        : reconcile;
    return `I can’t confirm whether this requirement was saved in CRM. It may already be there. ${next}`;
  }
  if (operation.state !== 'APPROVED' || operation.result?.outcome !== 'not_dispatched')
    return undefined;
  if (['CRM_RFQ_INCOMPLETE', 'CRM_RFQ_INVALID'].includes(operation.result.code)) {
    // Only fixed public field labels may be derived from this diagnostic. Never
    // display the upstream message, original values or raw arguments on recovery.
    const labels = [
      ['location', 'location'],
      ['requirement', 'space requirement'],
      ['city', 'city'],
      ['micro_market', 'locality'],
      ['company_name', 'company name'],
      ['poc_name', 'client contact'],
      ['poc_phone', 'contact number'],
      ['budget', 'budget'],
      ['lead_source', 'lead source'],
      ['lease_duration', 'lease duration'],
      ['repeat_client', 'repeat-client status'],
    ]
      .filter(([field]) => new RegExp(`\\b${field}\\b`).test(operation.result!.message))
      .map(([, label]) => label);
    const detail = labels.length
      ? `The ${labels.join(', ')} ${labels.length === 1 ? 'needs' : 'need'} checking.`
      : 'I couldn’t prepare a valid CRM entry from the brief.';
    return `Nothing was sent to CRM. ${detail} Say “cancel that RFQ attempt”, then send just the correction; you don’t need to repeat the full brief.`;
  }
  return 'Nothing was sent to CRM. I couldn’t complete the save. Once the problem is resolved, say “retry” to try the same submission.';
}

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

function enumLabel(value: unknown, labels: Readonly<Record<string, string>>): unknown {
  return typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : value;
}

function details(args: Record<string, unknown>): string[] {
  return (
    [
      ['Title', args.title],
      ['Company', args.company_name],
      ['Location', args.location],
      ['Requirement', args.requirement],
      ['Budget', args.budget],
      ['City', args.city],
      ['Locality', args.micro_market],
      ['Contact', args.poc_name],
      ['Phone', args.poc_phone],
      [
        'Lead source',
        enumLabel(args.lead_source, {
          OUTREACH: 'Outreach',
          WEBSITE_SEO: 'Website SEO',
          WHATSAPP_INBOUND: 'WhatsApp inbound',
          EXISTING_CLIENT: 'Existing client',
          CLIENT_OWNER_REFERRAL: 'Client/owner referral',
          GODAMWALE: 'Godamwale',
          GW_REACTIVATION: 'GW reactivation',
          BROKER: 'Broker',
          TOLET_BOARDS: 'To-let boards',
          WEBSITE_GOOGLE_ADS: 'Website Google Ads',
        }),
      ],
      [
        'Lease duration',
        enumLabel(args.lease_duration, { LONG_TERM: 'Long term', SHORT_TERM: 'Short term' }),
      ],
      [
        'Repeat client',
        args.repeat_client === true
          ? 'Yes'
          : args.repeat_client === false
            ? 'No'
            : args.repeat_client === null
              ? null
              : undefined,
      ],
    ] as const
  ).flatMap(([label, value]) => {
    if (value === null) return [`${label}: cleared`];
    const text = field(value, label === 'Title' ? 500 : label === 'Budget' ? 200 : 160);
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
  const url = crmLink(data.url, data.id);
  if (!editing) {
    // Creation may save only the brief and omit uncertain optional extractions.
    // A returned title is authoritative; proposed arguments are not a receipt.
    const name = field(data.name, 500);
    return [
      `${replayed ? 'This RFQ was already saved' : 'Saved RFQ'}${name ? `: ${name}` : '.'}`,
      ...(!replayed ? ['Full brief saved in the description.'] : []),
      ...(url ? [`Open in CRM: ${url}`] : []),
      offers(availableToolNames, data),
    ]
      .filter(Boolean)
      .join('\n');
  }
  const values = editing ? object(args.changes ?? args.patch) : args;
  const name = field(values.company_name ?? values.companyName ?? data.name ?? data.title, 120);
  const headline = replayed
    ? `This RFQ was already ${editing ? 'updated' : 'saved'}${name ? `: ${name}` : '.'}`
    : `${editing ? 'Updated' : 'Saved'} RFQ${name ? `: ${name}` : '.'}`;
  return [
    headline,
    ...details(values),
    ...(!replayed && data.description_unchanged === true
      ? ['This edit left the description unchanged.']
      : !replayed && data.description_unchanged === false
        ? ['The description differs from before this edit. Please check it in CRM.']
        : []),
    ...(replayed ? ['These are the details recorded at the time of that change.'] : []),
    ...(url ? [`Open in CRM: ${url}`] : []),
    offers(availableToolNames, data),
  ]
    .filter(Boolean)
    .join('\n');
}
