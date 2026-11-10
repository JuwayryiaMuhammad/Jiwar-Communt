import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { addDays } from '../../src/core/common/slots/day-slots';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { quarterLabel, quarterOf } from '../../src/finance/tax/tax-rules';
import { auditReaders } from '../setup/audit';
import { M36_COVERAGE } from '../setup/audit-coverage-split';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { clock, day, dbDate } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { deferred } from '../setup/permits';

/**
 * One scenario per entry of the taxes' and the year-end close's catalog
 * (ADR 0014, 0093): the actor, the compound, ids, codes, rates, days and
 * amounts — the VAT registration number as `{ changed }` only.
 */
const covered = new Set<string>();

describe('Audit coverage — taxes and the year-end close', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;
  let bank: { id: string };
  let vendorId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    read = auditReaders(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [{ category: 'administration', amount: '100000.00' }],
    );
    bank = (
      await f
        .http('post', '/staff/finance/cash-accounts', s.manager.token, {
          kind: 'bank',
          name: `Tax audit bank ${uniqueSuffix()}`,
          openedOn: day(0),
          openingBalance: '20000.00',
        })
        .expect(201)
    ).body as { id: string };
    vendorId = (
      (
        await f
          .http('post', '/staff/vendors', s.manager.token, {
            name: `Tax audit vendor ${uniqueSuffix()}`,
            categories: ['maintenance'],
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  }, 240_000);

  afterAll(() => h.close());

  const acc = () => s.accountant.token;
  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) => f.inTx(s.c, fn);
  const rows = (action: string, targetId: string) =>
    read.tenant(s.c.tenantId, { action, targetId });
  const thisMonth = () => `${day(0).slice(0, 7)}-01`;
  const lastMonth = () => addDays(thisMonth(), -1).slice(0, 7);

  it('tax_settings.updated — codes, rates and amounts; the number as { changed }', async () => {
    await f
      .http('patch', '/staff/finance/tax/settings', acc(), {
        vatRegistered: true,
        vatNumber: '100-200-300',
        taxableKinds: ['service_charge'],
        withholdingEnabled: true,
        servicesRate: '2.50',
      })
      .expect(200);
    expect(
      (await rows('tax_settings.updated', s.c.tenantId)).map((r) => [
        r.actorId,
        r.changes,
      ]),
    ).toEqual([
      [
        s.accountant.id,
        {
          vatRegistered: { from: false, to: true },
          vatNumber: { changed: true },
          taxableKinds: { from: '', to: 'service_charge' },
          withholdingEnabled: { from: false, to: true },
          servicesRate: { from: '3.00', to: '2.50' },
        },
      ],
    ]);
    covered.add('tax_settings.updated');
  });

  it('vendor.withholding_category_set — the category, from and to', async () => {
    await f
      .http('put', `/staff/finance/tax/vendors/${vendorId}`, acc(), {
        withholdingCategory: 'professional',
      })
      .expect(200);
    expect(
      (await rows('vendor.withholding_category_set', vendorId)).map((r) => [
        r.actorId,
        r.changes,
      ]),
    ).toEqual([
      [
        s.accountant.id,
        { withholdingCategory: { from: null, to: 'professional' } },
      ],
    ]);
    covered.add('vendor.withholding_category_set');
  });

  it('withholding_certificate.issued and tax_payment.recorded — a payout’s certificate, the quarter paid', async () => {
    const contract = (
      await f
        .http('post', '/maintenance/contracts', s.manager.token, {
          code: `TAX-${uniqueSuffix()}`,
          kind: 'amc',
          vendorId,
          startsOn: budget.startsOn,
          endsOn: addDays(budget.endsOn, 60),
          annualValue: '50000.00',
          budgetLineId: budget.lines[0].id,
        })
        .expect(201)
    ).body as { id: string };
    const inv = (
      await deferred(
        (async () =>
          f.http('post', '/staff/finance/vendor-invoices', acc(), {
            vendorNumber: `TAX-${uniqueSuffix()}`,
            issuedOn: clock().today,
            dueOn: day(10),
            invoiceFileId: await f.invoice(s.accountant),
            contractId: contract.id,
            lines: [{ description: 'Advice', amount: '2000.00' }],
          }))(),
      ).expect(201)
    ).body as { id: string };
    await f
      .http(
        'post',
        `/staff/finance/vendor-invoices/${inv.id}/approve`,
        s.manager.token,
        {},
      )
      .expect(200);
    const payout = (
      (
        await f
          .http('post', `/staff/finance/vendor-invoices/${inv.id}/pay`, acc(), {
            paidOn: clock().today,
            method: 'bank_transfer',
            cashAccountId: bank.id,
          })
          .expect(200)
      ).body as { payout: { id: string } }
    ).payout;
    const [cert] = await inTx((tx) =>
      tx.financeWithholdingCertificate.findMany({
        where: { payoutId: payout.id },
      }),
    );
    expect(
      (await rows('withholding_certificate.issued', cert.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([
      [
        s.accountant.id,
        {
          number: expect.stringMatching(/^WHT-\d{6}$/) as string,
          payoutId: payout.id,
          vendorId,
          category: 'professional',
          rate: '5.00',
          base: '2000.00',
          amount: '100.00',
          paidOn: day(0),
        },
      ],
    ]);
    covered.add('withholding_certificate.issued');
    const quarter = quarterLabel(quarterOf(day(0)));
    const paid = (
      await f
        .http('post', '/staff/finance/tax/payments', acc(), {
          kind: 'withholding',
          quarter,
          amount: '100.00',
          paidOn: day(0),
          method: 'bank_transfer',
          cashAccountId: bank.id,
          reference: 'ETA-41',
        })
        .expect(201)
    ).body as { id: string; number: string };
    expect(
      (await rows('tax_payment.recorded', paid.id)).map((r) => [
        r.actorId,
        r.metadata,
        r.changes,
      ]),
    ).toEqual([
      [
        s.accountant.id,
        {
          number: paid.number,
          kind: 'withholding',
          declarationId: null,
          quarter,
          amount: '100.00',
          method: 'bank_transfer',
          cashAccountId: bank.id,
          paidOn: day(0),
        },
        { reference: { changed: true } },
      ],
    ]);
    covered.add('tax_payment.recorded');
  });

  it('vat_declaration.declared — the month and its figures', async () => {
    // TEST-ONLY: VAT began last month.
    await inTx((tx) =>
      tx.financeSettings.update({
        where: { tenantId: s.c.tenantId },
        data: { vatSince: dbDate(`${lastMonth()}-01`) },
      }),
    );
    await f
      .http('post', '/staff/finance/gl/periods/close', acc(), {
        month: lastMonth(),
      })
      .expect(201);
    const d = (
      await f
        .http('post', '/staff/finance/tax/vat/declarations', acc(), {
          month: lastMonth(),
        })
        .expect(201)
    ).body as { declarationId: string };
    expect(
      (await rows('vat_declaration.declared', d.declarationId)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([
      [
        s.accountant.id,
        {
          month: lastMonth(),
          taxableSales: '0.00',
          outputVat: '0.00',
          taxablePurchases: '0.00',
          inputVat: '0.00',
          carriedIn: '0.00',
          netDue: '0.00',
          carriedOut: '0.00',
        },
      ],
    ]);
    covered.add('vat_declaration.declared');
  });

  it('gl_year.closed and gl_year.reopened — the year’s days, its entry and result; the reason', async () => {
    const y = Number(day(0).slice(0, 4)) - 1;
    // TEST-ONLY: last year's dues, written as of then.
    const unitId = (await f.fin.unit(s.c, 'Z')).id;
    await inTx(async (tx) => {
      const batchId = newId();
      const on = dbDate(`${y}-05-10`);
      await tx.invoiceBatch.create({
        data: {
          id: batchId,
          tenantId: s.c.tenantId,
          target: 'unit',
          unitId,
          kind: 'other',
          unitCount: 1,
          issuedOn: on,
          dueOn: on,
          createdById: s.accountant.id,
        },
      });
      const id = newId();
      await tx.invoice.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          number: 700_000 + (Date.now() % 90_000),
          batchId,
          unitId,
          kind: 'other',
          total: '750.00',
          currency: 'EGP',
          issuedOn: on,
          dueOn: on,
          createdById: s.accountant.id,
        },
      });
      await tx.invoiceLine.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          invoiceId: id,
          position: 1,
          descriptionEn: 'Other',
          descriptionAr: 'أخرى',
          amount: '750.00',
        },
      });
    });
    await f
      .http('post', '/staff/finance/gl/periods/close', acc(), {
        month: `${y}-12`,
      })
      .expect(201);
    await f
      .http('post', '/staff/finance/gl/years/close', acc(), {
        startsOn: `${y}-01-01`,
      })
      .expect(201);
    const [close] = await inTx((tx) =>
      tx.glYearClose.findMany({ where: { startsOn: dbDate(`${y}-01-01`) } }),
    );
    expect(
      (await rows('gl_year.closed', close.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([
      [
        s.accountant.id,
        {
          startsOn: `${y}-01-01`,
          endsOn: `${y}-12-31`,
          entryId: close.entryId,
          revenue: '750.00',
          expenses: '0.00',
          result: '750.00',
        },
      ],
    ]);
    covered.add('gl_year.closed');
    await f
      .http('post', '/staff/finance/gl/years/reopen', s.manager.token, {
        startsOn: `${y}-01-01`,
        reasonCode: 'audit_finding',
      })
      .expect(201);
    const after = await inTx((tx) =>
      tx.glYearClose.findUniqueOrThrow({ where: { id: close.id } }),
    );
    expect(
      (await rows('gl_year.reopened', close.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([
      [
        s.manager.id,
        {
          startsOn: `${y}-01-01`,
          reasonCode: 'audit_finding',
          reversalEntryId: after.reversalEntryId,
        },
      ],
    ]);
    covered.add('gl_year.reopened');
  });

  describe('catalog completeness', () => {
    it('every entry of taxes and the year-end close has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M36_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M36_COVERAGE].sort());
    });
  });
});
