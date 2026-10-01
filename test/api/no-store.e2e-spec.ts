import type { Response } from 'supertest';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { hashPassword } from '../../src/core/platform/password';
import { bornYearsAgo, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';
import { call } from './request';
import { ROUTES } from './routes';
import { inviteBody, minorBody } from './routes/household';
import { passBody } from './routes/visitors';
import { workerBody } from './routes/workers';
import { buildWorld, type World } from './world';

/**
 * Every response that carries a secret shown once (ADR 0025) is
 * `Cache-Control: no-store`: each registry row marked `noStore` is called
 * for real, successfully, here.
 */
describe('API v0 — no-store', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const body = <T>(res: Response) => res.body as T;

  async function login(): Promise<{
    verify: Response;
    select: Response;
    refresh: Response;
  }> {
    const person = await w.helpers.resident(w.a, [w.a.homeUnitId], 'tenant');
    const since = new Date();
    await call(w, 'POST', '/auth/otp/request', {
      body: { identifier: person.email },
    }).expect(202);
    const code = await waitForOtp(person.email, since);
    const verify = await call(w, 'POST', '/auth/otp/verify', {
      body: { identifier: person.email, code },
    });
    const select = await call(w, 'POST', '/auth/select-account', {
      body: {
        loginTicket: body<{ loginTicket: string }>(verify).loginTicket,
        accountId: person.id,
      },
    });
    const refresh = await call(w, 'POST', '/auth/refresh', {
      body: {
        refreshToken: body<{ refreshToken: string }>(select).refreshToken,
      },
    });
    return { verify, select, refresh };
  }

  async function platform(mustChangePassword: boolean) {
    const email = `admin-${uniqueSuffix()}@jiwar.test`;
    await h.moduleRef.get(GlobalDbService).platformAdmin.create({
      data: {
        id: newId(),
        email,
        passwordHash: await hashPassword('no-store-password-1'),
        mustChangePassword,
      },
    });
    return call(w, 'POST', '/platform/auth/login', {
      body: { email, password: 'no-store-password-1' },
    });
  }

  async function activeEngagement() {
    const reg = await call(w, 'POST', `/units/${w.a.homeUnitId}/workers`, {
      token: w.a.tokens.owner,
      body: workerBody(),
    }).expect(201);
    const id = body<{ engagementId: string }>(reg).engagementId;
    const review = await call(w, 'POST', `/worker-engagements/${id}/review`, {
      token: w.a.tokens.manager,
      body: { decision: 'approve' },
    });
    return { id, review };
  }

  /** A live visitor link's token (ADR 0030): the fragment of `link`. */
  async function linkToken(): Promise<string> {
    const pass = await call(
      w,
      'POST',
      `/units/${w.a.homeUnitId}/visitor-passes`,
      { token: w.a.tokens.owner, body: passBody() },
    ).expect(201);
    return body<{ link: string }>(pass).link.split('#')[1];
  }

  const CALLS: Record<string, () => Promise<Response>> = {
    'POST /auth/otp/verify': async () => (await login()).verify,
    'POST /auth/select-account': async () => (await login()).select,
    'POST /auth/refresh': async () => (await login()).refresh,
    'POST /platform/auth/login': () => platform(false),
    'POST /platform/auth/change-password': async () => {
      const restricted = body<{ accessToken: string }>(
        await platform(true),
      ).accessToken;
      return call(w, 'POST', '/platform/auth/change-password', {
        token: restricted,
        body: {
          currentPassword: 'no-store-password-1',
          newPassword: 'no-store-password-2',
        },
      });
    },
    'POST /platform/auth/refresh': async () =>
      call(w, 'POST', '/platform/auth/refresh', {
        body: {
          refreshToken: body<{ refreshToken: string }>(await platform(false))
            .refreshToken,
        },
      }),
    'POST /registration-links': () =>
      call(w, 'POST', '/registration-links', { token: w.a.tokens.manager }),
    'POST /units/{unitId}/household/invites': () =>
      call(w, 'POST', `/units/${w.a.homeUnitId}/household/invites`, {
        token: w.a.tokens.owner,
        body: inviteBody(),
      }),
    'POST /household/members/{id}/majority-invite': async () => {
      const minor = await call(
        w,
        'POST',
        `/units/${w.a.homeUnitId}/household/minors`,
        {
          token: w.a.tokens.owner,
          body: minorBody(),
        },
      ).expect(201);
      const id = body<{ id: string }>(minor).id;
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.householdMember.update({
          where: { id },
          data: { birthDate: bornYearsAgo(18, 1) },
        }),
      );
      return call(w, 'POST', `/household/members/${id}/majority-invite`, {
        token: w.a.tokens.owner,
        body: { email: uniqueEmail('adult'), phone: uniquePhone() },
      });
    },
    'POST /worker-engagements/{id}/review': async () =>
      (await activeEngagement()).review,
    'POST /worker-engagements/{id}/resume': async () => {
      const { id } = await activeEngagement();
      await call(w, 'POST', `/worker-engagements/${id}/suspend`, {
        token: w.a.tokens.owner,
        body: { reasonCode: 'leave', reason: 'Away' },
      }).expect(204);
      return call(w, 'POST', `/worker-engagements/${id}/resume`, {
        token: w.a.tokens.owner,
      });
    },
    'POST /worker-engagements/{id}/reissue-code': async () => {
      const { id } = await activeEngagement();
      return call(w, 'POST', `/worker-engagements/${id}/reissue-code`, {
        token: w.a.tokens.owner,
        body: { reasonCode: 'lost' },
      });
    },
    'POST /worker-engagements/{id}/card-incident': async () => {
      const { id } = await activeEngagement();
      return call(w, 'POST', `/worker-engagements/${id}/card-incident`, {
        token: w.a.tokens.manager,
        body: { type: 'confiscated' },
      });
    },
    'POST /units/{unitId}/visitor-passes': () =>
      call(w, 'POST', `/units/${w.a.homeUnitId}/visitor-passes`, {
        token: w.a.tokens.owner,
        body: passBody(),
      }),
    'POST /public/visitor-passes/lookup': async () =>
      call(w, 'POST', '/public/visitor-passes/lookup', {
        body: { token: await linkToken() },
      }),
    'POST /public/visitor-passes/not-me': async () =>
      call(w, 'POST', '/public/visitor-passes/not-me', {
        body: { token: await linkToken() },
      }),
    'POST /visitor-passes/{id}/reissue-link': async () => {
      const pass = await call(
        w,
        'POST',
        `/units/${w.a.homeUnitId}/visitor-passes`,
        { token: w.a.tokens.owner, body: passBody() },
      ).expect(201);
      return call(
        w,
        'POST',
        `/visitor-passes/${body<{ id: string }>(pass).id}/reissue-link`,
        { token: w.a.tokens.owner },
      );
    },
  };

  const secretRows = ROUTES.filter((r) => r.noStore).map(
    (r) => `${r.method} ${r.path}`,
  );

  it('has a real call for every no-store row', () => {
    expect(Object.keys(CALLS).sort()).toEqual([...secretRows].sort());
  });

  it.each(secretRows)('%s answers no-store', async (key) => {
    const res = await CALLS[key]();
    expect({
      key,
      status: res.status < 300,
      cache: res.headers['cache-control'],
    }).toEqual({
      key,
      status: true,
      cache: 'no-store',
    });
  });

  it('a response without a secret is not marked', async () => {
    const res = await call(w, 'GET', '/me', { token: w.a.tokens.owner }).expect(
      200,
    );
    expect(res.headers['cache-control']).toBeUndefined();
  });
});
