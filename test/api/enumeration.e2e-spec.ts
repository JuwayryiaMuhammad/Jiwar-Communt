import type { Response } from 'supertest';
import { HouseholdsService } from '../../src/community/households/households.service';
import { RegistrationService } from '../../src/community/residents/registration.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { bornYearsAgo, nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';
import { call } from './request';
import { buildWorld, type World } from './world';

/**
 * Enumeration over HTTP (ADR 0016, 0024): the public registration and
 * invite paths answer every input with the same status, headers and body.
 * Only `requestId` and `timestamp` differ between error bodies, by design
 * (ADR 0013); they are removed before comparing, and nothing else is.
 */
describe('API v0 — enumeration', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  /** Status, the headers a client sees, and the body text, minus per-request ids. */
  function shape(res: Response): string {
    let body = '';
    if (res.text) {
      const parsed = JSON.parse(res.text) as Record<string, unknown>;
      delete parsed.requestId;
      delete parsed.timestamp;
      body = JSON.stringify(parsed);
    }
    return JSON.stringify({
      status: res.status,
      type: res.headers['content-type'],
      length: res.headers['content-length'],
      cache: res.headers['cache-control'] ?? null,
      body,
    });
  }

  const same = (responses: Response[]) =>
    expect(new Set(responses.map(shape)).size).toBe(1);

  it('self-registration: the same answer whatever the link, unit or phone', async () => {
    const registrations = h.moduleRef.get(RegistrationService);
    const { token: link } = await w.helpers.asManager(w.a, () =>
      registrations.createLink(),
    );
    const { id: revokedId, token: revoked } = await w.helpers.asManager(
      w.a,
      () => registrations.createLink(),
    );
    await w.helpers.asManager(w.a, () => registrations.revokeLink(revokedId));
    const home = await w.helpers.unit(w.a);
    const withPrimary = await w.helpers.unit(w.a);
    const taken = await w.helpers.resident(w.a, [withPrimary.id]);

    const request = (
      linkToken: string,
      unitCode: string,
      over: object = {},
    ) => ({
      linkToken,
      fullName: `Registrant ${uniqueSuffix()}`,
      unitCode,
      phone: uniquePhone(),
      email: uniqueEmail('enum'),
      idDocumentType: 'national_id',
      idDocumentNumber: nationalIdFor(),
      occupancyType: 'owner',
      ...over,
    });
    const inputs = [
      request(link, home.code),
      request(link, `NOPE-${uniqueSuffix()}`),
      request(link, withPrimary.code),
      request(link, home.code, { phone: taken.phone }),
      request(revoked, home.code),
      request(`unknown-${uniqueSuffix()}`, home.code),
    ];

    const started: Response[] = [];
    const completed: Response[] = [];
    const wrong: Response[] = [];
    for (const input of inputs) {
      const since = new Date();
      started.push(
        await call(w, 'POST', '/registrations/start', { body: input }),
      );
      const code = await waitForOtp(input.email, since);
      wrong.push(
        await call(w, 'POST', '/registrations/complete', {
          body: { ...input, code: code === '000000' ? '111111' : '000000' },
        }),
      );
      completed.push(
        await call(w, 'POST', '/registrations/complete', {
          body: { ...input, code },
        }),
      );
    }
    same(started);
    same(completed);
    same(wrong);
    expect(started[0].status).toBe(202);
    expect(completed[0].status).toBe(202);
    expect(wrong[0].status).toBe(401);
  });

  it('invite acceptance: the same answer for a live, used, revoked, expired or unknown token', async () => {
    const households = h.moduleRef.get(HouseholdsService);
    const asOwner = <T>(fn: () => Promise<T>) =>
      w.helpers.as(w.a, { id: w.a.ids.owner, type: 'resident' }, fn);
    const invite = () =>
      asOwner(() =>
        households.createInvite(w.a.homeUnitId, {
          fullName: 'Enum Invitee',
          phone: uniquePhone(),
          email: uniqueEmail('enum-invite'),
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
          relation: 'sibling',
        }),
      );
    const live = await invite();
    const revoked = await invite();
    await asOwner(() => households.revokeInvite(revoked.inviteId));
    const expired = await invite();
    const past = new Date(Date.now() - 1000);
    await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.householdInvite.update({
        where: { id: expired.inviteId },
        data: { expiresAt: past },
      }),
    );
    await h.moduleRef.get(GlobalDbService).inviteToken.updateMany({
      where: { inviteId: expired.inviteId },
      data: { expiresAt: past },
    });
    // Used: accepted through the real flow, so its token is gone.
    const usedEmail = uniqueEmail('enum-used');
    const used = await asOwner(() =>
      households.createInvite(w.a.homeUnitId, {
        fullName: 'Enum Used',
        phone: uniquePhone(),
        email: usedEmail,
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
        relation: 'sibling',
      }),
    );
    const since = new Date();
    await call(w, 'POST', '/invites/accept/start', {
      body: { token: used.token },
    }).expect(202);
    await call(w, 'POST', '/invites/accept/complete', {
      body: { token: used.token, code: await waitForOtp(usedEmail, since) },
    }).expect(200);
    const tokens = [
      live.token,
      used.token,
      revoked.token,
      expired.token,
      `unknown-${uniqueSuffix()}`,
    ];

    const started: Response[] = [];
    const wrong: Response[] = [];
    for (const token of tokens) {
      started.push(
        await call(w, 'POST', '/invites/accept/start', { body: { token } }),
      );
      wrong.push(
        await call(w, 'POST', '/invites/accept/complete', {
          body: { token, code: '000000' },
        }),
      );
    }
    same(started);
    same(wrong);
    expect(started[0].status).toBe(202);
    expect(wrong[0].status).toBe(401);
  });

  it('the visitor page: the same 404 for every link that is not live (ADR 0030)', async () => {
    const pass = async (side: 'a' | 'b' = 'a') => {
      const res = await call(
        w,
        'POST',
        `/units/${w[side].homeUnitId}/visitor-passes`,
        {
          token: w[side].tokens.owner,
          body: {
            kind: 'one_time',
            partySize: 1,
            validFrom: new Date().toISOString(),
            validUntil: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      ).expect(201);
      const b = res.body as { id: string; link: string };
      return { id: b.id, token: b.link.split('#')[1] };
    };
    const replaced = await pass();
    await call(w, 'POST', `/visitor-passes/${replaced.id}/reissue-link`, {
      token: w.a.tokens.owner,
    }).expect(200);
    const suspended = await pass('b');
    const globalDb = h.moduleRef.get(GlobalDbService);
    await globalDb.tenant.update({
      where: { id: w.b.tenantId },
      data: { status: 'suspended' },
    });
    try {
      const tokens = [
        `unknown${'x'.repeat(36)}`,
        'not-a-token',
        replaced.token,
        suspended.token,
      ];
      for (const path of [
        '/public/visitor-passes/lookup',
        '/public/visitor-passes/not-me',
      ]) {
        const answers: Response[] = [];
        for (const token of tokens)
          answers.push(await call(w, 'POST', path, { body: { token } }));
        same(answers);
        expect(answers[0].status).toBe(404);
        expect(answers[0].headers['x-robots-tag']).toBe('noindex');
      }
    } finally {
      await globalDb.tenant.update({
        where: { id: w.b.tenantId },
        data: { status: 'active' },
      });
    }
  });
});
