/**
 * PAID (one small Luna request, well under $0.01). Checks that OpenAI accepts every tool
 * schema this bot sends in strict mode. The strict codec keeps minLength/maxLength, which
 * OpenAI's docs do not list for strings, and the nullable {value} wrapper adds a nesting
 * level (limit 10). Offline tests cannot prove provider acceptance; this request can.
 *
 * Requires explicit approval under AGENTS.md. Usage:
 *   npm run probe:strict-catalogue -- --confirm-paid [--catalogue .local/live-catalogue.json]
 * Without --catalogue it uses the captured fixtures in tests/fixtures/.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import { OpenAIToolCatalog } from '../src/infrastructure/openai/tool-catalog.js';
import type { CatalogueTool } from '../src/modules/operations/catalogue-drift.js';
import { DEFAULT_EVAL_MODEL } from '../evals/lib/run-policy.js';

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'confirm-paid': { type: 'boolean', default: false },
      catalogue: { type: 'string', multiple: true },
    },
  });
  if (!values['confirm-paid'])
    throw new Error('Paid probe: rerun with --confirm-paid after approval (see AGENTS.md).');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required.');
  const files = values.catalogue?.length
    ? values.catalogue
    : [
        'tests/fixtures/context-tool-catalogue.json',
        'tests/fixtures/transcript-tool-catalogue.json',
      ];
  const tools = new Map<string, CatalogueTool>();
  for (const file of files)
    for (const tool of JSON.parse(await readFile(file, 'utf8')) as CatalogueTool[])
      tools.set(tool.name, tool);
  // Only the input schemas matter to the provider check; annotations are not sent.
  const catalog = new OpenAIToolCatalog(
    [...tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      ...(description ? { description } : {}),
      inputSchema,
    })),
    'eager',
  );
  const client = new OpenAI({ apiKey, maxRetries: 0 });
  try {
    await client.responses.create({
      model: DEFAULT_EVAL_MODEL,
      input: 'Reply with OK. Do not call tools.',
      tools: catalog.render(),
      tool_choice: 'none',
      store: false,
      max_output_tokens: 16,
    });
    console.log(
      JSON.stringify({
        accepted: true,
        tools: catalog.bindings.length,
        droppedLocally: catalog.dropped,
      }),
    );
  } catch (error) {
    const api = error instanceof OpenAI.APIError ? error : undefined;
    console.log(
      JSON.stringify({
        accepted: false,
        status: api?.status,
        code: api?.code,
        // The provider names the offending schema path; it contains no business data.
        message: api?.message?.slice(0, 500),
        droppedLocally: catalog.dropped,
      }),
    );
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
