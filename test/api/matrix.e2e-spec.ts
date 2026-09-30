import { newId } from '../../src/core/common/uuid';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import type { Row } from './registry';
import { call, err, fill, paramNames } from './request';
import { ROUTES } from './routes';
import { buildWorld, type World } from './world';

/**
 * The access and input matrix for every endpoint (ADR 0025), generated from
 * the registry: a new endpoint gets these checks by adding its row, and the
 * docs suite fails if an endpoint has no row.
 */
describe('API matrix', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const randomParams = (path: string) =>
    Object.fromEntries(paramNames(path).map((n) => [n, newId()]));

  /** The token of the persona the route is for. */
  const allowed = (r: Row) =>
    r.auth === 'platform'
      ? w.platform.token
      : r.auth === 'tenant'
        ? w.a.tokens[r.as ?? 'manager']
        : undefined;

  const label = (r: Row) => `${r.method} ${r.path || '/'}`;

  describe.each(ROUTES.map((r) => [label(r), r] as const))('%s', (_, r) => {
    if (r.auth !== 'public') {
      it('401 without a token', async () => {
        const res = await call(w, r.method, fill(r.path, randomParams(r.path)));
        expect({ status: res.status, code: err(res).code }).toEqual({
          status: 401,
          code: 'UNAUTHENTICATED',
        });
      });

      it('401 with the other kind of token', async () => {
        const token =
          r.auth === 'tenant' ? w.platform.token : w.a.tokens.manager;
        const res = await call(
          w,
          r.method,
          fill(r.path, randomParams(r.path)),
          {
            token,
          },
        );
        expect({ status: res.status, code: err(res).code }).toEqual({
          status: 401,
          code: 'UNAUTHENTICATED',
        });
      });
    }

    if (r.denied !== 'none') {
      const denied = r.denied;
      it(`403 as ${denied}`, async () => {
        const token =
          denied === 'restricted'
            ? w.platform.restrictedToken
            : w.a.tokens[denied];
        const res = await call(
          w,
          r.method,
          fill(r.path, randomParams(r.path)),
          {
            token,
          },
        );
        expect({ status: res.status, code: err(res).code }).toEqual({
          status: 403,
          code:
            denied === 'restricted' ? 'PASSWORD_CHANGE_REQUIRED' : 'FORBIDDEN',
        });
      });
    }

    if (r.foreign !== 'none') {
      const foreign = r.foreign;
      it(`404 ${foreign.code} for another compound's id`, async () => {
        const res = await call(w, r.method, fill(r.path, foreign.params(w)), {
          token: allowed(r),
          body: foreign.body?.(w),
          query: foreign.query,
        });
        expect({ status: res.status, code: err(res).code }).toEqual({
          status: 404,
          code: foreign.code,
        });
      });
    }

    if (r.invalid !== 'none') {
      const invalid = r.invalid;
      it('400 with the exact field errors', async () => {
        const res = await call(
          w,
          r.method,
          fill(r.path, randomParams(r.path)),
          {
            token: allowed(r),
            body: invalid.body,
            query: invalid.query,
          },
        );
        expect(res.status).toBe(400);
        expect(err(res).fields).toEqual(invalid.fields);
      });
    }

    for (const name of paramNames(r.path)) {
      it(`400 INVALID_UUID on a malformed {${name}}`, async () => {
        // One param at a time (params are validated concurrently), with a
        // valid body so the id is the only error.
        const params = { ...randomParams(r.path), [name]: 'not-a-uuid' };
        const res = await call(w, r.method, fill(r.path, params), {
          token: allowed(r),
          body: r.foreign !== 'none' ? r.foreign.body?.(w) : undefined,
        });
        expect({ status: res.status, fields: err(res).fields }).toEqual({
          status: 400,
          fields: [{ field: name, code: 'INVALID_UUID' }],
        });
      });
    }
  });
});
