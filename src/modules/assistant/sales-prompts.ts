import { loadPrompt } from './prompt-files.js';
import { ANSWER_RENDERING_CONTRACT } from './answer-rendering.js';
/** Personal-assistant instructions; exported names retained for graph compatibility. */
export const SALES_PROMPT_VERSION = 'ramesh-chief-of-staff-v44';
const evidencePolicy = loadPrompt('evidence-policy');
export const SALES_MANAGER_PROMPT = `${loadPrompt('chief-of-staff')}\n\n${loadPrompt('planning-reference')}\n\n${evidencePolicy}`;
export const BUSINESS_FORMATTER_PROMPT = `${loadPrompt('business-formatter')}\n\n${evidencePolicy}\n\n${ANSWER_RENDERING_CONTRACT}`;
export const EVIDENCE_REPAIR_PROMPT = `${loadPrompt('evidence-repair')}\n\n${evidencePolicy}\n\n${ANSWER_RENDERING_CONTRACT}`;

export const SALES_VERIFIER_PROMPT = `${loadPrompt('verifier')}\n\n${evidencePolicy}`;

export const ROUTER_PROMPT = `${loadPrompt('router')}\n\n${evidencePolicy}`;
export const PLANNER_PROMPT = `${loadPrompt('planner')}\n\n${loadPrompt('planning-reference')}\n\n${evidencePolicy}`;
export const WORKER_PROMPT = `${loadPrompt('worker')}\n\n${SALES_MANAGER_PROMPT}\n\n${ANSWER_RENDERING_CONTRACT}`;
