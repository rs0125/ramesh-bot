import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  catalogueDrift,
  strictUnsupportedTools,
  type CatalogueTool,
} from '../../src/modules/operations/catalogue-drift.js';

const fixture = async (name: string) =>
  JSON.parse(await readFile(`tests/fixtures/${name}`, 'utf8')) as CatalogueTool[];

test('the captured catalogues compile in strict mode and match themselves', async () => {
  for (const name of ['context-tool-catalogue.json', 'transcript-tool-catalogue.json']) {
    const tools = await fixture(name);
    assert.deepEqual(strictUnsupportedTools(tools), [], name);
    assert.deepEqual(catalogueDrift(tools, tools), { added: [], removed: [], changed: [] });
  }
});

test('drift reports added, removed and changed tools; key order is not a change', async () => {
  const tools = await fixture('context-tool-catalogue.json');
  const [first, second, ...rest] = tools;
  const reordered = {
    ...first!,
    inputSchema: Object.fromEntries(Object.entries(first!.inputSchema).reverse()),
  };
  const changed = { ...second!, description: `${second!.description ?? ''} Changed.` };
  const added = { name: 'new_tool', inputSchema: { type: 'object', properties: {} } };
  const live = [reordered, changed, added, ...rest.slice(1)];
  assert.deepEqual(catalogueDrift(live, tools), {
    added: ['new_tool'],
    removed: [rest[0]!.name],
    changed: [{ name: second!.name, parts: ['description'] }],
  });
});

test('a live tool using a free-form map is flagged before it reaches a model session', () => {
  assert.deepEqual(
    strictUnsupportedTools([
      {
        name: 'tag_things',
        inputSchema: {
          type: 'object',
          properties: { labels: { type: 'object', additionalProperties: { type: 'string' } } },
          required: ['labels'],
          additionalProperties: false,
        },
      },
    ]),
    ['tag_things'],
  );
});
