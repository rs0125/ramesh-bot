import { loadPrompt } from './prompt-files.js';
/** Personal-assistant instructions; exported names retained for graph compatibility. */
export const SALES_PROMPT_VERSION = 'ramesh-chief-of-staff-v23';
const evidencePolicy = loadPrompt('evidence-policy');
export const SALES_MANAGER_PROMPT = `${loadPrompt('chief-of-staff')}\n\n${loadPrompt('planning-reference')}\n\n${evidencePolicy}`;
export const BUSINESS_FORMATTER_PROMPT = `${loadPrompt('business-formatter')}\n\n${evidencePolicy}`;

export const SALES_VERIFIER_PROMPT = `${loadPrompt('verifier')}\n\n${evidencePolicy}`;

export const ROUTER_PROMPT = `${loadPrompt('router')}\n\n${evidencePolicy}`;
export const PLANNER_PROMPT = `${loadPrompt('planner')}\n\n${loadPrompt('planning-reference')}\n\n${evidencePolicy}`;
export const WORKER_PROMPT = `${loadPrompt('worker')}\n\n${SALES_MANAGER_PROMPT}`;
