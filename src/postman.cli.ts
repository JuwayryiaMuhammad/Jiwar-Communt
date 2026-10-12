import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stableJson } from './core/common/http/stable-json';

const OPENAPI_FILE = 'docs/api/openapi.v0.json';
export const POSTMAN_FILE = 'docs/api/jiwar.postman_collection.json';

/**
 * `pnpm postman:export`: a Postman collection (v2.1) built from the committed
 * OpenAPI file, so run `pnpm openapi:export` first. One folder per tag; the
 * login requests store their tokens in collection variables, and every other
 * request sends them.
 */

type Schema = {
  $ref?: string;
  allOf?: Schema[];
  type?: string;
  format?: string;
  enum?: unknown[];
  example?: unknown;
  pattern?: string;
  minimum?: number;
  minItems?: number;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  description?: string;
};

type Parameter = {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  description?: string;
  schema?: Schema;
};

type Operation = {
  summary?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { description?: string }>;
  security?: unknown[];
};

type OpenApi = {
  info: { title: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

type Variable = { key: string; value: string; description?: string };
type Auth =
  | { type: 'noauth' }
  | {
      type: 'bearer';
      bearer: { key: 'token'; value: string; type: 'string' }[];
    };
type Event = {
  listen: 'test';
  script: { type: 'text/javascript'; exec: string[] };
};
type Item = {
  name: string;
  request: {
    method: string;
    header: {
      key: string;
      value: string;
      disabled?: boolean;
      description?: string;
    }[];
    url: {
      raw: string;
      host: string[];
      path: string[];
      query?: Variable[];
      variable?: Variable[];
    };
    body?: { mode: 'raw'; raw: string; options: { raw: { language: 'json' } } };
    auth?: Auth;
    description?: string;
  };
  event?: Event[];
};
type Folder = { name: string; item: Item[]; auth?: Auth };

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Folders that lead; the others follow in alphabetical order. */
const FOLDER_ORDER = ['health', 'auth', 'platform', 'me'];

/** The sign-in steps in the order they are sent; the rest keep path order. */
const LOGIN_ORDER = [
  'POST /api/v1/auth/otp/request',
  'POST /api/v1/auth/otp/verify',
  'POST /api/v1/auth/select-account',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
  'POST /api/v1/platform/auth/login',
  'POST /api/v1/platform/auth/change-password',
  'POST /api/v1/platform/auth/refresh',
  'POST /api/v1/platform/auth/logout',
];

function rank(order: string[], key: string): number {
  const i = order.indexOf(key);
  return i === -1 ? order.length : i;
}

const VARIABLES: Variable[] = [
  {
    key: 'baseUrl',
    value: 'http://localhost:3100',
    description: 'The API origin (PORT in .env).',
  },
  {
    key: 'identifier',
    value: '',
    description: 'Email or phone that requests the login code.',
  },
  {
    key: 'otpCode',
    value: '',
    description: 'The 6-digit code from the email (Mailpit locally).',
  },
  {
    key: 'loginTicket',
    value: '',
    description: 'Set by "Verify the login code".',
  },
  {
    key: 'accountId',
    value: '',
    description:
      'Set by "Verify the login code" to the first account; change it to sign in to another.',
  },
  {
    key: 'installId',
    value: '',
    description:
      'X-Jiwar-Install-Id: a UUID the app makes once per install. Empty = a browser.',
  },
  {
    key: 'accessToken',
    value: '',
    description: 'Set by select-account and refresh.',
  },
  {
    key: 'refreshToken',
    value: '',
    description: 'Set by select-account and refresh.',
  },
  {
    key: 'platformEmail',
    value: '',
    description: 'The platform owner (PLATFORM_ADMIN_EMAIL).',
  },
  { key: 'platformPassword', value: '' },
  {
    key: 'platformAccessToken',
    value: '',
    description: 'Set by the platform login, refresh and change-password.',
  },
  {
    key: 'platformRefreshToken',
    value: '',
    description: 'Set by the platform login, refresh and change-password.',
  },
];

/** Bodies whose values come from collection variables. */
const BODIES: Record<string, Record<string, string>> = {
  'POST /api/v1/auth/otp/request': { identifier: '{{identifier}}' },
  'POST /api/v1/auth/otp/verify': {
    identifier: '{{identifier}}',
    code: '{{otpCode}}',
  },
  'POST /api/v1/auth/select-account': {
    loginTicket: '{{loginTicket}}',
    accountId: '{{accountId}}',
  },
  'POST /api/v1/auth/refresh': { refreshToken: '{{refreshToken}}' },
  'POST /api/v1/auth/logout': { refreshToken: '{{refreshToken}}' },
  'POST /api/v1/platform/auth/login': {
    email: '{{platformEmail}}',
    password: '{{platformPassword}}',
  },
  'POST /api/v1/platform/auth/refresh': {
    refreshToken: '{{platformRefreshToken}}',
  },
  'POST /api/v1/platform/auth/logout': {
    refreshToken: '{{platformRefreshToken}}',
  },
};

const SAVE_TOKENS = [
  'if (pm.response.code === 200) {',
  '  const body = pm.response.json();',
  "  pm.collectionVariables.set('accessToken', body.accessToken);",
  "  pm.collectionVariables.set('refreshToken', body.refreshToken);",
  '}',
];

const SAVE_PLATFORM_TOKENS = [
  'if (pm.response.code === 200) {',
  '  const body = pm.response.json();',
  "  pm.collectionVariables.set('platformAccessToken', body.accessToken);",
  "  if (body.refreshToken) pm.collectionVariables.set('platformRefreshToken', body.refreshToken);",
  '}',
];

/** Test scripts that store what a login step returns. */
const SCRIPTS: Record<string, string[]> = {
  'POST /api/v1/auth/otp/verify': [
    'if (pm.response.code === 200) {',
    '  const body = pm.response.json();',
    "  pm.collectionVariables.set('loginTicket', body.loginTicket);",
    "  if (body.accounts.length) pm.collectionVariables.set('accountId', body.accounts[0].accountId);",
    '}',
  ],
  'POST /api/v1/auth/select-account': SAVE_TOKENS,
  'POST /api/v1/auth/refresh': SAVE_TOKENS,
  'POST /api/v1/platform/auth/login': SAVE_PLATFORM_TOKENS,
  'POST /api/v1/platform/auth/refresh': SAVE_PLATFORM_TOKENS,
  'POST /api/v1/platform/auth/change-password': SAVE_PLATFORM_TOKENS,
};

/** Header values: the install id from its variable, a fresh key per send. */
const HEADER_VALUES: Record<string, string> = {
  'x-jiwar-install-id': '{{installId}}',
  'idempotency-key': '{{$guid}}',
};

function bearer(variable: string): Auth {
  return {
    type: 'bearer',
    bearer: [{ key: 'token', value: `{{${variable}}}`, type: 'string' }],
  };
}

function resolveSchema(doc: OpenApi, schema: Schema): Schema {
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop() as string;
    return resolveSchema(doc, doc.components.schemas[name]);
  }
  if (schema.allOf?.length === 1) {
    return resolveSchema(doc, {
      ...schema.allOf[0],
      description: schema.description,
    });
  }
  return schema;
}

/** A placeholder value that passes the field's type checks where it can. */
function sample(doc: OpenApi, raw: Schema, depth = 0): unknown {
  const schema = resolveSchema(doc, raw);
  if (schema.example !== undefined) return schema.example;
  if (schema.enum?.length) return schema.enum[0];
  switch (schema.type) {
    case 'object':
      return depth > 4 ? {} : sampleObject(doc, schema, depth + 1);
    case 'array': {
      const count = schema.minItems ?? 0;
      return schema.items && count
        ? [sample(doc, schema.items, depth + 1)]
        : [];
    }
    case 'number':
    case 'integer':
      return schema.minimum ?? 0;
    case 'boolean':
      return false;
    default:
      if (schema.format === 'date-time') return '2026-01-01T09:00:00.000Z';
      if (schema.format === 'date') return '2026-01-01';
      if (schema.pattern === '^\\d{6}$') return '000000';
      return '';
  }
}

/** The required fields; every field when none is required (a PATCH). */
function sampleObject(
  doc: OpenApi,
  schema: Schema,
  depth: number,
): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const keys = required.length ? required : Object.keys(properties);
  return Object.fromEntries(
    keys.map((key) => [key, sample(doc, properties[key] ?? {}, depth)]),
  );
}

function typeName(doc: OpenApi, raw: Schema): string {
  const schema = resolveSchema(doc, raw);
  if (schema.enum?.length)
    return schema.enum.map((v) => `\`${String(v)}\``).join(' \\| ');
  if (schema.type === 'array')
    return `${schema.items ? typeName(doc, schema.items) : 'any'}[]`;
  return schema.format
    ? `${schema.type ?? 'any'} (${schema.format})`
    : (schema.type ?? 'object');
}

function describe(
  doc: OpenApi,
  op: Operation,
  body: Schema | undefined,
): string {
  const lines: string[] = [];
  if (body) {
    const schema = resolveSchema(doc, body);
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties ?? {});
    if (fields.length) {
      lines.push(
        '**Body**',
        '',
        '| Field | Type | Required | Notes |',
        '|---|---|---|---|',
      );
      for (const [name, field] of fields) {
        const notes = (
          resolveSchema(doc, field).description ??
          field.description ??
          ''
        ).replace(/\n/g, ' ');
        lines.push(
          `| \`${name}\` | ${typeName(doc, field)} | ${required.has(name) ? 'yes' : ''} | ${notes} |`,
        );
      }
      lines.push('');
    }
  }
  lines.push(`**Responses:** ${Object.keys(op.responses).join(', ')}`);
  return lines.join('\n');
}

function toItem(
  doc: OpenApi,
  path: string,
  method: string,
  op: Operation,
): Item {
  const key = `${method.toUpperCase()} ${path}`;
  const segments = path
    .replace(/^\//, '')
    .split('/')
    .map((s) => s.replace(/^\{(.+)\}$/, ':$1'));
  const params = op.parameters ?? [];
  const query = params
    .filter((p) => p.in === 'query')
    .map((p) => ({
      key: p.name,
      value: '',
      description: [p.required ? '(required)' : '', p.description ?? '']
        .join(' ')
        .trim(),
      ...(p.required ? {} : { disabled: true }),
    }));
  const variable = params
    .filter((p) => p.in === 'path')
    .map((p) => ({ key: p.name, value: '', description: p.description ?? '' }));
  const header = params
    .filter((p) => p.in === 'header')
    .map((p) => ({
      key: p.name,
      value: HEADER_VALUES[p.name.toLowerCase()] ?? '',
      description: p.description ?? '',
    }));
  const bodySchema = op.requestBody?.content['application/json']?.schema;
  if (bodySchema)
    header.unshift({
      key: 'Content-Type',
      value: 'application/json',
      description: '',
    });
  const queryString = query
    .filter((q) => !('disabled' in q))
    .map((q) => `${q.key}=${q.value}`);

  const item: Item = {
    name: op.summary ?? key,
    request: {
      method: method.toUpperCase(),
      header,
      url: {
        raw: `{{baseUrl}}/${segments.join('/')}${queryString.length ? `?${queryString.join('&')}` : ''}`,
        host: ['{{baseUrl}}'],
        path: segments,
        ...(query.length ? { query } : {}),
        ...(variable.length ? { variable } : {}),
      },
      description: describe(doc, op, bodySchema),
    },
  };
  if (bodySchema) {
    const value = BODIES[key] ?? sample(doc, bodySchema);
    item.request.body = {
      mode: 'raw',
      raw: JSON.stringify(value, null, 2),
      options: { raw: { language: 'json' } },
    };
  }
  if (!op.security?.length) item.request.auth = { type: 'noauth' };
  if (SCRIPTS[key]) {
    item.event = [
      {
        listen: 'test',
        script: { type: 'text/javascript', exec: SCRIPTS[key] },
      },
    ];
  }
  return item;
}

export function buildCollection(doc: OpenApi): unknown {
  const operations = Object.entries(doc.paths).flatMap(([path, ops]) =>
    METHODS.filter((method) => ops[method]).map(
      (method) => [path, method, ops[method]] as const,
    ),
  );
  operations.sort(
    ([pathA, methodA], [pathB, methodB]) =>
      rank(LOGIN_ORDER, `${methodA.toUpperCase()} ${pathA}`) -
      rank(LOGIN_ORDER, `${methodB.toUpperCase()} ${pathB}`),
  );

  const folders = new Map<string, Folder>();
  for (const [path, method, op] of operations) {
    const tag = op.tags?.[0] ?? 'other';
    const folder = folders.get(tag) ?? { name: tag, item: [] };
    folder.item.push(toItem(doc, path, method, op));
    folders.set(tag, folder);
  }
  const platform = folders.get('platform');
  if (platform) platform.auth = bearer('platformAccessToken');

  const ordered = [...folders.values()].sort(
    (a, b) =>
      rank(FOLDER_ORDER, a.name) - rank(FOLDER_ORDER, b.name) ||
      a.name.localeCompare(b.name),
  );

  return {
    info: {
      name: doc.info.title,
      description: [
        doc.info.description ?? '',
        '',
        `Generated from \`${OPENAPI_FILE}\` by \`pnpm postman:export\`; edit the API, not this file.`,
        '',
        '**Sign in:** set `identifier`, send "Request a login code by email", put the emailed code in `otpCode`, send "Verify the login code" (stores `loginTicket` and the first `accountId`), then "Exchange the login ticket" (stores the tokens). **Platform:** set `platformEmail` and `platformPassword`, then send the platform login.',
      ].join('\n'),
      schema:
        'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: bearer('accessToken'),
    variable: VARIABLES,
    item: ordered,
  };
}

function main(): void {
  const doc = JSON.parse(
    readFileSync(resolve(process.cwd(), OPENAPI_FILE), 'utf8'),
  ) as OpenApi;
  writeFileSync(
    resolve(process.cwd(), POSTMAN_FILE),
    stableJson(buildCollection(doc)),
  );
  console.log(`Wrote ${POSTMAN_FILE}`);
}

main();
