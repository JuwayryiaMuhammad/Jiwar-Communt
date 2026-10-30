import { err } from '../api/request';
import { at, day } from '../setup/compound-clock';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import type { Who } from '../setup/engagement';

interface Visit {
  id: string;
  unitId: string;
  unitCode: string;
  status: string;
  assigned: boolean;
  paymentId: string | null;
  failReason: string | null;
  offeredStartsAt: string | null;
  followsId: string | null;
}

const window = (d: number, from = 10, hours = 2) => ({
  windowStartsAt: at(day(d), from).toISOString(),
  windowEndsAt: at(day(d), from + hours).toISOString(),
});

/**
 * ADR 0069: a field collector's visit — asked for by whoever pays a unit's
 * money in a window from tomorrow, one open a unit; assigned by the
 * accountant to a collector; cash taken as an office payment with its
 * receipt, at most what the unit owes plus the compound's margin; or why
 * it failed, with another window the resident may take once. The
 * collector never sees a phone, a name or a balance.
 */
describe('Finance — collector visits', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;
  let collector: Who;
  let other: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Collector Court');
    const g = gateHelpers(h);
    collector = await f.who(s.c, (await g.guard(s.c, 'collector')).id, 'staff');
    other = await f.who(s.c, (await g.guard(s.c, 'collector')).id, 'staff');
  }, 90_000);

  afterAll(() => h.close());

  const ask = (unitId: string, body: object, token = s.owner.token) =>
    f.http('post', `/units/${unitId}/collector-visits`, token, body);
  const staff = (path: string, body?: object) =>
    f.http('post', `/staff/collector-visits/${path}`, s.accountant.token, body);
  const field = (path: string, body: object, who = collector) =>
    f.http('post', `/collector/visits/${path}`, who.token, body);
  const told = (accountId: string, kind: string, targetId: string) =>
    f.inTx(s.c, (tx) =>
      tx.notification.findMany({ where: { accountId, kind, targetId } }),
    );

  /** A home of its own, its owner, an invoice it owes, and an assigned visit. */
  async function assigned(owes = '1000') {
    const home = await f.unit(s.c, 'A');
    const owner = await f.owner(s.c, home.id);
    if (owes !== '0')
      await f.issue(s.accountant, home.id, {
        lines: [
          { descriptionEn: 'Dues', descriptionAr: 'مستحقات', amount: owes },
        ],
      });
    const v = (await ask(home.id, window(1), owner.token).expect(201))
      .body as Visit;
    await staff(`${v.id}/assign`, { collectorId: collector.id }).expect(201);
    return { home, owner, visit: v };
  }

  it('a window from tomorrow, one to four hours, within 14 days; one open a unit; the staff are told', async () => {
    const home = await f.unit(s.c, 'A');
    const owner = await f.owner(s.c, home.id);
    expect(
      err(await ask(home.id, window(0), owner.token).expect(400)).fields,
    ).toEqual([
      {
        field: 'windowStartsAt',
        code: 'INVALID_VALUE',
        params: { maxDaysAhead: 14 },
      },
    ]);
    expect(
      err(await ask(home.id, window(15), owner.token).expect(400)).fields,
    ).toEqual([
      {
        field: 'windowStartsAt',
        code: 'INVALID_VALUE',
        params: { maxDaysAhead: 14 },
      },
    ]);
    expect(
      err(await ask(home.id, window(1, 8, 5), owner.token).expect(400)).fields,
    ).toEqual([
      {
        field: 'windowEndsAt',
        code: 'INVALID_VALUE',
        params: { minHours: 1, maxHours: 4 },
      },
    ]);
    const v = (await ask(home.id, window(2), owner.token).expect(201))
      .body as Visit;
    expect(v).toMatchObject({ status: 'requested', assigned: false });
    expect(
      err(await ask(home.id, window(3), owner.token).expect(409)),
    ).toMatchObject({
      code: 'COLLECTOR_VISIT_OPEN',
      params: { visitId: v.id },
    });
    expect(
      await told(s.accountant.id, 'collector_visit.requested', v.id),
    ).toHaveLength(1);
  });

  it('assigned to a collector only; the collector and the resident are told; the collector sees no phone, name or balance', async () => {
    const home = await f.unit(s.c, 'A');
    const owner = await f.owner(s.c, home.id);
    const v = (await ask(home.id, window(1), owner.token).expect(201))
      .body as Visit;
    expect(
      err(
        await staff(`${v.id}/assign`, { collectorId: s.accountant.id }).expect(
          400,
        ),
      ).fields,
    ).toEqual([{ field: 'collectorId', code: 'INVALID_VALUE' }]);
    const listed = (
      await f.http('get', '/staff/collectors', s.accountant.token).expect(200)
    ).body as { data: { id: string }[] };
    expect(listed.data.map((c) => c.id).sort()).toEqual(
      [collector.id, other.id].sort(),
    );
    await staff(`${v.id}/assign`, { collectorId: collector.id }).expect(201);
    expect(
      await told(collector.id, 'collector_visit.assigned', v.id),
    ).toHaveLength(1);
    expect(
      await told(owner.id, 'collector_visit.scheduled', v.id),
    ).toHaveLength(1);
    const mine = (
      await f.http('get', '/collector/visits', collector.token).expect(200)
    ).body as { data: Visit[] };
    const seen = mine.data.find((x) => x.id === v.id)!;
    expect(seen).toMatchObject({ unitCode: home.code, status: 'assigned' });
    const person = await f.inTx(s.c, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: owner.id } }),
    );
    const text = JSON.stringify(mine);
    for (const secret of [person.fullName, person.phone, person.email])
      if (secret) expect(text).not.toContain(secret);
    expect(text).not.toContain('outstanding');
  });

  it('cash taken: at most what the unit owes plus the margin, as an office payment with its receipt; the rest is credit', async () => {
    const { home, owner, visit } = await assigned('1000');
    expect(
      err(
        await field(`${visit.id}/collected`, { amount: '1050.01' }).expect(400),
      ),
    ).toMatchObject({
      code: 'AMOUNT_TOO_HIGH',
      params: { max: '1050.00' },
    });
    // Another collector's visit is none of theirs.
    await field(`${visit.id}/collected`, { amount: '10' }, other).expect(404);
    const done = (
      await field(`${visit.id}/collected`, { amount: '1050' }).expect(201)
    ).body as Visit;
    expect(done.status).toBe('collected');
    const payment = await f.inTx(s.c, (tx) =>
      tx.financePayment.findUniqueOrThrow({ where: { id: done.paymentId! } }),
    );
    expect(payment).toMatchObject({
      channel: 'office',
      method: 'cash',
      recordedById: collector.id,
    });
    expect(payment.amount!.toFixed(2)).toBe('1050.00');
    const statement = (
      await f
        .http('get', `/units/${home.id}/statement`, owner.token)
        .expect(200)
    ).body as { outstanding: string; credit: string };
    expect(statement).toMatchObject({ outstanding: '0.00', credit: '50.00' });
    expect(await told(owner.id, 'payment.received', payment.id)).toHaveLength(
      1,
    );
    expect(
      err(await field(`${visit.id}/collected`, { amount: '1' }).expect(409)),
    ).toMatchObject({
      code: 'COLLECTOR_VISIT_CLOSED',
      params: { status: 'collected' },
    });
  });

  it('a unit that owes nothing: only the margin', async () => {
    const { visit } = await assigned('0');
    expect(
      err(
        await field(`${visit.id}/collected`, { amount: '50.01' }).expect(400),
      ),
    ).toMatchObject({ code: 'AMOUNT_TOO_HIGH', params: { max: '50.00' } });
    await field(`${visit.id}/collected`, { amount: '50' }).expect(201);
  });

  it('the margin is the compound’s: 0 to 1000', async () => {
    expect(
      err(
        await f
          .http(
            'patch',
            '/staff/finance/collector-settings',
            s.accountant.token,
            {
              collectorMargin: '1500',
            },
          )
          .expect(400),
      ).fields,
    ).toEqual([
      {
        field: 'collectorMargin',
        code: 'INVALID_VALUE',
        params: { max: '1000.00' },
      },
    ]);
    await f
      .http('patch', '/staff/finance/collector-settings', s.accountant.token, {
        collectorMargin: '0',
      })
      .expect(200);
    const { visit } = await assigned('100');
    await field(`${visit.id}/collected`, { amount: '100.01' }).expect(400);
    await f
      .http('patch', '/staff/finance/collector-settings', s.accountant.token, {
        collectorMargin: '50',
      })
      .expect(200);
  });

  it('failed with a reason and another window; the resident is told and takes it once, as a new visit', async () => {
    const { owner, visit } = await assigned();
    expect(err(await field(`${visit.id}/failed`, {}).expect(400)).code).toBe(
      'REASON_REQUIRED',
    );
    const offer = window(3, 14);
    const failed = (
      await field(`${visit.id}/failed`, {
        reasonCode: 'not_home',
        offeredStartsAt: offer.windowStartsAt,
        offeredEndsAt: offer.windowEndsAt,
      }).expect(201)
    ).body as Visit;
    expect(failed).toMatchObject({ status: 'failed', failReason: 'not_home' });
    const [notice] = await told(owner.id, 'collector_visit.failed', visit.id);
    expect(notice.params).toEqual({ reason: 'not_home' });
    const take = () =>
      f.http('post', `/collector-visits/${visit.id}/accept-offer`, owner.token);
    const next = (await take().expect(201)).body as Visit;
    expect(next).toMatchObject({ status: 'requested', followsId: visit.id });
    expect(((await take().expect(201)).body as Visit).id).toBe(next.id);
  });

  it('called off: by the resident without a reason, by the staff with one', async () => {
    const one = await assigned();
    await f
      .http('post', `/collector-visits/${one.visit.id}/cancel`, one.owner.token)
      .expect(201);
    expect(
      await told(collector.id, 'collector_visit.cancelled', one.visit.id),
    ).toHaveLength(1);
    const two = await assigned();
    expect(
      err(await staff(`${two.visit.id}/cancel`, {}).expect(400)).code,
    ).toBe('REASON_REQUIRED');
    expect(
      (
        (
          await staff(`${two.visit.id}/cancel`, {
            reasonCode: 'paid_otherwise',
          }).expect(201)
        ).body as Visit
      ).status,
    ).toBe('cancelled');
  });

  describe('races', () => {
    it('cash recorded twice at once: one payment', async () => {
      const { visit } = await assigned();
      const both = await Promise.all([
        field(`${visit.id}/collected`, { amount: '1000' }),
        field(`${visit.id}/collected`, { amount: '1000' }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await f.inTx(s.c, (tx) =>
          tx.collectorVisit.count({
            where: { id: visit.id, paymentId: { not: null } },
          }),
        ),
      ).toBe(1);
    });

    it('cash recorded while the resident calls it off: one of the two', async () => {
      const { owner, visit } = await assigned();
      const results = await Promise.all([
        field(`${visit.id}/collected`, { amount: '1000' }),
        f.http('post', `/collector-visits/${visit.id}/cancel`, owner.token),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const row = await f.inTx(s.c, (tx) =>
        tx.collectorVisit.findUniqueOrThrow({ where: { id: visit.id } }),
      );
      expect(['collected', 'cancelled']).toContain(row.status);
      expect(row.status === 'collected').toBe(row.paymentId !== null);
    });

    it('two visits asked at once: one open', async () => {
      const home = await f.unit(s.c, 'A');
      const owner = await f.owner(s.c, home.id);
      const both = await Promise.all([
        ask(home.id, window(1), owner.token),
        ask(home.id, window(2), owner.token),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    });
  });
});
