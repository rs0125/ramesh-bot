/** Immutable per-process prompts. No caller-supplied paths or runtime overrides. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const PROMPT_NAMES = [
  'converser',
  'formatter',
  'chief-of-staff',
  'business-formatter',
  'evidence-repair',
  'verifier',
  'legacy-read-converser',
  'evidence-policy',
  'planning-reference',
  'router',
  'planner',
  'worker',
  'media-extractor',
] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];
const prompts = new Map<PromptName, string>();
for (const name of PROMPT_NAMES) {
  const text = readFileSync(new URL(`../../prompts/${name}.md`, import.meta.url), 'utf8').trim();
  if (!text || Buffer.byteLength(text) > 32_000) throw new Error(`Invalid prompt: ${name}`);
  prompts.set(name, text);
}
export function loadPrompt(name: PromptName): string {
  const text = prompts.get(name);
  if (!text) throw new Error('Unknown prompt');
  return text;
}
export function promptManifest() {
  return Object.fromEntries(
    PROMPT_NAMES.map((name) => [name, createHash('sha256').update(loadPrompt(name)).digest('hex')]),
  );
}
