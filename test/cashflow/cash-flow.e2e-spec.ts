import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { addDays } from '../../src/core/common/slots/day-slots';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import {
  CASH_FLOW_SWEEP,
  CASH_FLOW_SWEEP_INTERVAL_MS,
} from '../../src/finance/cashflow/cash-flow.sweep';
import {
  expectedOf,
  planPeriods,
} from '../../src/finance/cashflow/cash-flow-rules';
import { err } from '../api/request';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { clock, day, dbDate } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { deferred } from '../setup/permits';

interface Period {
  from: string;
  to: string;
  inflows: {
    invoiced: string;
    projected: string;
    dues: string;
    expected: string;
    inTransit: string;
    total: string;
  };
  outflows: {
    vendorInvoices: string;
    contractPayments: string;
    purchases: string;
    disbursements: string;
    retentions: string;
    total: string;
  };
  net: string;
  closing: string;
  belowMinimum: boolean;
}
interface Forecast {
  asOf: string;
  by: string;
  opening: { total: string; accounts: { id: string; balance: string }[] };
  collection: {
    rate: number | null;
    basis: string;
    from: string;
    to: string;
    due: string;
    collected: string;
  };
  spending: { total: string; daily: string };
  liquidityDays: number | null;
  minimumCash: string | null;
  belowMinimumNow: boolean;
  firstBelowMinimum: string | null;
  periodsBelowMinimum: number;
  overdue: {
    payables: { count: number; amount: string };
    receivables: string;
  };
  disputed: string;
  periods: Period[];
  totals: { inflows: string; outflows: string; net: string; closing: string };
}

/**
 * ADR 0091: the cash flow forecast — the accounts' balances as the opening
 * position, what payables schedules out, what the residents' dues bring in
 * at the collection rate of the 90 days before today — and liquidity: the
 * days of spending the cash covers on the dashboard, the minimum cash and
 * its notice, the realised cash flow report.
 */
describe('Cash flow and liquidity (ADR 0091)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;
  let unitId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [
        { category: 'maintenance', amount: '500000.00' },
        { category: 'cleaning', amount: '120000.00' },
      ],
    );
    await f
      .http('patch', '/staff/governance/settings', s.manager.token, {
        items: [{ type: 'major_contract', threshold: '100000.00' }],
      })
      .expect(200);
    unitId = (await f.fin.unit(s.c, 'A')).id;
  }, 240_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  const acc = () => s.accountant.token;
  const http = (
    method: 'get' | 'post' | 'patch' | 'put',
    path: string,
    token: string,
    body?: object,
  ) => f.http(method, path, token, body);
  const forecast = async (q = '') =>
    (await http('get', `/staff/finance/cash-flow${q}`, acc()).expect(200))
      .body as Forecast;
  /** The period a day falls in. */
  const periodOf = (fc: Forecast, d: string) =>
    fc.periods.find((p) => d >= p.from && d <= p.to)!;
  const sumOf = (fc: Forecast, pick: (p: Period) => string) =>
    fc.periods
      .reduce((a, p) => a.add(pick(p)), new Prisma.Decimal(0))
      .toFixed(2);
  const maintenance = () =>
    budget.lines.find((l) => l.category === 'maintenance')!;
  const cleaning = () => budget.lines.find((l) => l.category === 'cleaning')!;
  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) => f.inTx(s.c, fn);

  let counter = 0;
  /** A unit's invoice of `total`, due on `dueOn`: its id. */
  const invoice = (dueOn: string, total: string) =>
    inTx(async (tx) => {
      const batchId = newId();
      await tx.invoiceBatch.create({
        data: {
          id: batchId,
          tenantId: s.c.tenantId,
          target: 'unit',
          unitId,
          kind: 'other',
          unitCount: 1,
          issuedOn: dbDate(dueOn < day(0) ? dueOn : day(0)),
          dueOn: dbDate(dueOn),
          createdById: s.accountant.id,
        },
      });
      const id = newId();
      await tx.invoice.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          number: 900_000 + ++counter,
          batchId,
          unitId,
          kind: 'other',
          total: new Prisma.Decimal(total),
          currency: 'EGP',
          issuedOn: dbDate(dueOn < day(0) ? dueOn : day(0)),
          dueOn: dbDate(dueOn),
          createdById: s.accountant.id,
        },
      });
      await tx.invoiceLine.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          invoiceId: id,
          position: 1,
          descriptionEn: 'Dues',
          descriptionAr: 'مستحقات',
          amount: new Prisma.Decimal(total),
        },
      });
      return id;
    });

  describe('with no history', () => {
    it('no account and no dues in the window: no rate, no resident money expected, no liquidity days', async () => {
      await invoice(day(2), '1000.00');
      const fc = await forecast();
      expect(fc.by).toBe('week');
      expect(fc.periods).toHaveLength(13);
      expect(fc.periods[0].from).toBe(clock().today);
      expect(fc.collection).toMatchObject({
        rate: null,
        basis: 'no_history',
        due: '0.00',
        from: day(-90),
        to: day(-1),
      });
      const p = periodOf(fc, day(2));
      expect(p.inflows).toMatchObject({
        invoiced: '1000.00',
        dues: '1000.00',
        expected: '0.00',
      });
      expect(fc.opening).toEqual({ total: '0.00', accounts: [] });
      expect(fc.liquidityDays).toBeNull();
      const dash = await http('get', '/staff/dashboard', m()).expect(200);
      expect(
        (dash.body as { liquidityDays: unknown }).liquidityDays,
      ).toBeNull();
    });

    it('a month forecast runs to twelve months; more is refused', async () => {
      const fc = await forecast('?by=month&periods=12');
      expect(fc.periods).toHaveLength(12);
      expect(fc.periods[0].to.slice(0, 7)).toBe(clock().today.slice(0, 7));
      const res = await http(
        'get',
        '/staff/finance/cash-flow?by=month&periods=13',
        acc(),
      ).expect(400);
      expect(err(res).fields).toEqual([
        {
          field: 'periods',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 12 },
        },
      ]);
    });
  });

  describe('the residents’ dues', () => {
    it('the rate is what the window’s invoices asked against what is paid of them; overdue and disputed dues are shown, not counted; office cash not handed in is on its way', async () => {
      const paidPart = await invoice(day(-20), '1000.00');
      // Outside the window: overdue, not in the rate.
      await invoice(day(-100), '500.00');
      const disputed = await invoice(day(4), '300.00');
      await inTx(async (tx) => {
        const paymentId = newId();
        await tx.financePayment.create({
          data: {
            id: paymentId,
            tenantId: s.c.tenantId,
            kind: 'payment',
            unitId,
            channel: 'office',
            method: 'cash',
            amount: new Prisma.Decimal('600.00'),
            currency: 'EGP',
            paidOn: dbDate(day(0)),
            receiptNumber: 800_000 + ++counter,
            receiptCode: randomBytes(16).toString('base64url'),
            recordedById: s.accountant.id,
          },
        });
        await tx.financeAllocation.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            paymentId,
            invoiceId: paidPart,
            amount: new Prisma.Decimal('600.00'),
          },
        });
        await tx.invoiceDispute.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            invoiceId: disputed,
            unitId,
            openedById: s.accountant.id,
            reasonCode: 'wrong_amount',
            text: 'The amount is wrong',
          },
        });
      });
      const fc = await forecast();
      expect(fc.collection).toMatchObject({
        rate: 0.6,
        basis: 'window',
        due: '1000.00',
        collected: '600.00',
      });
      expect(fc.overdue.receivables).toBe('900.00');
      expect(fc.disputed).toBe('300.00');
      const p = periodOf(fc, day(2));
      expect(p.inflows).toMatchObject({
        invoiced: '1000.00',
        expected: expectedOf(p.inflows.dues, 0.6).toFixed(2),
      });
      // The 600 of office cash is custody (ADR 0085), not in any account yet.
      expect(fc.periods[0].inflows.inTransit).toBe('600.00');
      for (const q of fc.periods)
        expect(q.inflows.expected).toBe(
          expectedOf(q.inflows.dues, 0.6).toFixed(2),
        );
    });

    it('the billing plans’ periods not issued yet are projected, each unit at its amount, an excluded unit left out', async () => {
      const first = addDays(`${clock().today.slice(0, 7)}-01`, 40).slice(0, 7);
      const startsOn = `${first}-01`;
      const plan = (
        await http('post', '/staff/billing-plans', acc(), {
          nameEn: 'Service charge',
          nameAr: 'رسوم الخدمة',
          kind: 'service_charge',
          frequency: 'monthly',
          amount: '250.00',
          startsOn,
          issueDaysBefore: 5,
          dueDaysAfterIssue: 10,
        }).expect(201)
      ).body as { id: string };
      const units = await inTx((tx) =>
        tx.unit.findMany({ select: { id: true } }),
      );
      // One unit pays more, one is left out.
      await inTx(async (tx) => {
        await tx.billingPlanOverride.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            planId: plan.id,
            unitId: units[0].id,
            amount: new Prisma.Decimal('400.00'),
            excluded: false,
            updatedById: s.accountant.id,
          },
        });
        if (units[1])
          await tx.billingPlanOverride.create({
            data: {
              id: newId(),
              tenantId: s.c.tenantId,
              planId: plan.id,
              unitId: units[1].id,
              excluded: true,
              updatedById: s.accountant.id,
            },
          });
      });
      const fc = await forecast('?by=month&periods=6');
      const periods = planPeriods(
        {
          frequency: 'monthly',
          startsOn,
          issueDaysBefore: 5,
          dueDaysAfterIssue: 10,
        },
        1,
        clock().today,
        fc.periods[5].to,
      );
      const each = new Prisma.Decimal(250)
        .mul(units.length - (units[1] ? 2 : 1))
        .add(400);
      expect(sumOf(fc, (p) => p.inflows.projected)).toBe(
        each.mul(periods.length).toFixed(2),
      );
      for (const d of periods)
        expect(
          new Prisma.Decimal(periodOf(fc, d.dueOn).inflows.projected).gte(each),
        ).toBe(true);
    });
  });

  describe('what payables schedules', () => {
    it('schedule payments and approved invoices leave less their retention, held to the contract’s end; a purchase’s commitment and an advance asked for count; nothing is counted twice', async () => {
      const vendorId = (
        (
          await http('post', '/staff/vendors', m(), {
            name: `Cash flow vendor ${uniqueSuffix()}`,
            categories: ['maintenance'],
          }).expect(201)
        ).body as { id: string }
      ).id;
      const contract = (
        await http('post', '/maintenance/contracts', m(), {
          code: `CF-${uniqueSuffix()}`,
          kind: 'amc',
          vendorId,
          startsOn: budget.startsOn,
          endsOn: addDays(budget.endsOn, 60),
          annualValue: '60000.00',
          budgetLineId: maintenance().id,
          retentionPct: '10',
        }).expect(201)
      ).body as { id: string; endsOn: string };
      const pays = (
        (
          await http(
            'put',
            `/maintenance/contracts/${contract.id}/payments`,
            m(),
            {
              payments: [
                { dueOn: day(1), amount: '1000.00' },
                { dueOn: day(8), amount: '2000.00' },
              ],
            },
          ).expect(200)
        ).body as { data: { id: string; dueOn: string }[] }
      ).data;
      const second = pays.find((p) => p.dueOn === day(8))!;
      const inv = (
        await deferred(
          (async () =>
            http('post', '/staff/finance/vendor-invoices', acc(), {
              vendorNumber: `CF-${uniqueSuffix()}`,
              issuedOn: day(0),
              dueOn: day(10),
              invoiceFileId: await f.invoice(s.accountant),
              contractId: contract.id,
              contractPaymentId: second.id,
              lines: [{ description: 'Service', amount: '2000.00' }],
            }))(),
        ).expect(201)
      ).body as { id: string };
      await http(
        'post',
        `/staff/finance/vendor-invoices/${inv.id}/approve`,
        m(),
        {},
      ).expect(200);
      await http(
        'post',
        `/staff/finance/contract-payables/${contract.id}/disbursements`,
        acc(),
        { kind: 'advance', amount: '500.00' },
      ).expect(201);
      const pr = (
        await http('post', '/staff/purchase-requests', acc(), {
          title: 'Floor polish',
          estimatedAmount: '4000',
          budgetLineId: cleaning().id,
        }).expect(201)
      ).body as { id: string };
      await http(
        'post',
        `/staff/purchase-requests/${pr.id}/approve`,
        m(),
        {},
      ).expect(200);

      const fc = await forecast('?by=month&periods=12');
      expect(sumOf(fc, (p) => p.outflows.contractPayments)).toBe('900.00');
      expect(periodOf(fc, day(1)).outflows.contractPayments).not.toBe('0.00');
      expect(sumOf(fc, (p) => p.outflows.vendorInvoices)).toBe('1800.00');
      expect(periodOf(fc, day(10)).outflows.vendorInvoices).not.toBe('0.00');
      expect(sumOf(fc, (p) => p.outflows.purchases)).toBe('4000.00');
      expect(fc.periods[0].outflows.disbursements).toBe('500.00');
      // 10 % of each: held back now, released at the contract's end.
      expect(sumOf(fc, (p) => p.outflows.retentions)).toBe('300.00');
      expect(periodOf(fc, contract.endsOn).outflows.retentions).toBe('300.00');
      expect(fc.overdue.payables).toEqual({ count: 0, amount: '0.00' });
      for (const p of fc.periods)
        expect(p.net).toBe(
          new Prisma.Decimal(p.inflows.total).sub(p.outflows.total).toFixed(2),
        );
    });
  });

  describe('liquidity', () => {
    it('the days of spending the cash covers: the accounts’ balance over the window’s daily spending, the same on the dashboard', async () => {
      const bank = (
        await http('post', '/staff/finance/cash-accounts', m(), {
          kind: 'bank',
          name: 'Cash flow bank',
          openedOn: day(0),
          openingBalance: '9000.00',
        }).expect(201)
      ).body as { id: string };
      await inTx(async (tx) => {
        const fileId = newId();
        const now = new Date();
        await tx.storedFile.create({
          data: {
            id: fileId,
            tenantId: s.c.tenantId,
            purpose: 'expense_invoice',
            contentType: 'application/pdf',
            sizeBytes: 100,
            status: 'ready',
            uploadExpiresAt: now,
            finalizedAt: now,
            attachedAt: now,
          },
        });
        await tx.financeExpense.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            number: 700_000 + ++counter,
            budgetLineId: maintenance().id,
            vendor: 'A vendor',
            amount: new Prisma.Decimal('900.00'),
            spentOn: dbDate(day(-10)),
            invoiceFileId: fileId,
            recordedById: s.accountant.id,
            recordedAt: now,
          },
        });
      });
      const fc = await forecast();
      expect(fc.opening.total).toBe('9000.00');
      expect(fc.opening.accounts).toEqual([
        expect.objectContaining({ id: bank.id, balance: '9000.00' }),
      ]);
      expect(fc.spending).toMatchObject({ total: '900.00', daily: '10.00' });
      // 9 000 over 10 a day.
      expect(fc.liquidityDays).toBe(900);
      const dash = await http('get', '/staff/dashboard', m()).expect(200);
      expect((dash.body as { liquidityDays: number }).liquidityDays).toBe(900);
      // A supervisor reads the dashboard but not the cash.
      const sup = await f.fin.who(
        s.c,
        (await gateHelpers(h).guard(s.c, 'maintenance_supervisor')).id,
        'staff',
      );
      const theirs = await http('get', '/staff/dashboard', sup.token).expect(
        200,
      );
      expect(
        (theirs.body as { liquidityDays: unknown }).liquidityDays,
      ).toBeNull();
      await http('get', '/staff/finance/cash-flow', sup.token).expect(403);
    });
  });

  describe('the minimum cash', () => {
    const notices = () =>
      inTx((tx) =>
        tx.notification.count({
          where: { accountId: s.accountant.id, kind: 'finance.cash_low' },
        }),
      );
    const sweep = () =>
      h.moduleRef.get(SweepRunner).run(CASH_FLOW_SWEEP, new Date());

    it('is set by who keeps the treasury and audited; a period closing below it is flagged and the dashboard raises it', async () => {
      expect(h.moduleRef.get(SweepRunner).intervalOf(CASH_FLOW_SWEEP)).toBe(
        CASH_FLOW_SWEEP_INTERVAL_MS,
      );
      expect(
        (
          await http('get', '/staff/finance/cash-flow/settings', acc()).expect(
            200,
          )
        ).body,
      ).toEqual({ minimumCash: null, lowSince: null, toldAt: null });
      const bad = await http(
        'patch',
        '/staff/finance/cash-flow/settings',
        acc(),
        {
          minimumCash: '-5',
        },
      ).expect(400);
      expect(err(bad).fields?.[0]).toMatchObject({ field: 'minimumCash' });
      // Below the 9 000 on hand, above what the forecast leaves after its outflows.
      const set = await http(
        'patch',
        '/staff/finance/cash-flow/settings',
        acc(),
        { minimumCash: '5000' },
      ).expect(200);
      expect(set.body).toMatchObject({ minimumCash: '5000.00' });
      const audit = await inTx((tx) =>
        tx.auditLog.findFirst({
          where: {
            action: 'cash_flow.settings_changed',
            targetId: s.c.tenantId,
          },
          orderBy: { occurredAt: 'desc' },
        }),
      );
      expect(audit?.changes).toEqual({
        minimumCash: { from: null, to: '5000.00' },
      });
      const fc = await forecast('?by=month&periods=12');
      expect(fc.minimumCash).toBe('5000.00');
      expect(fc.belowMinimumNow).toBe(false);
      const below = fc.periods.filter((p) => p.belowMinimum);
      expect(below.length).toBe(fc.periodsBelowMinimum);
      for (const p of fc.periods)
        expect(p.belowMinimum).toBe(new Prisma.Decimal(p.closing).lt(5000));
      expect(fc.firstBelowMinimum).toBe(below[0]?.from ?? null);
    });

    it('below it now is critical; two sweeps at once tell once; a dip is told once, again only a day after the last notice', async () => {
      await http('patch', '/staff/finance/cash-flow/settings', acc(), {
        minimumCash: '20000',
      }).expect(200);
      const needs = await http('get', '/staff/dashboard/needs-you', m()).expect(
        200,
      );
      expect(
        (needs.body as { alerts: { code: string; severity: string }[] }).alerts,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            section: 'finance',
            code: 'cash_below_minimum',
            severity: 'critical',
          }),
        ]),
      );
      const before = await notices();
      await Promise.all([sweep(), sweep()]);
      expect((await notices()) - before).toBe(1);
      const told = await inTx((tx) =>
        tx.notification.findFirst({
          where: { accountId: s.accountant.id, kind: 'finance.cash_low' },
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(told?.params).toEqual({ belowFrom: clock().today });
      await sweep();
      expect((await notices()) - before).toBe(1);
      // Eased: back above it, silently; a new dip within the day waits.
      await http('patch', '/staff/finance/cash-flow/settings', acc(), {
        minimumCash: '1',
      }).expect(200);
      await sweep();
      expect(
        (
          await http('get', '/staff/finance/cash-flow/settings', acc()).expect(
            200,
          )
        ).body,
      ).toMatchObject({ minimumCash: '1.00', lowSince: null });
      await http('patch', '/staff/finance/cash-flow/settings', acc(), {
        minimumCash: '20000',
      }).expect(200);
      await sweep();
      expect((await notices()) - before).toBe(1);
      await inTx(
        (tx) =>
          tx.$executeRaw`UPDATE finance_settings
                          SET cash_low_told_at = cash_low_told_at - interval '25 hours'`,
      );
      await sweep();
      expect((await notices()) - before).toBe(2);
      // Turned off, the dip ends.
      await http('patch', '/staff/finance/cash-flow/settings', acc(), {
        minimumCash: null,
      }).expect(200);
      expect(
        (
          await http('get', '/staff/finance/cash-flow/settings', acc()).expect(
            200,
          )
        ).body,
      ).toMatchObject({ minimumCash: null, lowSince: null });
    });

    it('is the treasury’s to set: the forecast’s readers alone may not', async () => {
      const t = await f.fin.who(
        s.c,
        (await gateHelpers(h).guard(s.c, 'maintenance_supervisor')).id,
        'staff',
      );
      await http('patch', '/staff/finance/cash-flow/settings', t.token, {
        minimumCash: '10',
      }).expect(403);
    });
  });

  describe('the export and the report', () => {
    it('the forecast as CSV, a row a period', async () => {
      const res = await http(
        'get',
        '/staff/finance/cash-flow/export?by=week&periods=4',
        acc(),
      ).expect(200);
      expect(res.headers['cache-control']).toContain('no-store');
      const lines = res.text
        .replace(/^\uFEFF/, '')
        .trim()
        .split(/\r?\n/);
      expect(lines[0]).toBe(
        'from,to,invoiced,projected,expected,in_transit,inflows,vendor_invoices,contract_payments,purchases,disbursements,retentions,outflows,net,closing,below_minimum',
      );
      expect(lines).toHaveLength(5);
    });

    it('the realised cash flow: money into and out of the accounts by month, kind or account, transfers and openings left out', async () => {
      const box = (
        await http('post', '/staff/finance/cash-accounts', m(), {
          kind: 'cash',
          name: 'Cash flow box',
          openedOn: day(0),
        }).expect(201)
      ).body as { id: string };
      const bank = (
        await http('get', '/staff/finance/cash-accounts', m()).expect(200)
      ).body as { data: { id: string; name: string }[] };
      const bankId = bank.data.find((a) => a.name === 'Cash flow bank')!.id;
      await http('post', '/staff/finance/cash-transfers', m(), {
        fromAccountId: bankId,
        toAccountId: box.id,
        amount: '1000',
        onDay: day(0),
      }).expect(201);
      await http(
        'post',
        `/staff/finance/cash-accounts/${bankId}/adjustments`,
        m(),
        { amount: '-25.50', reasonCode: 'bank_charge', onDay: day(0) },
      ).expect(201);
      await http(
        'post',
        `/staff/finance/cash-accounts/${box.id}/adjustments`,
        m(),
        { amount: '40', reasonCode: 'counting_correction', onDay: day(0) },
      ).expect(201);
      const view = async (groupBy: string) =>
        (
          await http(
            'get',
            `/staff/reports/view?report=cash_flow&groupBy=${groupBy}&from=${day(0)}&to=${day(0)}`,
            acc(),
          ).expect(200)
        ).body as { rows: { values: (string | null)[] }[] };
      expect((await view('kind')).rows.map((r) => r.values)).toEqual([
        ['adjustment', '40.00', '25.50', '14.50'],
      ]);
      expect((await view('account')).rows.map((r) => r.values).sort()).toEqual([
        ['Cash flow bank', '0.00', '25.50', '-25.50'],
        ['Cash flow box', '40.00', '0.00', '40.00'],
      ]);
      expect((await view('month')).rows.map((r) => r.values)).toEqual([
        [clock().today.slice(0, 7), '40.00', '25.50', '14.50'],
      ]);
      const catalog = (await http('get', '/staff/reports', acc()).expect(200))
        .body as { data: { key: string }[] };
      expect(catalog.data.map((r) => r.key)).toContain('cash_flow');
    });
  });
});
