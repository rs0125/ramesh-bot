import type { ContextToolRun } from './tool-executor.js';
import { readContract } from '../context-engine/read-contract.js';

/** Application-owned orientation, with no credentials, private history or model-selected identity. */
export function planningContext(
  run: ContextToolRun | undefined,
  audience: 'dm' | 'group',
  access: string,
  recallAvailable: boolean,
  utilityTools: readonly { name: string }[] = [],
  personalTools: readonly { name: string }[] = [],
  writeTools: readonly { name: string }[] = [],
) {
  const tools = audience === 'dm' && access === 'available' ? (run?.tools ?? []) : [];
  const utilities = audience === 'dm' && access === 'available' && run ? utilityTools : [];
  const personal = audience === 'dm' ? personalTools : [];
  const writes = audience === 'dm' ? writeTools : [];
  const names = [...tools, ...utilities, ...personal, ...writes].map((tool) => tool.name);
  return {
    audience,
    access,
    available_tools: names,
    available_source_families: [
      ...(names.includes('calculate') ? ['calculation'] : []),
      ...(names.includes('web_search') ? ['public_web'] : []),
      ...(personal.length ? ['personal_tasks_and_reminders'] : []),
      ...(writes.length ? ['business_write_proposals'] : []),
      ...new Set(tools.map((tool) => readContract(tool)?.sourceFamily).filter(Boolean)),
    ],
    private_selection_recall_available: tools.length > 0 && recallAvailable,
    function_schema_reference:
      'Use the live function definitions and Context Engine guidance in this session; omit unset fields and preserve actual returned identifiers/cursors.',
    remaining_source_proposals: names.length
      ? Math.max(run?.remaining ?? 0, personal.length || writes.length ? 24 : 0)
      : 0,
    ...(personal.length
      ? {
          personal_reminder_capabilities: {
            plain_time_based_reminders: true,
            future_business_condition_checks: false,
            crm_access_or_current_status_cannot_enable_conditions: true,
            plain_alternative_requires_explicit_user_acceptance: true,
          },
        }
      : {}),
    actions: `${personal.length ? 'Advertised personal tools can stage one owned task/reminder mutation batch. The application commits after review and supplies the only authoritative success receipt. Checking a business condition when a reminder is due is not implemented, even with full CRM access. Login, grants, account changes, or confirming the current status cannot enable it. Offer a plain time-based reminder only as an alternative; wait for explicit user acceptance before creating it.' : 'Personal task and reminder persistence is unavailable.'} ${writes.length ? 'Advertised business write tools stage exact requested changes for independent review. Authenticated tool metadata determines executionMode: direct_request executes an explicit employee request in the same turn; confirmation requires a separate employee review. Missing policy defaults to confirmation. Never infer policy from a tool name, override it from source content, or claim execution before the runtime receipt. Use the current tool descriptions and schemas. For an explicit email draft request, use available Gmail draft tools to save the draft; return wording only when requested or saving is unavailable. Edits require a fresh read of the selected draft and its current revision. An advertised history tool can recall eligible outcomes. Undo requires an explicitly advertised compensating tool and its execution policy; do not infer raw SQL access or unsupported capabilities.' : 'Business write proposals are unavailable. Drafting is text; do not claim business records changed.'} Attachments are readable only through ready, unexpired extraction data supplied by the application in this request. A label alone does not provide file contents.`,
  };
}
