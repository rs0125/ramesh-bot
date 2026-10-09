/** Provider contract checks at the fake HTTP/model boundary, independent of our converter. */
import assert from 'node:assert/strict';

export function assertStrictResponseSchema(schema: Record<string, unknown>) {
  assert.equal(schema.type, 'object');
  assert.equal(schema.anyOf, undefined, 'A strict response must have an object root');
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    for (const key of ['oneOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentSchemas'])
      assert.equal(node[key], undefined, `${path}: unsupported ${key}`);
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `${path}: extra properties must be closed`);
      assert.deepEqual(
        [...((node.required as string[] | undefined) ?? [])].sort(),
        Object.keys(node.properties ?? {}).sort(),
        `${path}: every response property must be required`,
      );
    }
    for (const key of ['properties', '$defs', 'definitions'])
      for (const [name, child] of Object.entries(node[key] ?? {}))
        visit(child, `${path}/${key}/${name}`);
    if (Array.isArray(node.anyOf))
      node.anyOf.forEach((child, index) => visit(child, `${path}/anyOf/${index}`));
    if (node.items) visit(node.items, `${path}/items`);
  };
  visit(schema, '#');
}
