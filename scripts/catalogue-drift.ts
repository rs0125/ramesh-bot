/**
 * Compare a live Context Engine read catalogue with the captured test fixtures.
 * No model, no network: capture the live catalogue first with
 *   npm run capability:preflight -- --env-file <worker env> --catalogue-out .local/live-catalogue.json
 * then run
 *   npm run catalogue:drift -- --live .local/live-catalogue.json
 * Exit code 1 when a live tool cannot be expressed in strict mode or a shared tool changed.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  catalogueDrift,
  strictUnsupportedTools,
  type CatalogueTool,
} from '../src/modules/operations/catalogue-drift.js';

const FIXTURES = [
  'tests/fixtures/context-tool-catalogue.json',
  'tests/fixtures/transcript-tool-catalogue.json',
];

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { live: { type: 'string' } },
  });
  if (!values.live) throw new Error('Usage: catalogue:drift -- --live <catalogue.json>');
  const live = JSON.parse(await readFile(values.live, 'utf8')) as CatalogueTool[];
  const unsupported = strictUnsupportedTools(live);
  const drift = Object.fromEntries(
    await Promise.all(
      FIXTURES.map(async (file) => [
        file,
        catalogueDrift(live, JSON.parse(await readFile(file, 'utf8')) as CatalogueTool[]),
      ]),
    ),
  );
  console.log(JSON.stringify({ unsupported, drift }, null, 2));
  process.exitCode =
    unsupported.length ||
    Object.values(drift).some((entry) => (entry as { changed: unknown[] }).changed.length)
      ? 1
      : 0;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
