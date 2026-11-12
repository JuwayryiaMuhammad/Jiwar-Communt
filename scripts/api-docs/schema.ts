/**
 * OpenAPI schema helpers: resolve `$ref`/`allOf`, build an example value, and
 * flatten a schema into table rows. Everything is derived from the contract;
 * nothing here knows an endpoint.
 */

export interface Schema {
  $ref?: string;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  type?: string;
  format?: string;
  enum?: unknown[];
  example?: unknown;
  default?: unknown;
  pattern?: string;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  description?: string;
}

/** A schema with its references followed. `name` is the component it came from. */
export interface Resolved extends Schema {
  name?: string;
  /** Property names that the schema marks required. */
  requiredSet?: Set<string>;
}

export interface Components {
  schemas: Record<string, Schema>;
}

/** Placeholder values; none is real data. */
export const SAMPLE = {
  uuid: '3f2b9c1e-8a4d-4f6e-9b21-7c5d0e8a1f42',
  dateTime: '2026-11-10T09:00:00.000Z',
  date: '2026-11-10',
  email: 'user@example.com',
  uri: 'https://example.com/path',
} as const;

const PATTERN_CANDIDATES = [
  '1250.00',
  '2026-11-10',
  '2026-11',
  '08:00',
  '123456',
  '2026',
  'string',
  'abc',
  'A-1',
  'a1',
  'a_b',
  '0000',
  '+20 000 000 0000',
  '000',
  '1',
  '10.00',
  '1.50',
];

export class SchemaTools {
  constructor(private readonly components: Components) {}

  refName(ref: string): string {
    return ref.replace('#/components/schemas/', '');
  }

  /** Follows `$ref` and merges `allOf` into one flat schema. */
  resolve(schema: Schema | undefined, seen: string[] = []): Resolved {
    if (!schema) return {};
    if (schema.$ref) {
      const name = this.refName(schema.$ref);
      if (seen.includes(name)) return { name, type: 'object' };
      const target = this.components.schemas[name];
      const inner = this.resolve(target, [...seen, name]);
      return {
        ...inner,
        name,
        ...(schema.description && !inner.description
          ? { description: schema.description }
          : {}),
      };
    }
    if (schema.allOf?.length) {
      let merged: Resolved = {};
      for (const part of schema.allOf) {
        const r = this.resolve(part, seen);
        merged = {
          ...merged,
          ...r,
          properties: { ...merged.properties, ...r.properties },
          required: [...(merged.required ?? []), ...(r.required ?? [])],
          name: r.name ?? merged.name,
        };
      }
      const { allOf: _ignored, ...rest } = schema;
      void _ignored;
      return {
        ...merged,
        ...rest,
        properties: { ...merged.properties, ...rest.properties },
        required: [...(merged.required ?? []), ...(rest.required ?? [])],
        name: merged.name,
      };
    }
    return { ...schema };
  }

  private patternExample(pattern: string, minLength?: number): string {
    try {
      const re = new RegExp(pattern);
      for (const candidate of PATTERN_CANDIDATES) {
        if (re.test(candidate)) return candidate;
      }
    } catch {
      /* an engine-specific pattern: fall through */
    }
    return 'x'.repeat(Math.max(1, minLength ?? 6));
  }

  /** An example value for the schema; `depth` and `stack` stop recursion. */
  example(
    schema: Schema | undefined,
    depth = 0,
    stack: string[] = [],
  ): unknown {
    if (!schema) return null;
    let name: string | undefined;
    if (schema.$ref) {
      name = this.refName(schema.$ref);
      if (stack.includes(name)) return this.cycleValue(this.resolve(schema));
    }
    const s = this.resolve(schema);
    const nextStack = name
      ? [...stack, name]
      : s.name && !stack.includes(s.name)
        ? [...stack, s.name]
        : stack;
    if (depth > 7)
      return s.type === 'array' ? [] : s.type === 'object' ? {} : null;

    if (s.example !== undefined) return s.example;
    if (s.enum?.length) return s.enum[0];
    if (s.oneOf?.length) return this.example(s.oneOf[0], depth + 1, nextStack);
    if (s.anyOf?.length) return this.example(s.anyOf[0], depth + 1, nextStack);

    switch (s.type) {
      case 'string':
        return this.stringExample(s);
      case 'integer':
      case 'number': {
        if (s.default !== undefined) return s.default;
        if (typeof s.minimum === 'number' && s.minimum > 0) return s.minimum;
        return 0;
      }
      case 'boolean':
        return s.default !== undefined ? s.default : true;
      case 'array': {
        const item = this.example(s.items, depth + 1, nextStack);
        return item === undefined ? [] : [item];
      }
      case 'object':
      default: {
        if (s.properties && Object.keys(s.properties).length) {
          const out: Record<string, unknown> = {};
          for (const [key, prop] of Object.entries(s.properties)) {
            out[key] = this.example(prop, depth + 1, nextStack);
          }
          return out;
        }
        if (
          s.additionalProperties &&
          typeof s.additionalProperties === 'object'
        ) {
          return {
            key: this.example(s.additionalProperties, depth + 1, nextStack),
          };
        }
        return s.type === 'object' || s.additionalProperties ? {} : null;
      }
    }
  }

  private cycleValue(s: Resolved): unknown {
    return s.type === 'array' ? [] : s.type === 'object' ? {} : null;
  }

  private stringExample(s: Resolved): string {
    if (s.default !== undefined && typeof s.default === 'string')
      return s.default;
    switch (s.format) {
      case 'uuid':
        return SAMPLE.uuid;
      case 'date-time':
        return SAMPLE.dateTime;
      case 'date':
        return SAMPLE.date;
      case 'email':
        return SAMPLE.email;
      case 'uri':
      case 'url':
        return SAMPLE.uri;
      default:
        break;
    }
    if (s.pattern) return this.patternExample(s.pattern, s.minLength);
    const base = 'string';
    if (s.minLength && s.minLength > base.length)
      return 'x'.repeat(s.minLength);
    return base;
  }

  /** `string (uuid)`, `Capacity: a | b`, `Item[]`, nullable marked `| null`. */
  typeLabel(schema: Schema | undefined, raw?: Schema): string {
    const s = this.resolve(schema);
    const nullable = s.nullable === true || raw?.nullable === true;
    let label: string;
    if (s.enum?.length) {
      const values = s.enum.map((v) => `\`${String(v)}\``);
      const shown =
        values.length > 24
          ? [...values.slice(0, 24), `… ${values.length} values`]
          : values;
      label = (s.name ? `${s.name}: ` : '') + shown.join(' \\| ');
    } else if (s.type === 'array') {
      const item = this.typeLabel(s.items);
      label = /\\\|/.test(item) ? `(${item})[]` : `${item}[]`;
    } else if (s.oneOf?.length) {
      label = s.oneOf.map((o) => this.typeLabel(o)).join(' \\| ');
    } else if (s.type === 'object' || s.properties) {
      label = s.name ?? (s.additionalProperties ? 'map' : 'object');
    } else if (s.type) {
      label = s.format ? `${s.type} (${s.format})` : s.type;
    } else {
      label = s.name ?? 'any';
    }
    return nullable ? `${label} \\| null` : label;
  }

  /** The bounds, as short text. */
  limits(schema: Schema | undefined): string {
    const s = this.resolve(schema);
    const out: string[] = [];
    if (s.minLength !== undefined) out.push(`min length ${s.minLength}`);
    if (s.maxLength !== undefined) out.push(`max length ${s.maxLength}`);
    if (s.minimum !== undefined) out.push(`≥ ${s.minimum}`);
    if (s.maximum !== undefined) out.push(`≤ ${s.maximum}`);
    if (s.minItems !== undefined) out.push(`min items ${s.minItems}`);
    if (s.maxItems !== undefined) out.push(`max items ${s.maxItems}`);
    if (s.type === 'array' && s.items) {
      const inner = this.resolve(s.items);
      if (inner.minLength !== undefined)
        out.push(`each min length ${inner.minLength}`);
      if (inner.maxLength !== undefined)
        out.push(`each max length ${inner.maxLength}`);
    }
    if (s.pattern) out.push(`pattern \`${s.pattern.replace(/\|/g, '\\|')}\``);
    if (s.default !== undefined)
      out.push(`default \`${JSON.stringify(s.default)}\``);
    return out.join(', ');
  }

  /**
   * Flattens an object schema into table rows (`a.b[].c`), following nested
   * objects and arrays of objects, and stopping at a reference already on the
   * way down.
   */
  rows(schema: Schema | undefined, max = 500): FieldRow[] {
    const rows: FieldRow[] = [];
    const walk = (
      node: Schema | undefined,
      prefix: string,
      requiredHere: boolean,
      stack: string[],
      raw?: Schema,
    ) => {
      if (rows.length >= max) return;
      const s = this.resolve(node);
      if (prefix) {
        rows.push({
          path: prefix,
          type: this.typeLabel(node, raw),
          required: requiredHere,
          limits: this.limits(node),
          description: (raw?.description ?? s.description ?? '').trim(),
        });
      }
      const recursive = s.name !== undefined && stack.includes(s.name);
      const nextStack = s.name ? [...stack, s.name] : stack;
      if (recursive) return;
      if (s.type === 'array' && s.items) {
        const item = this.resolve(s.items);
        if (item.properties || item.type === 'array' || item.oneOf) {
          walkInner(s.items, `${prefix}[]`, nextStack);
        }
        return;
      }
      if (s.properties) {
        const req = new Set(s.required ?? []);
        for (const [key, prop] of Object.entries(s.properties)) {
          walk(
            prop,
            prefix ? `${prefix}.${key}` : key,
            req.has(key),
            nextStack,
            prop,
          );
        }
      }
    };
    const walkInner = (node: Schema, prefix: string, stack: string[]) => {
      const s = this.resolve(node);
      const recursive = s.name !== undefined && stack.includes(s.name);
      if (recursive) return;
      const nextStack = s.name ? [...stack, s.name] : stack;
      if (s.type === 'array' && s.items) {
        const item = this.resolve(s.items);
        if (item.properties || item.type === 'array')
          walkInner(s.items, `${prefix}[]`, nextStack);
        return;
      }
      if (s.properties) {
        const req = new Set(s.required ?? []);
        for (const [key, prop] of Object.entries(s.properties)) {
          walk(prop, `${prefix}.${key}`, req.has(key), nextStack, prop);
        }
      }
    };
    const root = this.resolve(schema);
    if (root.type === 'array') {
      walkInner(schema as Schema, '', []);
      return rows;
    }
    walk(schema, '', true, []);
    // `walk` with an empty prefix lists the top-level properties itself.
    return rows;
  }
}

export interface FieldRow {
  path: string;
  type: string;
  required: boolean;
  limits: string;
  description: string;
}
