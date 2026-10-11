import { loadPrompt } from './prompt-files.js';
import { ANSWER_RENDERING_CONTRACT } from './answer-rendering.js';
/** Personal-assistant instructions; exported names retained for graph compatibility. */
export const SALES_PROMPT_VERSION = 'ramesh-chief-of-staff-v56';
const evidencePolicy = loadPrompt('evidence-policy');
const requirementInterpretation = loadPrompt('requirement-interpretation');
export const SALES_MANAGER_PROMPT = `${loadPrompt('chief-of-staff')}\n\n${loadPrompt('planning-reference')}\n\n${requirementInterpretation}\n\n${evidencePolicy}`;
export const BUSINESS_FORMATTER_PROMPT = `${loadPrompt('business-formatter')}\n\n${evidencePolicy}\n\n${ANSWER_RENDERING_CONTRACT}`;
export const EVIDENCE_REPAIR_PROMPT = `${loadPrompt('evidence-repair')}\n\n${requirementInterpretation}\n\n${evidencePolicy}\n\n${ANSWER_RENDERING_CONTRACT}`;

/** Domain review rules load only for turns whose evidence or staged actions involve that domain. */
export const VERIFIER_SECTIONS = [
  'writes',
  'personal',
  'crm',
  'supply',
  'recall',
  'analytics',
] as const;
export type VerifierSection = (typeof VERIFIER_SECTIONS)[number];
const verifierSections = Object.fromEntries(
  VERIFIER_SECTIONS.map((name) => [name, loadPrompt(`verifier-${name}`)]),
) as Record<VerifierSection, string>;
// Sections follow the verifier's opening (title and the application-owned text rule), where the
// write rules sat before the split. At the end, after the shared policy, a write-narration rule
// was misapplied to the application's own pending preview (RFQ receipt-only saves rejected).
const verifierParts = loadPrompt('verifier').split('\n\n');
const verifierOpening = verifierParts.slice(0, 2).join('\n\n');
const verifierBody = verifierParts.slice(2).join('\n\n');
export function verifierInstructions(sections: ReadonlySet<VerifierSection>): string {
  return [
    verifierOpening,
    ...VERIFIER_SECTIONS.filter((name) => sections.has(name)).map((name) => verifierSections[name]),
    verifierBody,
    requirementInterpretation,
    evidencePolicy,
  ].join('\n\n');
}
export const SALES_VERIFIER_PROMPT = verifierInstructions(new Set());
/** Every section at once: the upper bound a single review can receive (budget-tested). */
export const SALES_VERIFIER_FULL_PROMPT = verifierInstructions(new Set(VERIFIER_SECTIONS));

export const ROUTER_PROMPT = `${loadPrompt('router')}\n\n${evidencePolicy}`;
export const PLANNER_PROMPT = `${loadPrompt('planner')}\n\n${loadPrompt('planning-reference')}\n\n${requirementInterpretation}\n\n${evidencePolicy}`;
export const WORKER_PROMPT = `${loadPrompt('worker')}\n\n${SALES_MANAGER_PROMPT}\n\n${ANSWER_RENDERING_CONTRACT}`;
