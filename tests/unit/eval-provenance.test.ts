import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureEvalProvenance } from '../../evals/lib/provenance.js';

test('changes to nested warehouse fixture contracts invalidate the evaluated source snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ramesh-eval-provenance-'));
  try {
    for (const path of ['src', 'evals/results', 'scripts/lib', 'tests/fixtures'])
      await mkdir(join(directory, path), { recursive: true });
    for (const path of [
      'src/agent.ts',
      'evals/cases.ts',
      'scripts/lib/sales-fixture.ts',
      'scripts/lib/analytics-fixture.ts',
      'scripts/lib/shortlist-fixture-contract.ts',
      'scripts/lib/warehouse-fixture-contract.ts',
      'tests/fixtures/context-tool-catalogue.json',
      'tests/fixtures/context-guidance.md',
      'package-lock.json',
    ])
      await writeFile(join(directory, path), '{}');
    const root = pathToFileURL(`${directory}/`);
    const original = await captureEvalProvenance(root);
    for (const file of ['shortlist-fixture-contract.ts', 'warehouse-fixture-contract.ts']) {
      const path = join(directory, 'scripts/lib', file);
      await writeFile(path, 'changed fixture semantics');
      const changed = await captureEvalProvenance(root);
      assert.notEqual(changed.inputHash, original.inputHash);
      assert.notEqual(changed.datasetHash, original.datasetHash);
      await writeFile(path, '{}');
    }
    await writeFile(join(directory, 'evals/results/result.md'), 'new report');
    assert.equal((await captureEvalProvenance(root)).inputHash, original.inputHash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
