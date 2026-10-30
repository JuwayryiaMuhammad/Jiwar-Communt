import { Prisma } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import { UpcomingDuesSweep } from '../../src/finance/forecast/upcoming-dues.sweep';
import { err } from '../api/request';
import { day, dbDate, month } from '../setup/compound-clock';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Dues {
  overdue: string;
  months: {
    month: string;
    invoiced: string;
    projected: string;
    total: string;
  }[];
  credit: string;
  net: string;
}

let counter = 0;
/** A number for a raw invoice: far above the compound's own counter. */
const nextNumber = () => 950_000_000 + ++counter;

/**
 * ADR 0069: what a unit will owe, by the month it falls due — its
 * invoices still owed and what its plans will issue it, less its credit —
 * for whoever sees its money; and, where the compound turns it on, a
 * notice once a month when next month asks far more than the months
 * before.
 */
describe('Finance — upcoming dues', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Dues Court');
  }, 90_000);

  afterAll(() => h.close());

  const dues = async (unitId = s.home.id, query = '', token = s.owner.token) =>
    (
      await f
        .http('get', `/units/${unitId}/upcoming-dues${query}`, token)
        .expect(200)
    ).body as Dues;

  /** An invoice issued to `unitId` on a past day, written raw. */
  const issuedOn = (unitId: string, on: string, amount: string) =>
    f.inTx(s.c, async (tx) => {
      const batchId = newId();
      await tx.invoiceBatch.create({
        data: {
          id: batchId,
          tenantId: s.c.tenantId,
          target: 'unit',
          unitId,
          kind: 'other',
          unitCount: 1,
          issuedOn: dbDate(on),
          dueOn: dbDate(on),
        },
      });
      await tx.invoice.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          number: nextNumber(),
          batchId,
          unitId,
          kind: 'other',
          total: new Prisma.Decimal(amount),
          currency: 'EGP',
          issuedOn: dbDate(on),
          dueOn: dbDate(on),
          lines: {
            create: {
              id: newId(),
              position: 1,
              descriptionEn: 'Past',
              descriptionAr: 'سابق',
              amount: new Prisma.Decimal(amount),
            },
          },
        },
      });
    });

  it('by month: invoices still owed, what its plans will issue it, the overdue; less its credit', async () => {
    const home = await f.unit(s.c, 'A');
    const owner = await f.owner(s.c, home.id);
    await f.issue(s.accountant, home.id, { dueOn: day(10) });
    await issuedOn(home.id, day(-5), '200');
    await f
      .http('post', '/staff/billing-plans', s.manager.token, {
        nameEn: 'Service',
        nameAr: 'خدمة',
        kind: 'service_charge',
        frequency: 'monthly',
        amount: '300',
        startsOn: `${month(1)}-01`,
        issueDaysBefore: 0,
        dueDaysAfterIssue: 10,
      })
      .expect(201);
    await f.giveCredit(s.c, home.id, '150');
    const body = await dues(home.id, '?months=3', owner.token);
    // The suite's first plan: due ten days into each period from next month.
    const want = new Map([
      [month(0), { invoiced: 0, projected: 0 }],
      [month(1), { invoiced: 0, projected: 300 }],
      [month(2), { invoiced: 0, projected: 300 }],
    ]);
    want.get(day(10).slice(0, 7))!.invoiced += 1000;
    expect(body).toEqual({
      unitId: home.id,
      asOf: day(0),
      overdue: '200.00',
      months: [...want.entries()].map(([m, w]) => ({
        month: m,
        invoiced: w.invoiced.toFixed(2),
        projected: w.projected.toFixed(2),
        total: (w.invoiced + w.projected).toFixed(2),
      })),
      credit: '150.00',
      net: '1650.00',
    });
  });

  it('one to six months; whoever sees the unit’s money; anyone else finds no unit', async () => {
    for (const q of ['?months=0', '?months=7'])
      expect(
        err(
          await f
            .http('get', `/units/${s.home.id}/upcoming-dues${q}`, s.owner.token)
            .expect(400),
        ).fields,
      ).toEqual([
        { field: 'months', code: 'INVALID_NUMBER', params: { min: 1, max: 6 } },
      ]);
    expect((await dues()).months).toHaveLength(3);
    const stranger = await f.owner(s.c, (await f.unit(s.c, 'B')).id);
    expect(
      err(
        await f
          .http('get', `/units/${s.home.id}/upcoming-dues`, stranger.token)
          .expect(404),
      ).code,
    ).toBe('UNIT_NOT_FOUND');
    const member = await f.family(s.c, s.home.id, s.owner);
    await f
      .http('get', `/units/${s.home.id}/upcoming-dues`, member.token)
      .expect(403);
  });

  it('the rising notice: only where the compound turns it on, once a unit and month, the month only', async () => {
    const home = await f.unit(s.c, 'C');
    const owner = await f.owner(s.c, home.id);
    for (const m of [-6, -5, -4, -3, -2])
      await issuedOn(home.id, `${month(m)}-05`, '100');
    // Next month asks 1000: far more than 100 a month.
    await f.issue(s.accountant, home.id, {
      dueOn: `${month(1)}-15`,
      kind: 'other',
    });
    const sweep = () => h.moduleRef.get(UpcomingDuesSweep).run();
    const told = () =>
      f.inTx(s.c, (tx) =>
        tx.notification.findMany({
          where: {
            accountId: owner.id,
            kind: 'finance.dues_rising',
            targetId: home.id,
          },
        }),
      );
    await sweep();
    expect(await told()).toEqual([]);
    await f
      .http('patch', '/staff/finance/plan-settings', s.accountant.token, {
        duesNotice: true,
      })
      .expect(200);
    await sweep();
    await sweep();
    const notices = await told();
    expect(notices).toHaveLength(1);
    expect(notices[0].params).toEqual({ month: month(1) });
  });
});
