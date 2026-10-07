import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApiDocument } from '../../src/app.setup';
import { stableJson } from '../../src/core/common/http/stable-json';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { ROUTES } from './routes';

interface Parameter {
  in: string;
  name: string;
  required?: boolean;
}

interface Operation {
  tags?: string[];
  parameters?: Parameter[];
  security?: Record<string, unknown>[];
  'x-stability'?: string;
  'x-no-store'?: boolean;
}

interface OpenApi {
  paths: Record<string, Record<string, Operation>>;
}

const PREFIX = '/api/v1';
/** The only headers of the contract, both optional. */
const HEADERS = ['Idempotency-Key', 'x-jiwar-install-id'];

/** Swagger is the contract of API v0 (ADR 0025). */
describe('API docs', () => {
  let h: HttpHarness;
  let doc: OpenApi;

  beforeAll(async () => {
    h = await createHttpHarness();
    doc = (await h.http().get('/docs-json').expect(200)).body as OpenApi;
  });

  afterAll(() => h.close());

  const operations = () =>
    Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.entries(ops).map(([method, op]) => ({
        key: `${method.toUpperCase()} ${path.slice(PREFIX.length)}`,
        op,
      })),
    );

  it('has exactly one registry row per endpoint', () => {
    const rows = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(rows).size).toBe(rows.length);
    expect(
      operations()
        .map((o) => o.key)
        .sort(),
    ).toEqual(rows.sort());
  });

  it('gives every row with an id in its path a foreign-id case', () => {
    // The malformed-id check reuses that case's valid body.
    const missing = ROUTES.filter(
      (r) => r.path.includes('{') && r.foreign === 'none',
    ).map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('marks every operation as a draft, with one area tag', () => {
    for (const { key, op } of operations()) {
      expect({
        key,
        stability: op['x-stability'],
        tags: op.tags?.length,
      }).toEqual({ key, stability: 'draft', tags: 1 });
    }
  });

  it('requires bearer auth exactly where the registry says', () => {
    const byKey = new Map(ROUTES.map((r) => [`${r.method} ${r.path}`, r]));
    for (const { key, op } of operations()) {
      const bearer = (op.security ?? []).some((s) => 'bearer' in s);
      expect({ key, bearer }).toEqual({
        key,
        bearer: byKey.get(key)?.auth !== 'public',
      });
    }
  });

  it('documents no-store exactly on the responses that carry a secret', () => {
    const byKey = new Map(ROUTES.map((r) => [`${r.method} ${r.path}`, r]));
    for (const { key, op } of operations()) {
      expect({ key, noStore: op['x-no-store'] === true }).toEqual({
        key,
        noStore: byKey.get(key)?.noStore === true,
      });
    }
  });

  it('declares no header outside the allowlist, and none required', () => {
    // `@Headers('user-agent')` once made Swagger demand a header no browser
    // can set: a header the server only reads is `@RequestHeader`.
    const offending = operations().flatMap(({ key, op }) =>
      (op.parameters ?? [])
        .filter(
          (p) =>
            p.in === 'header' &&
            (!HEADERS.includes(p.name) || p.required === true),
        )
        .map((p) => `${key} ${p.name}${p.required ? ' (required)' : ''}`),
    );
    expect(offending).toEqual([]);
  });

  it('matches the committed docs/api/openapi.v0.json (run `pnpm openapi:export`)', () => {
    const committed = readFileSync(
      resolve(__dirname, '../../docs/api/openapi.v0.json'),
      'utf8',
    );
    expect(stableJson(buildOpenApiDocument(h.app))).toBe(committed);
  });
});
