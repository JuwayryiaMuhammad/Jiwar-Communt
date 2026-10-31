import { err } from '../api/request';
import { ofDbDate } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

interface Request {
  id: string;
  unitId: string;
  planId: string;
  amount: string;
  status: string;
  charge: { invoiceId: string; status: string } | null;
  paymentId: string | null;
}

/**
 * ADR 0070: a resident who books for a unit asks for a club plan; its
 * price is owed at once through a `club` invoice of the unit's. Paid —
 * at the office, online, or by the unit's credit — the membership starts
 * (created when the unit had none, covering its people now) or is extended
 * from where its last paid period ends, by a payment record that points at
 * the charge. Called off before it is paid, its invoice is credited off.
 */
describe('Club: membership requests through finance (ADR 0070)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let accountant: Who;
  let planId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    accountant = await f.accountant(s.c);
    planId = await f.plan(s.c, s.manager, { price: '300' });
  }, 180_000);

  afterAll(() => h.close());

  const ask = (as: Who, unitId: string, plan = planId) =>
    f.http('post', `/units/${unitId}/club-membership/requests`, as.token, {
      planId: plan,
    });
  const payOffice = (unitId: string, amount: string, invoiceId: string) =>
    f.http('post', `/staff/units/${unitId}/payments`, accountant.token, {
      amount,
      method: 'cash',
      paidOn: day(0),
      invoiceIds: [invoiceId],
    });
  const cancel = (as: Who, id: string) =>
    f.http('post', `/club-membership-requests/${id}/cancel`, as.token, {
      reasonCode: 'no_longer_needed',
    });
  const mine = async (as: Who, unitId: string) =>
    (
      (
        await f
          .http('get', `/units/${unitId}/club-membership/requests`, as.token)
          .expect(200)
      ).body as { data: Request[] }
    ).data;
  /** A fresh home in the compound and its owner. */
  const someone = async () => {
    const home = await f.unit(s.c, 'B');
    return { home, who: await f.owner(s.c, home.id) };
  };

  it('asked: the plan’s price is owed through a `club` invoice, due in a week; one open per unit; an active plan only', async () => {
    const { home, who } = await someone();
    const res = await ask(who, home.id).expect(201);
    const r = res.body as Request;
    expect(r).toMatchObject({
      unitId: home.id,
      planId,
      amount: '300.00',
      status: 'requested',
      charge: { invoiceId: expect.any(String) as string, status: 'open' },
      paymentId: null,
    });
    const invoice = (
      await f
        .http('get', `/staff/invoices/${r.charge!.invoiceId}`, s.manager.token)
        .expect(200)
    ).body as { kind: string; total: string; dueOn: string };
    expect(invoice).toMatchObject({
      kind: 'club',
      total: '300.00',
      dueOn: day(7),
    });
    const again = await ask(who, home.id);
    expect(again.status).toBe(409);
    expect(err(again)).toMatchObject({
      code: 'CLUB_REQUEST_OPEN',
      params: { requestId: r.id },
    });
    const retired = await f.plan(s.c, s.manager, { nameEn: 'Old' });
    await f
      .http('patch', `/staff/club-plans/${retired}`, s.manager.token, {
        active: false,
      })
      .expect(200);
    const other = await someone();
    const refused = await ask(other.who, other.home.id, retired);
    expect(refused.status).toBe(400);
    expect(err(refused).fields).toEqual([
      { field: 'planId', code: 'PLAN_NOT_AVAILABLE' },
    ]);
  });

  it('paid at the office: a membership is created covering the unit’s people, and paid for a month from today', async () => {
    const { home, who } = await someone();
    const r = (await ask(who, home.id).expect(201)).body as Request;
    await payOffice(home.id, '300.00', r.charge!.invoiceId).expect(201);
    const [paid] = await mine(who, home.id);
    expect(paid).toMatchObject({
      id: r.id,
      status: 'paid',
      charge: { status: 'paid' },
      paymentId: expect.any(String) as string,
    });
    const record = await f.inTx(s.c, (tx) =>
      tx.clubPaymentRecord.findUniqueOrThrow({
        where: { id: paid.paymentId! },
        include: { membership: { include: { people: true } } },
      }),
    );
    expect(record).toMatchObject({
      kind: 'payment',
      planId,
      receiptNumber: null,
      recordedById: null,
      chargeId: expect.any(String) as string,
    });
    expect(ofDbDate(record.periodStartsOn!)).toBe(day(0));
    expect(record.membership.unitId).toBe(home.id);
    expect(record.membership.people).toHaveLength(1);
    expect(
      await f.notifications(s.c, who.id, 'club_membership_request.paid'),
    ).toHaveLength(1);
    // The membership now covers the owner at a members' facility.
    const gym = await f.facility(s.c, s.manager, {
      nameEn: 'Members court',
      requiresMembership: true,
      weeklyQuota: 20,
    });
    await f.book(who, home.id, gym, at(day(2), 10));
    // Its payment is finance's: never reversed here.
    const reversed = await f.http(
      'post',
      `/staff/club-payments/${paid.paymentId}/reverse`,
      s.manager.token,
      { reasonCode: 'entered_in_error' },
    );
    expect(reversed.status).toBe(409);
    expect(err(reversed).code).toBe('CLUB_PAYMENT_FROM_CHARGE');
  });

  it('paid while the membership runs: extended from where its last paid period ends', async () => {
    const membership = await f.membership(s.c, s.manager, s.homeA.id);
    await f.pay(s.manager, membership, planId).expect(201);
    const r = (await ask(s.alice, s.homeA.id).expect(201)).body as Request;
    await payOffice(s.homeA.id, '300.00', r.charge!.invoiceId).expect(201);
    const records = await f.inTx(s.c, (tx) =>
      tx.clubPaymentRecord.findMany({
        where: { membershipId: membership },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(records).toHaveLength(2);
    expect(records[1].periodStartsOn).toEqual(records[0].periodEndsOn);
    expect(records[1].periodEndsOn!.getTime()).toBeGreaterThan(
      records[1].periodStartsOn!.getTime(),
    );
  });

  it('called off before it is paid: its invoice is credited off; once paid, it is not', async () => {
    const { home, who } = await someone();
    const r = (await ask(who, home.id).expect(201)).body as Request;
    const off = (await cancel(who, r.id).expect(200)).body as Request;
    expect(off).toMatchObject({
      status: 'cancelled',
      charge: { status: 'cancelled' },
    });
    expect(
      (
        (
          await f
            .http(
              'get',
              `/staff/invoices/${r.charge!.invoiceId}`,
              s.manager.token,
            )
            .expect(200)
        ).body as { status: string }
      ).status,
    ).toBe('credited');
    const again = (await ask(who, home.id).expect(201)).body as Request;
    await payOffice(home.id, '300.00', again.charge!.invoiceId).expect(201);
    const late = await cancel(who, again.id);
    expect(late.status).toBe(409);
    expect(err(late)).toMatchObject({
      code: 'CLUB_REQUEST_CLOSED',
      params: { status: 'paid' },
    });
    // Someone else of the compound does not see it.
    const stranger = await cancel(s.bob, again.id);
    expect(stranger.status).toBe(404);
    expect(err(stranger).code).toBe('CLUB_REQUEST_NOT_FOUND');
  });

  it.each([1, 2, 3])(
    'round %i: called off while the office takes the price — paid with a membership, or called off with the money as credit; never both',
    async () => {
      const { home, who } = await someone();
      const r = (await ask(who, home.id).expect(201)).body as Request;
      const [off, paid] = await Promise.all([
        cancel(who, r.id),
        payOffice(home.id, '300.00', r.charge!.invoiceId),
      ]);
      const [after] = await mine(who, home.id);
      const records = await f.inTx(s.c, (tx) =>
        tx.clubPaymentRecord.count({
          where: { membership: { unitId: home.id } },
        }),
      );
      if (off.status === 200) {
        // Called off first: the office finds nothing owed and takes nothing.
        expect(paid.status).toBe(409);
        expect(err(paid).code).toBe('INVOICE_NOT_PAYABLE');
        expect(after).toMatchObject({
          status: 'cancelled',
          charge: { status: 'cancelled' },
        });
        expect(records).toBe(0);
      } else {
        expect(paid.status).toBe(201);
        expect(err(off).code).toBe('CLUB_REQUEST_CLOSED');
        expect(after).toMatchObject({ status: 'paid' });
        expect(records).toBe(1);
      }
    },
  );

  it.each([1, 2, 3])(
    'round %i: two payments of the whole price at once — the membership is paid for once',
    async () => {
      const { home, who } = await someone();
      const r = (await ask(who, home.id).expect(201)).body as Request;
      const both = await Promise.all([
        payOffice(home.id, '300.00', r.charge!.invoiceId),
        payOffice(home.id, '300.00', r.charge!.invoiceId),
      ]);
      // The second finds nothing owed: the office never takes credit.
      expect(both.map((p) => p.status).sort()).toEqual([201, 409]);
      const records = await f.inTx(s.c, (tx) =>
        tx.clubPaymentRecord.count({
          where: { membership: { unitId: home.id } },
        }),
      );
      expect(records).toBe(1);
      expect((await mine(who, home.id))[0].status).toBe('paid');
    },
  );
});
