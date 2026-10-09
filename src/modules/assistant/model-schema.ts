/** Provider-compatible schemas; application parsers still own semantic validation. */
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import type { ModelRequest } from './assistant.types.js';

export function modelJsonSchema(
  name: string,
  schema: z.ZodType,
): NonNullable<ModelRequest['jsonSchema']> {
  // Zod's raw JSON Schema can emit oneOf for discriminated unions. The SDK
  // preserves those exclusive branches as supported anyOf and normalizes defaults.
  const format = zodTextFormat(schema, name);
  return { name: format.name, schema: format.schema };
}
