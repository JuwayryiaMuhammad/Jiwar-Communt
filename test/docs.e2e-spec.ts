import { createHttpHarness, type HttpHarness } from './setup/http-app';

interface OpenApi {
  paths: Record<
    string,
    Record<string, { security?: Record<string, unknown>[] }>
  >;
}

describe('Swagger', () => {
  let h: HttpHarness;
  let doc: OpenApi;

  beforeAll(async () => {
    h = await createHttpHarness();
    doc = (await h.http().get('/docs-json').expect(200)).body as OpenApi;
  });

  afterAll(() => h.close());

  it('lists every Phase 0 endpoint', () => {
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        '/api/v1',
        '/api/v1/accounts',
        '/api/v1/accounts/me',
        '/api/v1/accounts/{id}',
        '/api/v1/accounts/{id}/status',
        '/api/v1/auth/logout',
        '/api/v1/auth/otp/request',
        '/api/v1/auth/otp/verify',
        '/api/v1/auth/refresh',
        '/api/v1/auth/select-account',
        '/api/v1/health',
        '/api/v1/units',
        '/api/v1/units/{id}',
      ].sort(),
    );
  });

  it('marks protected endpoints with bearer auth and public ones without', () => {
    for (const [path, ops] of Object.entries(doc.paths)) {
      const isPublic =
        path.startsWith('/api/v1/auth') ||
        path === '/api/v1' ||
        path === '/api/v1/health';
      for (const op of Object.values(ops)) {
        const bearer = (op.security ?? []).some((s) => 'bearer' in s);
        expect({ path, bearer }).toEqual({ path, bearer: !isPublic });
      }
    }
  });
});
