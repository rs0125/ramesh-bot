import { cpSync } from 'node:fs';
cpSync(new URL('../src/prompts/', import.meta.url), new URL('../dist/prompts/', import.meta.url), {
  recursive: true,
});
// Build fails if the deployable prompt bundle cannot be loaded.
await import('../dist/modules/assistant/prompt-files.js');
