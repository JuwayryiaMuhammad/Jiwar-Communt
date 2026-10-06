import type { Response } from 'supertest';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { ParcelTokens } from '../../src/gate/parcels/parcel-tokens';
import { hashPassword } from '../../src/core/platform/password';
import { fileHelpers } from '../setup/files';
import { parcelHelpers } from '../setup/parcels';
import { bornYearsAgo, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { buildExports } from '../setup/exports';
import { waitForMessage, waitForOtp } from '../setup/mailpit';
import { drainOutbox } from '../setup/outbox';
import { call } from './request';
import { ROUTES } from './routes';
import { inviteBody, minorBody } from './routes/household';
import { ticketBody } from './routes/maintenance';
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

  /**
   * An assisted export of A's tenant (ADR 0036), built, and the link its
   * email carries (once per suite).
   */
  let assisted: Promise<{ token: string; email: string }> | null = null;
  const assistedLink = () =>
    (assisted ??= (async () => {
      const email = (
        await w.helpers.asManager(w.a, () =>
          w.helpers.prisma.tenant.account.findUniqueOrThrow({
            where: { id: w.a.ids.tenant },
          }),
        )
      ).email!;
      const since = new Date();
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.dataExport.create({
          data: {
            id: newId(),
            tenantId: w.a.tenantId,
            accountId: w.a.ids.tenant,
            requestedByAccountId: w.a.ids.manager,
            assisted: true,
            assistReasonCode: 'in_person',
            delivery: 'email',
          },
        }),
      );
      await buildExports(h);
      await drainOutbox(h);
      const message = await waitForMessage(email, since);
      const token = /\/a\/export#([0-9a-f-]{36}\.[0-9a-f]{64})/.exec(
        message.Text,
      )![1];
      return { token, email };
    })());

  /** A ticket the owner opened on their home. */
  async function aTicket(): Promise<string> {
    const res = await call(w, 'POST', '/tickets', {
      token: w.a.tokens.owner,
      body: ticketBody(w.a.homeUnitId, w.aCategoryId),
    }).expect(201);
    return body<{ id: string }>(res).id;
  }

  /** A parcel the guard received for A's home. */
  async function aParcel(): Promise<string> {
    const unit = await w.helpers.unitRow(w.a, w.a.homeUnitId);
    const res = await parcelHelpers(h).receive(w.a.tokens.guard, unit.code);
    return body<{ id: string }>(res).id;
  }

  /** A ticket of A's home, assigned, with a visit soon; `confirmed` agrees to it. */
  async function aVisit(
    confirmed = false,
  ): Promise<{ ticketId: string; visitId: string }> {
    const ticketId = await aTicket();
    await call(w, 'POST', `/maintenance/tickets/${ticketId}/assign`, {
      token: w.a.tokens.manager,
      body: { technicianId: w.a.ids.technician },
    }).expect(204);
    const start = Date.now() + 20 * 60_000;
    const visit = await call(
      w,
      'POST',
      `/technician/tickets/${ticketId}/visits`,
      {
        token: w.a.tokens.technician,
        body: {
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + 3_600_000).toISOString(),
        },
      },
    ).expect(201);
    const visitId = body<{ id: string }>(visit).id;
    if (confirmed)
      await call(w, 'POST', `/tickets/${ticketId}/visits/${visitId}/confirm`, {
        token: w.a.tokens.owner,
      }).expect(204);
    return { ticketId, visitId };
  }

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
    // A resident's parcels carry the label, the photos and the codes (ADR 0035).
    'GET /me/parcels': async () => {
      await aParcel();
      return call(w, 'GET', '/me/parcels', { token: w.a.tokens.owner });
    },
    'GET /me/parcels/{id}': async () =>
      call(w, 'GET', `/me/parcels/${await aParcel()}`, {
        token: w.a.tokens.owner,
      }),
    'POST /me/parcels/{id}/reject': async () =>
      call(w, 'POST', `/me/parcels/${await aParcel()}/reject`, {
        token: w.a.tokens.owner,
        body: { reasonCode: 'other' },
      }),
    'POST /me/parcels/{id}/delegate': async () =>
      call(w, 'POST', `/me/parcels/${await aParcel()}/delegate`, {
        token: w.a.tokens.owner,
        body: { name: 'Karim' },
      }),
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
    'GET /worker-engagements/{id}': () =>
      call(w, 'GET', `/worker-engagements/${w.bEngagementId}`, {
        token: w.b.tokens.manager,
      }),
    'POST /gate/verify': () =>
      call(w, 'POST', '/gate/verify', {
        token: w.a.tokens.guard,
        body: { code: '00000000' },
      }),
    // A parcel's lookup names a delegate; its hand-over answers with the name too
    // (ADR 0035).
    'POST /gate/parcels/lookup': () =>
      call(w, 'POST', '/gate/parcels/lookup', {
        token: w.a.tokens.guard,
        body: { code: '000000' },
      }),
    'POST /gate/parcels/{id}/handover': async () => {
      const id = await aParcel();
      const holder = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.parcelCredential.findFirstOrThrow({
          where: { parcelId: id, kind: 'holder' },
        }),
      );
      const { code } = h.moduleRef
        .get(ParcelTokens)
        .secretOf(w.a.tenantId, holder.id, holder.attempt);
      return call(w, 'POST', `/gate/parcels/${id}/handover`, {
        token: w.a.tokens.guard,
        body: { code },
      });
    },
    // Presigned URLs (ADR 0029): an upload target, a read URL.
    'POST /files/uploads': () =>
      call(w, 'POST', '/files/uploads', {
        token: w.a.tokens.owner,
        body: { purpose: 'worker_photo', contentType: 'image/png', size: 10 },
      }),
    // The entry credential's secret, once (ADR 0031).
    'POST /me/entry-credentials': () =>
      call(w, 'POST', '/me/entry-credentials', {
        token: w.a.tokens.tenant,
        body: {},
      }),
    'GET /me': async () => call(w, 'GET', '/me', { token: w.a.tokens.owner }),
    // A ticket's detail carries its photos' presigned URLs (ADR 0032).
    'GET /tickets/{id}': async () =>
      call(w, 'GET', `/tickets/${await aTicket()}`, {
        token: w.a.tokens.owner,
      }),
    'GET /technician/tickets/{id}': async () => {
      const id = await aTicket();
      await call(w, 'POST', `/maintenance/tickets/${id}/assign`, {
        token: w.a.tokens.manager,
        body: { technicianId: w.a.ids.technician },
      }).expect(204);
      return call(w, 'GET', `/technician/tickets/${id}`, {
        token: w.a.tokens.technician,
      });
    },
    'GET /maintenance/tickets/{id}': async () =>
      call(w, 'GET', `/maintenance/tickets/${await aTicket()}`, {
        token: w.a.tokens.manager,
      }),
    'GET /tickets/{id}/visits': async () =>
      call(w, 'GET', `/tickets/${(await aVisit()).ticketId}/visits`, {
        token: w.a.tokens.owner,
      }),
    'GET /technician/tickets/{id}/visits': async () =>
      call(
        w,
        'GET',
        `/technician/tickets/${(await aVisit()).ticketId}/visits`,
        { token: w.a.tokens.technician },
      ),
    'POST /technician/tickets/{id}/visits/{visitId}/arrive': async () => {
      const { ticketId, visitId } = await aVisit(true);
      return call(
        w,
        'POST',
        `/technician/tickets/${ticketId}/visits/${visitId}/arrive`,
        { token: w.a.tokens.technician },
      );
    },
    'GET /maintenance/tickets/{id}/visits': async () =>
      call(
        w,
        'GET',
        `/maintenance/tickets/${(await aVisit()).ticketId}/visits`,
        { token: w.a.tokens.manager },
      ),
    'GET /me/units/{unitId}/visits': async () => {
      await aVisit();
      return call(w, 'GET', `/me/units/${w.a.homeUnitId}/visits`, {
        token: w.a.tokens.owner,
      });
    },
    'GET /files/{id}': async () =>
      call(w, 'GET', `/files/${await fileHelpers(h).ready(w.a.tokens.owner)}`, {
        token: w.a.tokens.owner,
      }), // A parcel's photos, as short-lived URLs (ADR 0035).
    'GET /gate/parcels/{id}': async () =>
      call(w, 'GET', `/gate/parcels/${await aParcel()}`, {
        token: w.a.tokens.guard,
      }),
    // Personal-data export (ADR 0036): the archive's presigned URL.
    'GET /me/data-exports/{id}/download': async () => {
      const id = newId();
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.dataExport.create({
          data: {
            id,
            tenantId: w.a.tenantId,
            accountId: w.a.ids.owner,
            requestedByAccountId: w.a.ids.owner,
            delivery: 'in_app',
          },
        }),
      );
      await buildExports(h);
      return call(w, 'GET', `/me/data-exports/${id}/download`, {
        token: w.a.tokens.owner,
      });
    },
    'POST /public/data-exports/code': async () =>
      call(w, 'POST', '/public/data-exports/code', {
        body: { token: (await assistedLink()).token },
      }),
    'POST /public/data-exports/download': async () => {
      const { token, email } = await assistedLink();
      const since = new Date();
      await call(w, 'POST', '/public/data-exports/code', {
        body: { token },
      }).expect(202);
      return call(w, 'POST', '/public/data-exports/download', {
        body: { token, code: await waitForOtp(email, since) },
      });
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
    const res = await call(w, 'GET', '/me/units', {
      token: w.a.tokens.owner,
    }).expect(200);
    expect(res.headers['cache-control']).toBeUndefined();
  });
});
