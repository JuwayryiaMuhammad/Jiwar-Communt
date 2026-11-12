/**
 * One Postman collection (v2.1) per audience, and the shared environment.
 * Folders are the same sections as the markdown files; "Auth" comes first and
 * its scripts keep the tokens in the environment.
 */
import { createHash } from 'node:crypto';
import type { Audience } from './audiences';
import { AUDIENCE_LABEL, permissionShort } from './markdown';
import { headerName, type Operation } from './model';
import type { SchemaTools } from './schema';

const SCHEMA_URL =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/** A query example as Postman's text: a scalar as is, anything else as JSON. */
function queryValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return `${v}`;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}

/** A stable UUID from a name, so a regenerated file is byte-identical. */
export function stableUuid(name: string): string {
  const h = createHash('sha1').update(`jiwar-api-docs:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface Script {
  listen: 'test' | 'prerequest';
  script: { type: 'text/javascript'; exec: string[] };
}

const script = (listen: Script['listen'], code: string): Script => ({
  listen,
  script: { type: 'text/javascript', exec: code.split('\n') },
});

// ---------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------
const COLLECTION_PRE_REQUEST = `// One install id per environment: the app sends the same UUID on every login,
// so a login from this collection is not flagged as a new device each time.
if (!pm.environment.get('installId')) {
  pm.environment.set('installId', pm.variables.replaceIn('{{$guid}}'));
}
// A fresh Idempotency-Key (UUID) for each send, on the requests that accept one.
if (pm.request.headers.has('Idempotency-Key')) {
  pm.request.headers.upsert({ key: 'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });
}`;

const SAVE_TOKENS = `// Keep the tokens in the environment: every other request sends accessToken.
let body = {};
try { body = pm.response.json(); } catch (e) { /* not JSON: an error page */ }
if (pm.response.code === 200 && body.accessToken) {
  pm.environment.set('accessToken', body.accessToken);
  if (body.refreshToken) pm.environment.set('refreshToken', body.refreshToken);
  pm.test('tokens saved to the environment', () => pm.expect(pm.environment.get('accessToken')).to.be.a('string'));
}`;

const SAVE_TICKET = `// The login ticket and the first account to pick, for POST /auth/select-account.
let body = {};
try { body = pm.response.json(); } catch (e) { /* not JSON: an error page */ }
if (pm.response.code === 200) {
  pm.collectionVariables.set('loginTicket', body.loginTicket);
  const first = (body.accounts || [])[0];
  if (first) pm.collectionVariables.set('accountId', first.accountId);
  pm.test('login ticket saved', () => pm.expect(body.loginTicket).to.be.a('string'));
}`;

const CLEAR_TOKENS = `// Signed out: forget the tokens.
if (pm.response.code === 204) {
  pm.environment.set('accessToken', '');
  pm.environment.set('refreshToken', '');
}`;

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------
function pathParts(op: Operation): string[] {
  return op.fullPath
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith('{') ? `:${seg.slice(1, -1)}` : seg));
}

function describe(op: Operation): string {
  const lines = [`**Permission:** ${permissionShort(op)}`];
  const c = op.classification;
  if (c.accountTypes.length)
    lines.push(`**Account types:** ${c.accountTypes.join(', ')}`);
  if (op.idempotencyKey)
    lines.push(
      '**Idempotency-Key:** accepted (a fresh UUID is sent on every send)',
    );
  if (op.description) lines.push('', op.description);
  return lines.join('\n');
}

type Overrides = {
  /** Replace the generated body (Auth requests use collection variables). */
  body?: unknown;
  noauth?: boolean;
  events?: Script[];
  headers?: { key: string; value: string; description?: string }[];
};

function buildItem(
  tools: SchemaTools,
  op: Operation,
  o: Overrides = {},
): Record<string, unknown> {
  const header: {
    key: string;
    value: string;
    description?: string;
    disabled?: boolean;
  }[] = [];
  if (op.body) header.push({ key: 'Content-Type', value: op.body.contentType });
  if (op.idempotencyKey) {
    header.push({
      key: 'Idempotency-Key',
      value: '{{$guid}}',
      description: 'A fresh UUID per send (collection pre-request script).',
    });
  }
  for (const h of op.params.header) {
    header.push({
      key: headerName(h.name),
      value:
        h.name.toLowerCase() === 'x-jiwar-install-id' ? '{{installId}}' : '',
      description: h.description,
      disabled: !h.required && h.name.toLowerCase() !== 'x-jiwar-install-id',
    });
  }
  header.push(...(o.headers ?? []));

  const query = op.params.query.map((q) => ({
    key: q.name,
    value: queryValue(tools.example(q.schema)),
    description: q.description ?? tools.resolve(q.schema).description ?? '',
    disabled: q.required !== true,
  }));
  const variable = op.params.path.map((p) => ({
    key: p.name,
    value: p.name === 'compoundId' ? '{{compoundId}}' : '',
    description: p.description ?? '',
  }));
  const parts = pathParts(op);
  const search = query
    .filter((q) => !q.disabled)
    .map((q) => `${q.key}=${q.value}`)
    .join('&');
  const raw = `{{baseUrl}}/${parts.join('/')}${search ? `?${search}` : ''}`;

  const request: Record<string, unknown> = {
    method: op.method.toUpperCase(),
    header,
    url: {
      raw,
      host: ['{{baseUrl}}'],
      path: parts,
      ...(query.length ? { query } : {}),
      ...(variable.length ? { variable } : {}),
    },
    description: describe(op),
  };
  if (op.body) {
    const value = o.body !== undefined ? o.body : tools.example(op.body.schema);
    request.body = {
      mode: 'raw',
      raw: JSON.stringify(value, null, 2),
      options: { raw: { language: 'json' } },
    };
  }
  if (op.route.public || o.noauth) request.auth = { type: 'noauth' };

  const item: Record<string, unknown> = {
    name: op.summary,
    request,
    response: [],
  };
  if (o.events?.length) item.event = o.events;
  return item;
}

/** What each sign-in request does, by path. */
function authOverrides(op: Operation): Overrides {
  switch (op.path) {
    case '/auth/otp/verify':
      return { events: [script('test', SAVE_TICKET)], noauth: true };
    case '/auth/select-account':
      return {
        body: { loginTicket: '{{loginTicket}}', accountId: '{{accountId}}' },
        events: [script('test', SAVE_TOKENS)],
        noauth: true,
      };
    case '/auth/refresh':
    case '/platform/auth/refresh':
      return {
        body: { refreshToken: '{{refreshToken}}' },
        events: [script('test', SAVE_TOKENS)],
        noauth: true,
      };
    case '/auth/logout':
    case '/platform/auth/logout':
      return {
        body: { refreshToken: '{{refreshToken}}' },
        events: [script('test', CLEAR_TOKENS)],
        noauth: true,
      };
    case '/platform/auth/login':
      return { events: [script('test', SAVE_TOKENS)], noauth: true };
    case '/platform/auth/change-password':
      return { events: [script('test', SAVE_TOKENS)] };
    default:
      return { noauth: op.route.public };
  }
}

const AUTH_ORDER = [
  '/auth/otp/request',
  '/auth/otp/verify',
  '/auth/select-account',
  '/auth/refresh',
  '/auth/logout',
  '/platform/auth/login',
  '/platform/auth/refresh',
  '/platform/auth/logout',
  '/platform/auth/change-password',
  '/public/partner-desk/lookup',
];

/** The operations that make up the "Auth" folder of an audience. */
export function authOperations(
  audience: Audience,
  ops: Operation[],
): Operation[] {
  const wanted =
    audience === 'platform'
      ? AUTH_ORDER.filter((p) => p.startsWith('/platform/auth'))
      : audience === 'partner'
        ? ['/public/partner-desk/lookup']
        : AUTH_ORDER.filter((p) => p.startsWith('/auth/'));
  return wanted
    .map((p) => ops.find((op) => op.path === p))
    .filter((x): x is Operation => !!x);
}

const AUTH_DESCRIPTION: Record<string, string> = {
  platform:
    'Platform owner sign-in: email and password. The login, refresh and change-password responses save accessToken and refreshToken to the environment.',
  partner:
    "A partner has no sign-in: the desk opens from the link the compound sends. Put the link's token in the body and send the lookup first.",
  public:
    'Sign-in for the app users: request a code, verify it (saves the login ticket), then select-account (saves the tokens to the environment). Refresh and logout keep the tokens current.',
  default:
    'Run in order: otp/request, otp/verify (saves the login ticket and the first account), select-account (saves accessToken and refreshToken to the environment), then any request below. Refresh renews the tokens; logout clears them.',
};

export interface CollectionInput {
  audience: Audience;
  sha: string;
  /** Sections in file order, each with its operations (Auth ops excluded). */
  folders: { title: string; description: string; ops: Operation[] }[];
  authOps: Operation[];
}

export function buildCollection(
  tools: SchemaTools,
  input: CollectionInput,
): Record<string, unknown> {
  const label = AUDIENCE_LABEL[input.audience];
  const auth = {
    name: 'Auth',
    description: AUTH_DESCRIPTION[input.audience] ?? AUTH_DESCRIPTION.default,
    item: input.authOps.map((op) => buildItem(tools, op, authOverrides(op))),
  };
  const folders = input.folders
    .filter((f) => f.ops.length)
    .map((f) => ({
      name: f.title,
      description: f.description,
      item: f.ops.map((op) => buildItem(tools, op, authOverrides(op))),
    }));
  const count =
    input.authOps.length + input.folders.reduce((n, f) => n + f.ops.length, 0);
  return {
    info: {
      _postman_id: stableUuid(`collection:${input.audience}`),
      name: `Jiwar API - ${label}`,
      description:
        `Jiwar ${label.toLowerCase()} API: ${count} requests. Generated by \`pnpm api-docs\` from main@${input.sha}; ` +
        'import jiwar.postman_environment.json too, set baseUrl, then run the Auth folder first.',
      schema: SCHEMA_URL,
    },
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }],
    },
    event: [script('prerequest', COLLECTION_PRE_REQUEST)],
    variable: [
      { key: 'loginTicket', value: '' },
      { key: 'accountId', value: '' },
    ],
    item: [auth, ...folders],
  };
}

export function buildEnvironment(sha: string): Record<string, unknown> {
  const values = [
    [
      'baseUrl',
      'default',
      'API host, without /api/v1 (for example http://localhost:3100).',
    ],
    ['accessToken', 'secret', 'Set by the Auth scripts.'],
    ['refreshToken', 'secret', 'Set by the Auth scripts.'],
    [
      'installId',
      'default',
      'A UUID per install; filled on the first request.',
    ],
    ['compoundId', 'default', 'The compound id, for the routes that name one.'],
  ] as const;
  return {
    id: stableUuid('environment'),
    name: 'Jiwar',
    values: values.map(([key, type]) => ({
      key,
      value: '',
      type,
      enabled: true,
    })),
    _postman_variable_scope: 'environment',
    _jiwar_source: `Generated by pnpm api-docs from main@${sha}`,
  };
}

/** Structural checks for a v2.1 collection; returns the problems found. */
export function validateCollection(
  collection: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  const info = collection.info as Record<string, unknown> | undefined;
  if (!info || info.schema !== SCHEMA_URL)
    problems.push('info.schema is not the v2.1.0 schema URL');
  if (!info?.name) problems.push('info.name missing');
  const walk = (items: unknown, where: string) => {
    if (!Array.isArray(items)) {
      problems.push(`${where}: item is not an array`);
      return;
    }
    for (const it of items as Record<string, unknown>[]) {
      const name = typeof it.name === 'string' ? it.name : '';
      if (!name) problems.push(`${where}: an item has no name`);
      if (it.item) {
        walk(it.item, `${where}/${name}`);
      } else {
        const req = it.request as Record<string, unknown> | undefined;
        if (!req) {
          problems.push(`${where}/${name}: no request`);
          continue;
        }
        const url = req.url as Record<string, unknown> | undefined;
        if (typeof req.method !== 'string')
          problems.push(`${where}/${name}: no method`);
        if (!url || typeof url.raw !== 'string' || !Array.isArray(url.path)) {
          problems.push(`${where}/${name}: bad url`);
        }
        const body = req.body as { mode?: string; raw?: string } | undefined;
        if (body?.mode === 'raw') {
          try {
            JSON.parse(body.raw ?? '');
          } catch {
            problems.push(`${where}/${name}: body is not JSON`);
          }
        }
      }
    }
  };
  walk(collection.item, 'collection');
  return problems;
}
