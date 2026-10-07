/** Snapshot checked-in inputs before any paid trial; never read environment or private artifacts. */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function sources(root: URL, path: string): Promise<string[]> {
  const entries = await readdir(new URL(path, root), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const name = `${path}${entry.name}`;
      if (name === 'evals/results') return [];
      if (entry.isDirectory()) return sources(root, `${name}/`);
      return entry.isFile() && /\.(?:ts|md|json)$/.test(name) ? [name] : [];
    }),
  );
  return nested.flat();
}
export async function captureEvalProvenance(root: URL) {
  const files = [
    ...(await sources(root, 'src/')),
    ...(await sources(root, 'evals/')),
    'scripts/lib/sales-fixture.ts',
    'scripts/lib/transcript-fixture.ts',
    'scripts/lib/analytics-fixture.ts',
    'scripts/lib/shortlist-fixture-contract.ts',
    'scripts/lib/warehouse-fixture-contract.ts',
    'tests/fixtures/context-tool-catalogue.json',
    'tests/fixtures/transcript-tool-catalogue.json',
    'tests/fixtures/context-guidance.md',
    'package-lock.json',
  ].sort();
  const inputManifest = Object.fromEntries(
    await Promise.all(
      files.map(async (path) => [path, hash(await readFile(new URL(path, root)))] as const),
    ),
  );
  const datasetManifest = Object.fromEntries(
    Object.entries(inputManifest).filter(([path]) =>
      /(?:-cases\.ts|fixture|context-guidance)/.test(path),
    ),
  );
  return {
    inputManifest,
    inputHash: hash(JSON.stringify(inputManifest)),
    datasetHash: hash(JSON.stringify(datasetManifest)),
  };
}
