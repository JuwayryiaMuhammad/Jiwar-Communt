import { GlobalDbService } from '../../src/core/database/global-db.service';
import { communityHelpers, type Compound } from '../setup/community';
import { eraseNow } from '../setup/erasure';
import { stepUp } from '../setup/exports';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { loginViaOtp } from '../setup/login';
import { waitForOtp } from '../setup/mailpit';

/**
 * An account's own contact and identity (ADR 0062): the email changed by
 * the account itself, proven at both ends; the name and the phone asked
 * for and decided by a manager.
 */
describe('Self contact and identity changes', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let c: Compound;
  let managerToken: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    c = await x.compound('Contact Court');
    managerToken = await h.tokenFor({
      sub: c.managerId,
      tid: c.tenantId,
      typ: 'manager',
    });
  });

  afterAll(() => h.close());

  interface Body {
    code?: string;
    id?: string;
    status?: string;
    newValue?: string | null;
    reasonCode?: string | null;
    data?: { id: string; currentValue: string | null }[];
  }

  /** A resident of their own unit, logged in for real (a session to step up). */
  async function someone() {
    const unit = await x.unit(c);
    const p = await x.resident(c, [unit.id]);
    const { accessToken } = await loginViaOtp(h, p.email, p.id);
    return { ...p, token: accessToken };
  }

  async function call(
    method: 'get' | 'post',
    path: string,
    token: string,
    body: object = {},
  ) {
    const req = h.http()[method](`${API}${path}`);
    const res = await req
      .set('Authorization', `Bearer ${token}`)
      .send(method === 'post' ? body : undefined);
    return { status: res.status, body: res.body as Body };
  }

  const account = (id: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.account.findUniqueOrThrow({ where: { id } }),
    );

  it('changes the email: a step-up, then the code sent to the new address; the old one is told', async () => {
    const me = await someone();
    const next = uniqueEmail('moved');
    const early = await call('post', '/me/contact/email', me.token, {
      email: next,
    });
    expect([early.status, early.body.code]).toEqual([403, 'STEP_UP_REQUIRED']);

    await stepUp(h, me.token, me.email);
    const since = new Date();
    expect(
      (await call('post', '/me/contact/email', me.token, { email: next }))
        .status,
    ).toBe(202);
    // The step-up is spent.
    expect(
      (await call('post', '/me/contact/email', me.token, { email: next })).body
        .code,
    ).toBe('STEP_UP_REQUIRED');
    const code = await waitForOtp(next, since);

    // The code confirms only that address.
    const other = await call('post', '/me/contact/email/verify', me.token, {
      email: uniqueEmail('other'),
      code,
    });
    expect([other.status, other.body.code]).toEqual([
      403,
      'CONTACT_CODE_INVALID',
    ]);
    expect(
      (
        await call('post', '/me/contact/email/verify', me.token, {
          email: next,
          code,
        })
      ).status,
    ).toBe(204);
    expect((await account(me.id)).email).toBe(next);
    // A spent code does not work twice.
    expect(
      (
        await call('post', '/me/contact/email/verify', me.token, {
          email: next,
          code,
        })
      ).body.code,
    ).toBe('CONTACT_CODE_INVALID');

    const [told] = await h.moduleRef
      .get(GlobalDbService)
      .outboxMessage.findMany({
        where: { tenantId: c.tenantId, templateKey: 'account.email_changed' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
    expect(told).toMatchObject({ recipient: me.email, params: {} });
    // The new address logs in.
    await loginViaOtp(h, next, me.id);
  });

  it('a name change: asked with a step-up, one at a time, approved by a manager', async () => {
    const me = await someone();
    const asked = { field: 'name', value: '  Mona   Samir Fawzy ' };
    expect(
      (await call('post', '/me/identity-changes', me.token, asked)).body.code,
    ).toBe('STEP_UP_REQUIRED');
    await stepUp(h, me.token, me.email);
    const created = await call('post', '/me/identity-changes', me.token, asked);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'pending',
      newValue: 'Mona Samir Fawzy',
    });
    await stepUp(h, me.token, me.email);
    const second = await call('post', '/me/identity-changes', me.token, {
      field: 'phone',
      value: uniquePhone(),
    });
    expect([second.status, second.body.code]).toEqual([
      409,
      'IDENTITY_CHANGE_PENDING',
    ]);

    const queue = await call('get', '/identity-changes', managerToken);
    expect(queue.body.data).toContainEqual(
      expect.objectContaining({
        id: created.body.id,
        currentValue: me.fullName,
      }),
    );
    const approved = await call(
      'post',
      `/identity-changes/${created.body.id}/approve`,
      managerToken,
    );
    expect(approved.body).toMatchObject({ status: 'approved', newValue: null });
    expect((await account(me.id)).fullName).toBe('Mona Samir Fawzy');
    const again = await call(
      'post',
      `/identity-changes/${created.body.id}/reject`,
      managerToken,
      { reasonCode: 'other' },
    );
    expect([again.status, again.body.code]).toEqual([
      409,
      'IDENTITY_CHANGE_DECIDED',
    ]);
    const notice = await x.asManager(c, () =>
      x.prisma.tenant.notification.findFirst({
        where: {
          accountId: me.id,
          kind: 'account.identity_change_decided',
        },
      }),
    );
    expect(notice?.params).toEqual({ field: 'name', outcome: 'approved' });
  });

  it('a phone change rejected with a code leaves the phone; a withdrawn one too', async () => {
    const me = await someone();
    await stepUp(h, me.token, me.email);
    const asked = await call('post', '/me/identity-changes', me.token, {
      field: 'phone',
      value: uniquePhone(),
    });
    const rejected = await call(
      'post',
      `/identity-changes/${asked.body.id}/reject`,
      managerToken,
      { reasonCode: 'not_verified' },
    );
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      reasonCode: 'not_verified',
      newValue: null,
    });
    expect((await account(me.id)).phone).toBe(me.phone);

    await stepUp(h, me.token, me.email);
    const next = await call('post', '/me/identity-changes', me.token, {
      field: 'phone',
      value: uniquePhone(),
    });
    const cancelled = await call(
      'post',
      `/me/identity-changes/${next.body.id}/cancel`,
      me.token,
    );
    expect(cancelled.body).toMatchObject({
      status: 'cancelled',
      newValue: null,
    });
    // Another account's request is not found.
    const stranger = await someone();
    expect(
      (
        await call(
          'post',
          `/me/identity-changes/${next.body.id}/cancel`,
          stranger.token,
        )
      ).body.code,
    ).toBe('IDENTITY_CHANGE_NOT_FOUND');
  });

  it('an approved phone change replaces the login phone', async () => {
    const me = await someone();
    const phone = uniquePhone();
    await stepUp(h, me.token, me.email);
    const asked = await call('post', '/me/identity-changes', me.token, {
      field: 'phone',
      value: phone,
    });
    await call(
      'post',
      `/identity-changes/${asked.body.id}/approve`,
      managerToken,
    );
    expect((await account(me.id)).phone).toBe(phone);
  });

  it('race: an approval against a withdrawal — exactly one wins', async () => {
    for (let i = 0; i < 4; i++) {
      const me = await someone();
      await stepUp(h, me.token, me.email);
      const asked = await call('post', '/me/identity-changes', me.token, {
        field: 'name',
        value: `Raced Name ${i}`,
      });
      const [approve, cancel] = await Promise.all([
        call(
          'post',
          `/identity-changes/${asked.body.id}/approve`,
          managerToken,
        ),
        call('post', `/me/identity-changes/${asked.body.id}/cancel`, me.token),
      ]);
      const winners = [approve, cancel].filter((r) => r.status === 200);
      expect(winners).toHaveLength(1);
      expect([approve, cancel].find((r) => r.status !== 200)?.body.code).toBe(
        'IDENTITY_CHANGE_DECIDED',
      );
      const named = (await account(me.id)).fullName === `Raced Name ${i}`;
      expect(named).toBe(approve.status === 200);
    }
  });

  it('race: two requests on one step-up — one is made', async () => {
    const me = await someone();
    await stepUp(h, me.token, me.email);
    const both = await Promise.all(
      ['First Name', 'Second Name'].map((value) =>
        call('post', '/me/identity-changes', me.token, {
          field: 'name',
          value,
        }),
      ),
    );
    // The second waits on the account's lock, then finds the first pending.
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const rows = await x.asManager(c, () =>
      x.prisma.tenant.accountIdentityChange.count({
        where: { accountId: me.id, status: 'pending' },
      }),
    );
    expect(rows).toBe(1);
  });

  it('erasure withdraws a pending request and drops its value', async () => {
    const unit = await x.unit(c);
    await x.resident(c, [unit.id]);
    const tenant = await x.resident(c, [unit.id], 'tenant');
    const { accessToken } = await loginViaOtp(h, tenant.email, tenant.id);
    await stepUp(h, accessToken, tenant.email);
    const asked = await call('post', '/me/identity-changes', accessToken, {
      field: 'name',
      value: 'Leaving Soon',
    });
    await eraseNow(h, c, tenant.id);
    const row = await x.asManager(c, () =>
      x.prisma.tenant.accountIdentityChange.findUniqueOrThrow({
        where: { id: asked.body.id! },
      }),
    );
    expect(row).toMatchObject({ status: 'cancelled', newValue: null });
  });
});
