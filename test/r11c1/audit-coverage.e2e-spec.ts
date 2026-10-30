import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { auditReaders } from '../setup/audit';
import { R11C1A_COVERAGE } from '../setup/audit-coverage-split';
import type { Compound } from '../setup/community';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { at, day } from '../setup/compound-clock';
import {
  activateBudget,
  budgetLineRow,
  budgetRow,
} from '../setup/finance-rows';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const MARKER = 'AUDIT-r11c1-secret';

/**
 * One scenario per entry of money and the unit's catalog (ADR 0014,
 * 0069): actor, target and metadata — codes, ids, days and counts, never
 * the staff's words or anything that names a person.
 */
const covered = new Set<string>();

describe('Audit coverage — money and the unit', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: FinanceSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    read = auditReaders(h);
    s = await f.setUp('R11c-1a Audit Court');
  }, 90_000);

  afterAll(() => h.close());

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) => f.inTx(s.c, fn);

  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  describe('where the fees went', () => {
    it('spending_report.published and .superseded — the budget, its year, the day, how many items and the report replaced; never their words', async () => {
      const budgetId = await inTx(async (tx) => {
        const id = await budgetRow(tx, {
          tenantId: s.c.tenantId,
          createdById: s.c.managerId,
        });
        await budgetLineRow(tx, { tenantId: s.c.tenantId, budgetId: id });
        await activateBudget(tx, {
          tenantId: s.c.tenantId,
          budgetId: id,
          raisedById: s.c.managerId,
        });
        return id;
      });
      const report = (
        await f
          .http('post', '/staff/finance/spending-reports', s.accountant.token, {
            budgetId,
            summaryEn: MARKER,
            summaryAr: MARKER,
            items: [{ textEn: MARKER, textAr: MARKER }],
          })
          .expect(201)
      ).body as { id: string; fiscalYear: number; asOf: string };
      const row = await single(s.c, 'spending_report.published', report.id);
      expect(row).toMatchObject({
        actorId: s.accountant.id,
        metadata: {
          budgetId,
          fiscalYear: report.fiscalYear,
          asOf: report.asOf,
          items: 1,
          supersedesId: null,
        },
      });
      expect(JSON.stringify(row)).not.toContain(MARKER);

      // A newer report supersedes it: both acts are written, ids only.
      const newer = (
        await f
          .http('post', '/staff/finance/spending-reports', s.accountant.token, {
            supersedesId: report.id,
            summaryEn: MARKER,
            summaryAr: MARKER,
          })
          .expect(201)
      ).body as { id: string };
      expect(
        (await single(s.c, 'spending_report.published', newer.id)).metadata,
      ).toMatchObject({ budgetId, supersedesId: report.id });
      const replaced = await single(
        s.c,
        'spending_report.superseded',
        report.id,
      );
      expect(replaced).toMatchObject({
        actorId: s.accountant.id,
        metadata: { budgetId, supersededById: newer.id },
      });
      expect(JSON.stringify(replaced)).not.toContain(MARKER);
    });
  });

  describe('payment plans residents ask for', () => {
    const ask = async (token = s.owner.token) => {
      const { invoiceId } = await f.issue(s.accountant, s.home.id);
      const r = (
        await f
          .http('post', `/invoices/${invoiceId}/plan-requests`, token, {
            months: 3,
          })
          .expect(201)
      ).body as { id: string };
      return { invoiceId, id: r.id };
    };

    it('plan_request.submitted, .withdrawn, .accepted and .declined — the unit, the invoice, the months, the plan, the reason code', async () => {
      const one = await ask();
      expect(await single(s.c, 'plan_request.submitted', one.id)).toMatchObject(
        {
          actorId: s.owner.id,
          metadata: { unitId: s.home.id, invoiceId: one.invoiceId, months: 3 },
        },
      );
      await f
        .http('post', `/plan-requests/${one.id}/withdraw`, s.owner.token)
        .expect(201);
      expect(
        (await single(s.c, 'plan_request.withdrawn', one.id)).metadata,
      ).toEqual({ unitId: s.home.id, invoiceId: one.invoiceId });

      const two = await ask();
      const accepted = (
        await f
          .http(
            'post',
            `/staff/plan-requests/${two.id}/accept`,
            s.accountant.token,
            {
              instalments: [
                { dueOn: day(10), amount: '500' },
                { dueOn: day(40), amount: '500' },
              ],
            },
          )
          .expect(201)
      ).body as { planId: string };
      expect(await single(s.c, 'plan_request.accepted', two.id)).toMatchObject({
        actorId: s.accountant.id,
        metadata: {
          unitId: s.home.id,
          invoiceId: two.invoiceId,
          planId: accepted.planId,
        },
      });

      const three = await ask();
      await f
        .http(
          'post',
          `/staff/plan-requests/${three.id}/decline`,
          s.accountant.token,
          { reasonCode: 'too_many_months' },
        )
        .expect(201);
      expect(
        (await single(s.c, 'plan_request.declined', three.id)).metadata,
      ).toEqual({
        unitId: s.home.id,
        invoiceId: three.invoiceId,
        reasonCode: 'too_many_months',
      });
    });

    it('finance.plan_settings_changed — the most months and the offer’s floor, from and to', async () => {
      await f
        .http('patch', '/staff/finance/plan-settings', s.accountant.token, {
          planMaxMonths: 12,
          planOfferMinAmount: '2500',
        })
        .expect(200);
      expect(
        (await single(s.c, 'finance.plan_settings_changed', s.c.tenantId))
          .changes,
      ).toEqual({
        planMaxMonths: { from: 6, to: 12 },
        planOfferMinAmount: { from: null, to: '2500.00' },
      });
    });
  });

  describe('collector visits', () => {
    const window = (d: number) => ({
      windowStartsAt: at(day(d), 10).toISOString(),
      windowEndsAt: at(day(d), 12).toISOString(),
    });

    it('collector_visit.requested, .assigned, .collected, .failed and .cancelled — the unit, the window, the collector, the payment and amount, the codes; never a name', async () => {
      const collector = await f.who(
        s.c,
        (await gateHelpers(h).guard(s.c, 'collector')).id,
        'staff',
      );
      const home = await f.unit(s.c, 'A');
      const owner = await f.owner(s.c, home.id);
      await f.issue(s.accountant, home.id);
      const ask = async (d: number) =>
        (
          (
            await f
              .http(
                'post',
                `/units/${home.id}/collector-visits`,
                owner.token,
                window(d),
              )
              .expect(201)
          ).body as { id: string }
        ).id;
      const assign = (id: string) =>
        f
          .http(
            'post',
            `/staff/collector-visits/${id}/assign`,
            s.accountant.token,
            {
              collectorId: collector.id,
            },
          )
          .expect(201);

      const one = await ask(1);
      expect(await single(s.c, 'collector_visit.requested', one)).toMatchObject(
        {
          actorId: owner.id,
          metadata: {
            unitId: home.id,
            windowStartsAt: window(1).windowStartsAt,
            windowEndsAt: window(1).windowEndsAt,
          },
        },
      );
      await assign(one);
      expect(
        (await single(s.c, 'collector_visit.assigned', one)).metadata,
      ).toEqual({
        unitId: home.id,
        collectorId: collector.id,
      });
      const done = (
        await f
          .http('post', `/collector/visits/${one}/collected`, collector.token, {
            amount: '400',
          })
          .expect(201)
      ).body as { paymentId: string };
      expect(await single(s.c, 'collector_visit.collected', one)).toMatchObject(
        {
          actorId: collector.id,
          metadata: {
            unitId: home.id,
            paymentId: done.paymentId,
            amount: '400.00',
          },
        },
      );

      const two = await ask(2);
      await assign(two);
      await f
        .http('post', `/collector/visits/${two}/failed`, collector.token, {
          reasonCode: 'no_cash',
        })
        .expect(201);
      expect(
        (await single(s.c, 'collector_visit.failed', two)).metadata,
      ).toEqual({
        unitId: home.id,
        reasonCode: 'no_cash',
        offered: false,
      });

      const three = await ask(3);
      await f
        .http(
          'post',
          `/staff/collector-visits/${three}/cancel`,
          s.accountant.token,
          {
            reasonCode: 'no_collector',
          },
        )
        .expect(201);
      expect(
        (await single(s.c, 'collector_visit.cancelled', three)).metadata,
      ).toEqual({
        unitId: home.id,
        side: 'staff',
        reasonCode: 'no_collector',
      });
      const rows = await read.tenant(s.c.tenantId, { targetId: one });
      const person = await f.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: owner.id } }),
      );
      expect(JSON.stringify(rows)).not.toContain(person.fullName!);
    });

    it('finance.collector_settings_changed — the margin, from and to', async () => {
      await f
        .http(
          'patch',
          '/staff/finance/collector-settings',
          s.accountant.token,
          {
            collectorMargin: '25',
          },
        )
        .expect(200);
      expect(
        (await single(s.c, 'finance.collector_settings_changed', s.c.tenantId))
          .changes,
      ).toEqual({ collectorMargin: { from: '50.00', to: '25.00' } });
    });
  });

  describe('catalog completeness', () => {
    it('every entry of money and the unit has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of R11C1A_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...R11C1A_COVERAGE].sort());
    });
  });
});
