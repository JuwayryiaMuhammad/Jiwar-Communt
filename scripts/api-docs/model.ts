/**
 * Joins the three sources into one list of operations: the OpenAPI file (what
 * the endpoint takes and returns), the routes read from the controllers (what
 * it demands), and the audience rules.
 */
import {
  classify,
  type Audience,
  type Classification,
  type PermissionCatalog,
} from './audiences';
import { codesInDescription } from './error-codes';
import type { Components, Schema } from './schema';

export const API_PREFIX = '/api/v1';
export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const METHOD_ORDER: Record<string, number> = {
  get: 0,
  post: 1,
  put: 2,
  patch: 3,
  delete: 4,
};

export interface OpenApiParam {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: Schema;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  parameters: OpenApiParam[];
  requestBody?: {
    required?: boolean;
    content: Record<string, { schema?: Schema }>;
  };
  responses: Record<
    string,
    { description?: string; content?: Record<string, { schema?: Schema }> }
  >;
  security?: unknown[];
  'x-no-store'?: boolean;
}

export interface OpenApiDoc {
  info: { title: string; description?: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: Components;
}

export interface RouteMeta {
  method: string;
  path: string;
  controller: string;
  handler: string;
  public: boolean;
  platform: boolean;
  platformAllowsPasswordChange: boolean;
  all: string[];
  any: string[];
  idempotent: boolean;
  idempotentSecret: boolean;
  guards: string[];
}

export interface RoutesFile extends PermissionCatalog {
  routes: RouteMeta[];
  errorCodes: string[];
  fieldErrorCodes: string[];
}

export interface ErrorEntry {
  status: string;
  code: string;
  when: string;
}

export interface Operation {
  key: string;
  method: string;
  /** With the prefix: `/api/v1/units/{unitId}`. */
  fullPath: string;
  /** Without it, `/` for the root. */
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tag: string;
  params: {
    path: OpenApiParam[];
    query: OpenApiParam[];
    header: OpenApiParam[];
  };
  idempotencyKey: boolean;
  body?: { contentType: string; schema: Schema; required: boolean };
  responses: {
    status: string;
    description: string;
    contentType?: string;
    schema?: Schema;
  }[];
  noStore: boolean;
  route: RouteMeta;
  classification: Classification;
  errors: ErrorEntry[];
}

const STATUS_TEXT: Record<string, string> = {
  '200': 'OK',
  '201': 'Created',
  '202': 'Accepted',
  '204': 'No Content',
};
export const statusText = (code: string): string => STATUS_TEXT[code] ?? '';

/** `x-jiwar-install-id` -> `X-Jiwar-Install-Id`. */
export function headerName(name: string): string {
  return name
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('-');
}

const GENERIC = {
  validation:
    'The body, a query value or a path value is malformed. `fields` lists each one.',
  unauthenticated:
    'No access token, or it is expired or revoked. Refresh it or sign in again.',
  forbidden:
    'The account lacks the permission above, or the unit, the compound or the role does not allow it.',
  notFound:
    "The resource does not exist, or it is not the caller's (a foreign id answers as a missing one).",
  idempotency:
    'The same `Idempotency-Key` was already used for a different request.',
  rate: 'Too many requests from this address or for this link or token. Try again later.',
} as const;

export function buildOperations(
  doc: OpenApiDoc,
  routes: RoutesFile,
  errorStatuses: Map<string, number[]>,
  managerCalls?: ReadonlySet<string>,
): Operation[] {
  const byKey = new Map<string, RouteMeta>();
  for (const r of routes.routes) byKey.set(`${r.method} ${r.path}`, r);
  const registry = new Set(routes.errorCodes);

  const ops: Operation[] = [];
  for (const [fullPath, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const route = byKey.get(`${method} ${fullPath}`);
      if (!route) {
        throw new Error(
          `No controller route for ${method.toUpperCase()} ${fullPath}`,
        );
      }
      const path = fullPath.startsWith(API_PREFIX)
        ? fullPath.slice(API_PREFIX.length) || '/'
        : fullPath;
      const classification = classify(
        {
          method,
          path,
          public: route.public,
          platform: route.platform,
          all: route.all,
          any: route.any,
        },
        routes,
        managerCalls,
      );

      const params = {
        path: [] as OpenApiParam[],
        query: [] as OpenApiParam[],
        header: [] as OpenApiParam[],
      };
      let idempotencyKey = false;
      for (const p of op.parameters ?? []) {
        if (p.in === 'header') {
          if (p.name.toLowerCase() === 'idempotency-key') {
            idempotencyKey = true;
            continue;
          }
          params.header.push(p);
        } else if (p.in === 'path' || p.in === 'query') {
          params[p.in].push(p);
        }
      }

      let body: Operation['body'];
      if (op.requestBody) {
        const [contentType, media] =
          Object.entries(op.requestBody.content)[0] ?? [];
        if (contentType) {
          body = {
            contentType,
            schema: media.schema ?? {},
            required: op.requestBody.required === true,
          };
        }
      }

      const responses = Object.entries(op.responses).map(([status, r]) => {
        const [contentType, media] = Object.entries(r.content ?? {})[0] ?? [];
        return {
          status,
          description: r.description ?? '',
          contentType,
          schema: media?.schema,
        };
      });

      const operation: Operation = {
        key: `${method} ${fullPath}`,
        method,
        fullPath,
        path,
        operationId: op.operationId,
        summary: op.summary,
        description: (op.description ?? '').trim(),
        tag: op.tags?.[0] ?? 'other',
        params,
        idempotencyKey,
        body,
        responses,
        noStore: op['x-no-store'] === true,
        route,
        classification,
        errors: [],
      };
      operation.errors = buildErrors(operation, errorStatuses, registry);
      ops.push(operation);
    }
  }

  ops.sort((a, b) =>
    a.path === b.path
      ? METHOD_ORDER[a.method] - METHOD_ORDER[b.method]
      : a.path < b.path
        ? -1
        : 1,
  );
  return ops;
}

function buildErrors(
  op: Operation,
  known: Map<string, number[]>,
  registry: Set<string>,
): ErrorEntry[] {
  const out: ErrorEntry[] = [];
  const c = op.classification;
  const hasInput =
    op.body !== undefined ||
    op.params.query.length > 0 ||
    op.params.path.length > 0;
  if (hasInput)
    out.push({
      status: '400',
      code: 'VALIDATION_FAILED',
      when: GENERIC.validation,
    });
  if (!op.route.public)
    out.push({
      status: '401',
      code: 'UNAUTHENTICATED',
      when: GENERIC.unauthenticated,
    });
  if (
    !op.route.public &&
    (op.route.all.length + op.route.any.length > 0 || op.route.platform)
  ) {
    out.push({ status: '403', code: 'FORBIDDEN', when: GENERIC.forbidden });
  }
  if (op.params.path.length > 0)
    out.push({ status: '404', code: 'NOT_FOUND', when: GENERIC.notFound });
  if (op.idempotencyKey)
    out.push({
      status: '409',
      code: 'IDEMPOTENCY_CONFLICT',
      when: GENERIC.idempotency,
    });
  if (op.route.public || c.basis === 'public')
    out.push({ status: '429', code: 'RATE_LIMITED', when: GENERIC.rate });

  const seen = new Set(out.map((e) => e.code));
  for (const found of codesInDescription(op.description, known, registry)) {
    if (seen.has(found.code)) continue;
    seen.add(found.code);
    out.push({
      status: found.statuses.length ? found.statuses.join(' / ') : '4xx',
      code: found.code,
      when: found.context,
    });
  }
  return out;
}

/** Operations grouped by audience, each with its audience list. */
export function byAudience(ops: Operation[]): Record<Audience, Operation[]> {
  const out = {} as Record<Audience, Operation[]>;
  for (const op of ops) {
    for (const a of op.classification.audiences) {
      (out[a] ??= []).push(op);
    }
  }
  return out;
}
