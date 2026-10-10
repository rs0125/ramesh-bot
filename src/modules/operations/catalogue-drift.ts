/**
 * The bot tests against captured tool catalogues (tests/fixtures/*-tool-catalogue.json) but
 * runs against the live Context Engine catalogue. These checks surface the difference before
 * users do: tools the strict provider subset cannot express, and drift from the fixtures.
 */
import { createHash } from 'node:crypto';
import { strictToolSchema } from '../../infrastructure/openai/strict-tool-schema.js';

export interface CatalogueTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Tool names that would be dropped from a strict-mode model session. */
export function strictUnsupportedTools(tools: readonly CatalogueTool[]): string[] {
  return tools
    .filter((tool) => {
      try {
        strictToolSchema(tool.inputSchema);
        return false;
      } catch (error) {
        if (error instanceof Error && error.message === 'UNSUPPORTED_STRICT_TOOL_SCHEMA')
          return true;
        throw error;
      }
    })
    .map((tool) => tool.name);
}

export interface CatalogueDrift {
  added: string[];
  removed: string[];
  changed: Array<{
    name: string;
    parts: Array<'inputSchema' | 'description' | '_meta' | 'annotations'>;
  }>;
}

/** Compare the tools both catalogues know; tools only in the fixture are reported as removed. */
export function catalogueDrift(
  live: readonly CatalogueTool[],
  fixture: readonly CatalogueTool[],
): CatalogueDrift {
  const byName = new Map(live.map((tool) => [tool.name, tool]));
  const fixtureNames = new Set(fixture.map((tool) => tool.name));
  const changed: CatalogueDrift['changed'] = [];
  for (const expected of fixture) {
    const actual = byName.get(expected.name);
    if (!actual) continue;
    const parts = (['inputSchema', 'description', '_meta', 'annotations'] as const).filter(
      (part) =>
        // A fixture that never captured a part cannot drift on it.
        expected[part] !== undefined && hash(expected[part]) !== hash(actual[part]),
    );
    if (parts.length) changed.push({ name: expected.name, parts });
  }
  return {
    added: live.map((tool) => tool.name).filter((name) => !fixtureNames.has(name)),
    removed: fixture.map((tool) => tool.name).filter((name) => !byName.has(name)),
    changed,
  };
}

function hash(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
