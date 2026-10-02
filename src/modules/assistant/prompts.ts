import { loadPrompt } from './prompt-files.js';
/** Versioned prompts, kept separate from orchestration so eval reports identify changes. */
export const PROMPT_VERSION = 'ramesh-chat-v1.4';

export const CONVERSER_PROMPT = loadPrompt('converser');

export const FORMATTER_PROMPT = loadPrompt('formatter');
