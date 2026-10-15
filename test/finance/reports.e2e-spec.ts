import type { Response } from 'supertest';
import { addDays } from '../../src/core/common/slots/day-slots';
import { day } from '../setup/facilities';
import { backdateInvoice, financeHelpers } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const body = <T>(res: Response) => res.body as T;

interface Aging {
  asOf: string;
  rows: {
    unitCode: string | null;
    building: string | null;
    notDue: string;
    days1to30: string;
    days31to60: string;
    days61to90: string;
    days91plus: string;
    total: string;
  }[];
  totals: { total: string };
}

/**
 * The finance reports (ADR 0048): aging, collections, outstanding and the
 * office's day, each from the append-only rows, in the compound's local
 * days, with a CSV twin that holds the same rows.
 */
describe('Finance — reports', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  const report = async <T>(
    token: string,
    name: string,
    query: Record<string, string> = {},
  ) =>
    body<T>(
      await f
        .http(
          'get',
          `/staff/finance/reports/${name}?${new URLSearchParams(query)}`,
          token,
        )
        .expect(200),
    );
  const csv = async (
    token: string,
    name: string,
    query: Record<string, string> = {},
  ) => {
    const res = await f
      .http(
        'get',
        `/staff/finance/reports/${name}/export?${new URLSearchParams(query)}`,
        token,
      )
      .expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`^attachment; filename="${name}-[0-9_-]+\\.csv"$`),
    );
    return res.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
  };

  it('aging: what is owed by days past due, at each boundary; per unit and per building', async () => {
    const s = await f.setUp('Aging Court');
    const other = await f.unit(s.c, 'B');
    const late = async (unitId: string, days: number) => {
      const { invoiceId } = await f.issue(s.manager, unitId, {
        dueOn: day(0),
      });
      if (days) await backdateInvoice(invoiceId, days);
    };
    await f.issue(s.manager, s.home.id, { dueOn: day(5) });
    for (const d of [0, 1, 30, 31, 60]) await late(s.home.id, d);
    for (const d of [61, 90, 91]) await late(other.id, d);
    const byUnit = await report<Aging>(s.accountant.token, 'aging');
    expect(byUnit.asOf).toBe(day(0));
    expect(
      byUnit.rows.map((r) => [
        r.unitCode,
        r.notDue,
        r.days1to30,
        r.days31to60,
        r.days61to90,
        r.days91plus,
        r.total,
      ]),
    ).toEqual([
      [s.home.code, '2000.00', '2000.00', '2000.00', '0.00', '0.00', '6000.00'],
      [other.code, '0.00', '0.00', '0.00', '2000.00', '1000.00', '3000.00'],
    ]);
    expect(byUnit.totals.total).toBe('9000.00');
    const byBuilding = await report<Aging>(s.manager.token, 'aging', {
      groupBy: 'building',
    });
    expect(
      byBuilding.rows.map((r) => [r.unitCode, r.building, r.total]),
    ).toEqual([
      [null, 'A', '6000.00'],
      [null, 'B', '3000.00'],
    ]);
    const onlyB = await report<Aging>(s.manager.token, 'aging', {
      building: 'B',
    });
    expect(onlyB.rows.map((r) => r.unitCode)).toEqual([other.code]);
    const lines = await csv(s.manager.token, 'aging');
    expect(lines[0]).toBe(
      'unit,building,not_due,days_1_30,days_31_60,days_61_90,days_91_plus,total',
    );
    expect(lines.slice(1)).toEqual([
      `${s.home.code},A,2000.00,2000.00,2000.00,0.00,0.00,6000.00`,
      `${other.code},B,0.00,0.00,0.00,2000.00,1000.00,3000.00`,
      'TOTAL,,2000.00,2000.00,2000.00,2000.00,1000.00,9000.00',
    ]);
  });

  it('collections: a payment on the day it was paid, a reversal on the day it was recorded; by day and by month', async () => {
    const s = await f.setUp('Collections Court');
    await f.issue(s.manager, s.home.id);
    const pay = async (amount: string, method: string, paidOn: string) =>
      body<{ id: string }>(
        await f
          .http(
            'post',
            `/staff/units/${s.home.id}/payments`,
            s.accountant.token,
            {
              amount,
              method,
              paidOn,
              ...(method === 'cash' ? {} : { reference: 'REF-1' }),
            },
          )
          .expect(201),
      ).id;
    const early = await pay('100', 'cash', addDays(day(0), -3));
    await pay('200', 'cheque', day(0));
    await f
      .http('post', `/staff/payments/${early}/reverse`, s.manager.token, {
        reasonCode: 'entered_in_error',
      })
      .expect(201);
    const period = { from: addDays(day(0), -5), to: day(0) };
    const byDay = await report<{
      rows: {
        period: string;
        method: string;
        payments: number;
        gross: string;
        reversals: number;
        reversed: string;
        net: string;
      }[];
      gross: string;
      reversed: string;
      net: string;
    }>(s.accountant.token, 'collections', period);
    expect(
      byDay.rows.map((r) => [
        r.period,
        r.method,
        r.payments,
        r.gross,
        r.reversals,
        r.reversed,
        r.net,
      ]),
    ).toEqual([
      [addDays(day(0), -3), 'cash', 1, '100.00', 0, '0.00', '100.00'],
      [day(0), 'cash', 0, '0.00', 1, '100.00', '-100.00'],
      [day(0), 'cheque', 1, '200.00', 0, '0.00', '200.00'],
    ]);
    expect([byDay.gross, byDay.reversed, byDay.net]).toEqual([
      '300.00',
      '100.00',
      '200.00',
    ]);
    const byMonth = await report<{ rows: { period: string }[] }>(
      s.accountant.token,
      'collections',
      { ...period, groupBy: 'month' },
    );
    for (const r of byMonth.rows) expect(r.period).toMatch(/^\d{4}-\d{2}$/);
    const lines = await csv(s.accountant.token, 'collections', period);
    expect(lines).toHaveLength(byDay.rows.length + 2);
    expect(lines[lines.length - 1]).toBe('TOTAL,,,,300.00,,100.00,200.00');
  });

  it('outstanding: per unit what it owes, the overdue part and its credit; units owing nothing and holding nothing left out', async () => {
    const s = await f.setUp('Outstanding Court');
    const credited = await f.unit(s.c, 'B');
    await f.unit(s.c, 'B');
    const old = await f.issue(s.manager, s.home.id, { dueOn: day(0) });
    await backdateInvoice(old.invoiceId, 5);
    await f.issue(s.manager, s.home.id, { dueOn: day(10) });
    await f.giveCredit(s.c, credited.id, '300');
    const v = await report<{
      rows: {
        unitCode: string;
        openInvoices: number;
        outstanding: string;
        overdue: string;
        credit: string;
        net: string;
      }[];
      totals: { outstanding: string; credit: string; net: string };
    }>(s.accountant.token, 'outstanding');
    expect(
      v.rows.map((r) => [
        r.unitCode,
        r.openInvoices,
        r.outstanding,
        r.overdue,
        r.credit,
        r.net,
      ]),
    ).toEqual([
      [s.home.code, 2, '2000.00', '1000.00', '0.00', '2000.00'],
      [credited.code, 0, '0.00', '0.00', '300.00', '-300.00'],
    ]);
    expect(v.totals).toMatchObject({
      outstanding: '2000.00',
      credit: '300.00',
      net: '1700.00',
    });
    const lines = await csv(s.manager.token, 'outstanding', {
      groupBy: 'building',
    });
    expect(lines).toEqual([
      'building,open_invoices,outstanding,overdue,credit,net',
      'A,2,2000.00,1000.00,0.00,2000.00',
      'B,0,0.00,0.00,300.00,-300.00',
      'TOTAL,2,2000.00,1000.00,300.00,1700.00',
    ]);
  });

  it('daily cash: per recorder and method, payments recorded today (a backdated one too), reversals, and cash refunds', async () => {
    const s = await f.setUp('Cash Court');
    await f.issue(s.manager, s.home.id);
    const record = async (
      who: { token: string },
      amount: string,
      method: string,
      paidOn = day(0),
    ) =>
      body<{ id: string }>(
        await f
          .http('post', `/staff/units/${s.home.id}/payments`, who.token, {
            amount,
            method,
            paidOn,
            ...(method === 'cash' ? {} : { reference: 'CHQ-9' }),
          })
          .expect(201),
      ).id;
    await record(s.accountant, '100', 'cash');
    await record(s.accountant, '40', 'cash', addDays(day(0), -5));
    await record(s.accountant, '60', 'cheque');
    const mine = await record(s.manager, '25', 'cash');
    await f
      .http('post', `/staff/payments/${mine}/reverse`, s.manager.token, {
        reasonCode: 'duplicate',
      })
      .expect(201);
    // The credit is an office payment the manager recorded today (written
    // raw, as an overpayment would leave it): it counts in the drawer.
    const credited = await f.unit(s.c, 'A');
    await f.giveCredit(s.c, credited.id, '90');
    await f.stepUp(s.manager.token);
    await f
      .http('post', `/staff/units/${credited.id}/refunds`, s.manager.token, {
        amount: '30',
        channel: 'cash',
        refundedOn: day(0),
      })
      .expect(201);
    // A refund by transfer leaves the drawer alone.
    await f.stepUp(s.manager.token);
    await f
      .http('post', `/staff/units/${credited.id}/refunds`, s.manager.token, {
        amount: '20',
        channel: 'bank_transfer',
        refundedOn: day(0),
      })
      .expect(201);
    const v = await report<{
      day: string;
      rows: {
        recordedBy: { id: string };
        method: string;
        payments: number;
        received: string;
        reversals: number;
        reversed: string;
        refunds: number;
        refunded: string;
        net: string;
      }[];
      events: { kind: string; amount: string }[];
      net: string;
    }>(s.accountant.token, 'daily-cash');
    expect(v.day).toBe(day(0));
    const row = (id: string, method: string) =>
      v.rows.find((r) => r.recordedBy.id === id && r.method === method);
    expect(row(s.accountant.id, 'cash')).toMatchObject({
      payments: 2,
      received: '140.00',
      net: '140.00',
    });
    expect(row(s.accountant.id, 'cheque')).toMatchObject({
      payments: 1,
      received: '60.00',
    });
    expect(row(s.manager.id, 'cash')).toMatchObject({
      payments: 2,
      received: '115.00',
      reversals: 1,
      reversed: '25.00',
      refunds: 1,
      refunded: '30.00',
      net: '60.00',
    });
    expect(v.net).toBe('260.00');
    expect(v.events.map((e) => [e.kind, e.amount])).toEqual(
      expect.arrayContaining([
        ['reversal', '-25.00'],
        ['refund', '-30.00'],
      ]),
    );
    expect(v.events.some((e) => e.amount === '-20.00')).toBe(false);
    const lines = await csv(s.manager.token, 'daily-cash');
    expect(lines).toHaveLength(v.events.length + 2);
    expect(lines[lines.length - 1]).toBe(`${day(0)},TOTAL,,,,,,260.00`);
    // Another day holds none of it.
    expect(
      (
        await report<{ rows: unknown[] }>(s.manager.token, 'daily-cash', {
          day: addDays(day(0), -1),
        })
      ).rows,
    ).toEqual([]);
  });

  it('finance.reports only', async () => {
    const s = await f.setUp('Reports Access');
    const cashier = await f.staff(s.c, ['finance.payments']);
    for (const name of ['aging', 'outstanding', 'daily-cash'])
      await f
        .http('get', `/staff/finance/reports/${name}`, cashier.token)
        .expect(403);
  });
});
