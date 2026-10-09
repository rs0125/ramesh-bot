/** A provider-only encoding. Business schemas, arguments and receipt hashes stay unchanged. */
import { isDeepStrictEqual } from 'node:util';
import { schemaAccepts } from '../../modules/context-engine/read-contract.js';

type Schema = Record<string, unknown>;
type Codec = { schema: Schema; decode(value: unknown): unknown };
const invalid = () => new Error('INVALID_STRICT_TOOL_ARGUMENTS');
const unsupported = () => new Error('UNSUPPORTED_STRICT_TOOL_SCHEMA');
const object = (value: unknown): value is Schema =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const keywords = new Set([
  '$schema',
  '$id',
  '$defs',
  'definitions',
  '$ref',
  'title',
  'description',
  'default',
  'examples',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'oneOf',
  'allOf',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);

export function strictToolSchema(source: Schema): Codec {
  const compile = (node: Schema, depth: number): Codec => {
    if (depth > 40 || Object.keys(node).some((key) => !keywords.has(key))) throw unsupported();
    if (node.allOf !== undefined) {
      // Zod emits combined string regexes this way (including Gmail addresses).
      // Keep one provider pattern; the original validator enforces their intersection.
      if (
        node.type !== 'string' ||
        !Array.isArray(node.allOf) ||
        !node.allOf.length ||
        node.allOf.some(
          (part) =>
            !object(part) || Object.keys(part).length !== 1 || typeof part.pattern !== 'string',
        )
      )
        throw unsupported();
      const { allOf, ...rest } = node;
      return compile({ ...rest, pattern: node.pattern ?? allOf[0].pattern }, depth + 1);
    }
    if (node.$ref !== undefined) {
      if (typeof node.$ref !== 'string' || !node.$ref.startsWith('#/')) throw unsupported();
      let target: unknown = source;
      for (const part of node.$ref.slice(2).split('/')) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        target = object(target) && Object.hasOwn(target, key) ? target[key] : undefined;
      }
      if (!object(target)) throw unsupported();
      const { $ref: _, ...siblings } = node;
      // Constraint-bearing ref siblings need intersection, never a lossy merge.
      if (Object.keys(siblings).some((key) => !['description', 'title'].includes(key)))
        throw unsupported();
      return compile({ ...target, ...siblings }, depth + 1);
    }
    // These constraints remain enforced against the original schema after decoding.
    // They are not supported by the provider's strict JSON Schema subset.
    const {
      $schema,
      $id,
      $defs,
      definitions,
      default: _default,
      examples,
      uniqueItems,
      minProperties,
      maxProperties,
      exclusiveMinimum,
      exclusiveMaximum,
      ...base
    } = node;
    if (
      typeof base.format === 'string' &&
      ![
        'date-time',
        'time',
        'date',
        'duration',
        'email',
        'hostname',
        'ipv4',
        'ipv6',
        'uuid',
      ].includes(base.format)
    )
      delete base.format;
    const union = node.anyOf ?? node.oneOf;
    if (union !== undefined) {
      if (!Array.isArray(union) || !union.length || union.some((branch) => !object(branch)))
        throw unsupported();
      const { anyOf, oneOf, ...common } = base;
      if (Object.keys(common).some((key) => !['description', 'title'].includes(key)))
        throw unsupported();
      const branches = union.map((branch) => compile(branch, depth + 1));
      return {
        schema: { ...common, anyOf: branches.map((branch) => branch.schema) },
        decode(value) {
          const matches = branches.filter((branch) => schemaAccepts(branch.schema, value));
          if (!matches.length) throw invalid();
          const values = matches.map((branch) => branch.decode(value));
          if (values.some((other) => !isDeepStrictEqual(other, values[0]))) throw invalid();
          return values[0];
        },
      };
    }
    if (Array.isArray(node.type)) {
      const { type, ...common } = base;
      return compile({ anyOf: node.type.map((item) => ({ ...common, type: item })) }, depth + 1);
    }
    if (node.type === 'object') {
      if (node.additionalProperties !== undefined && node.additionalProperties !== false)
        throw unsupported();
      if (node.properties !== undefined && !object(node.properties)) throw unsupported();
      const properties = (node.properties ?? {}) as Record<string, Schema>;
      if (Object.values(properties).some((child) => !object(child))) throw unsupported();
      const required = new Set((node.required ?? []) as string[]);
      if ([...required].some((key) => !Object.hasOwn(properties, key))) throw unsupported();
      const children = Object.entries(properties).map(([key, child]) => {
        const codec = compile(child, depth + 1);
        const optional = !required.has(key);
        // null means omission only where the original field cannot itself be null.
        // For nullable optional fields, { value: null } explicitly clears the field.
        const wrapped = optional && schemaAccepts(codec.schema, null);
        const schema = !optional
          ? codec.schema
          : nullable(
              wrapped
                ? {
                    type: 'object',
                    properties: { value: codec.schema },
                    required: ['value'],
                    additionalProperties: false,
                  }
                : codec.schema,
            );
        if (optional)
          schema.description = [
            typeof child.description === 'string' ? child.description : '',
            wrapped
              ? 'Use null to leave this argument omitted. To supply it, use {"value": ...}; {"value": null} supplies an explicit null. Preserve the tool\'s rules for clearing fields.'
              : 'Use null to omit this optional argument. Do not ask the user for an optional value.',
          ]
            .filter(Boolean)
            .join(' ');
        return { key, codec, optional, wrapped, schema };
      });
      return {
        schema: {
          ...base,
          properties: Object.fromEntries(children.map((c) => [c.key, c.schema])),
          required: children.map((c) => c.key),
          additionalProperties: false,
        },
        decode(value) {
          if (!object(value)) throw invalid();
          return Object.fromEntries(
            children.flatMap(({ key, codec, optional, wrapped }) => {
              if (optional && value[key] === null) return [];
              const supplied = wrapped ? (value[key] as Schema).value : value[key];
              return [[key, codec.decode(supplied)]];
            }),
          );
        },
      };
    }
    if (node.type === 'array') {
      if (!object(node.items)) throw unsupported();
      const item = compile(node.items, depth + 1);
      return {
        schema: { ...base, items: item.schema },
        decode: (value) => (value as unknown[]).map((child) => item.decode(child)),
      };
    }
    if (!['string', 'number', 'integer', 'boolean', 'null'].includes(String(node.type)))
      throw unsupported();
    const { const: constant, ...primitive } = base;
    return {
      schema: constant === undefined ? primitive : { ...primitive, enum: [constant] },
      decode: (value) => value,
    };
  };
  const codec = compile(source, 0);
  if (codec.schema.type !== 'object' || codec.schema.anyOf) throw unsupported();
  return {
    schema: codec.schema,
    decode(value) {
      if (!schemaAccepts(codec.schema, value)) throw invalid();
      const decoded = codec.decode(value);
      // Includes original oneOf exclusivity and every business-side constraint.
      if (!schemaAccepts(source, decoded)) throw invalid();
      return decoded;
    },
  };
}
