import type { ContextToolRun } from './tool-executor.js';
import { readContract } from '../context-engine/read-contract.js';

/** Application-owned orientation, with no credentials, private history or model-selected identity. */
export function planningContext(
  run: ContextToolRun | undefined,
  audience: 'dm' | 'group',
  access: string,
  recallAvailable: boolean,
) {
  const tools = audience === 'dm' && access === 'available' ? (run?.tools ?? []) : [];
  const names = tools.map((tool) => tool.name);
  return {
    audience,
    access,
    available_tools: names,
    available_source_families: [
      ...new Set(tools.map((tool) => readContract(tool)?.sourceFamily).filter(Boolean)),
    ],
    private_selection_recall_available: tools.length > 0 && recallAvailable,
    function_schema_reference:
      'Use the live function definitions and Context Engine guidance in this session; omit unset fields and preserve actual returned identifiers/cursors.',
    remaining_source_proposals: tools.length ? (run?.remaining ?? 0) : 0,
    actions:
      'Current catalogue is read-only. Drafting is text; sending, scheduling and changing records are unavailable. Attachments are readable only through ready, unexpired extraction data supplied by the application in this request. A label alone does not provide file contents.',
  };
}
