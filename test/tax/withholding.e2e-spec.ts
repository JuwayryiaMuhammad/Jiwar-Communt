import { Prisma } from '@prisma/client';
import { addDays } from '../../src/core/common/slots/day-slots';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { quarterLabel, quarterOf } from '../../src/finance/tax/tax-rules';
import { err } from '../api/request';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { clock, day } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { deferred } from '../setup/permits';

interface Payout {
  id: string;
  gross: string;
  retentionHeld: string;
  withholding: string;
  withholdingRate: string;
  withholdingBase: string;
  withholdingCategory: string | null;
  net: string;
}

/**
 * ADR 0093: withholding is off until the compound turns it on; then a
 * vendor's payout withholds its category's rate (the invoice's, else the
 * vendor's, else by its trades) on the invoice's subtotal, unless exempt or
 * below the threshold, deducts it from what is paid, posts it to
 * withholding payable and writes the vendor's certificate. The quarter's
 * tax is reported, and paid from a treasury account.
 */
describe('Taxes — withholding on vendors’ payouts (ADR 0093)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;
  let bank: { id: string };
  let lawyer: string;
  let cleaner: string;
  let lawyerContract: string;
  let cleanerContract: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [{ category: 'administration', amount: '500000.00' }],
    );
    bank = (
      await f
        .http('post', '/staff/finance/cash-accounts', s.manager.token, {
          kind: 'bank',
          name: `WHT bank ${uniqueSuffix()}`,
          openedOn: day(0),
          openingBalance: '100000.00',
        })
        .expect(201)
    ).body as { id: string };
    const vendor = async (categories: string[]) =>
      (
        (
          await f
            .http('post', '/staff/vendors', s.manager.token, {
              name: `WHT ${categories[0]} ${uniqueSuffix()}`,
              legalName: `WHT ${categories[0]} LLC ${uniqueSuffix()}`,
              taxNumber: '555-111-222',
              categories,
            })
            .expect(201)
        ).body as { id: string }
      ).id;
    lawyer = await vendor(['professional']);
    cleaner = await vendor(['cleaning']);
    const contract = async (vendorId: string, retentionPct?: string) =>
      (
        (
          await f
            .http('post', '/maintenance/contracts', s.manager.token, {
              code: `WHT-${uniqueSuffix()}`,
              kind: 'amc',
              vendorId,
              startsOn: budget.startsOn,
              endsOn: addDays(budget.endsOn, 60),
              annualValue: '120000.00',
              budgetLineId: budget.lines[0].id,
              ...(retentionPct ? { retentionPct } : {}),
            })
            .expect(201)
        ).body as { id: string }
      ).id;
    lawyerContract = await contract(lawyer);
    cleanerContract = await contract(cleaner, '10');
  }, 240_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  const acc = () => s.accountant.token;
  const http = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    token: string,
    body?: object,
  ) => f.http(method, path, token, body);
  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) => f.inTx(s.c, fn);
  const short = (source: string, sourceId: string) =>
    inTx(async (tx) =>
      (
        await tx.$queryRaw<
          {
            key: string | null;
            debit: Prisma.Decimal;
            credit: Prisma.Decimal;
          }[]
        >`
          SELECT a.system_key AS key, l.debit, l.credit
            FROM gl_lines l
            JOIN gl_entries e ON e.id = l.entry_id
            JOIN gl_accounts a ON a.id = l.account_id
           WHERE e.source = ${source} AND e.source_id = ${sourceId}::uuid
           ORDER BY l.line_no`
      ).map((r) => [r.key, r.debit.sub(r.credit).toFixed(2)]),
    );
  /** A vendor's invoice recorded, approved and paid out of the bank: its payout. */
  async function paid(
    contractId: string,
    amount: string,
    over: Record<string, unknown> = {},
  ): Promise<Payout> {
    const inv = (
      await deferred(
        (async () =>
          http('post', '/staff/finance/vendor-invoices', acc(), {
            vendorNumber: `WHT-${uniqueSuffix()}`,
            issuedOn: clock().today,
            dueOn: day(10),
            invoiceFileId: await f.invoice(s.accountant),
            contractId,
            lines: [{ description: 'Work', amount, taxCode: 'vat_14' }],
            ...over,
          }))(),
      ).expect(201)
    ).body as { id: string };
    await http(
      'post',
      `/staff/finance/vendor-invoices/${inv.id}/approve`,
      m(),
      {},
    ).expect(200);
    return (
      (
        await http(
          'post',
          `/staff/finance/vendor-invoices/${inv.id}/pay`,
          acc(),
          {
            paidOn: clock().today,
            method: 'bank_transfer',
            cashAccountId: bank.id,
          },
        ).expect(200)
      ).body as { payout: Payout }
    ).payout;
  }
  const quarter = () => quarterLabel(quarterOf(day(0)));

  it('off by default: a payout withholds nothing', async () => {
    const p = await paid(lawyerContract, '1000.00');
    expect(p).toMatchObject({
      gross: '1140.00',
      withholding: '0.00',
      withholdingCategory: null,
      net: '1140.00',
    });
  });

  it('on, a payout withholds its category’s rate on the subtotal, deducted from what is paid, to withholding payable, with its certificate', async () => {
    await http('patch', '/staff/finance/tax/settings', acc(), {
      withholdingEnabled: true,
    }).expect(200);
    // A professional's fees: 5 % of 10000.
    const fees = await paid(lawyerContract, '10000.00');
    expect(fees).toMatchObject({
      gross: '11400.00',
      withholding: '500.00',
      withholdingRate: '5.00',
      withholdingBase: '10000.00',
      withholdingCategory: 'professional',
      net: '10900.00',
    });
    expect(await short('vendor_payout', fees.id)).toEqual([
      ['payables', '11400.00'],
      ['withholding_payable', '-500.00'],
      [`cash:${bank.id}`, '-10900.00'],
    ]);
    // A cleaner's services: 3 % of 2000, with the contract's retention.
    const work = await paid(cleanerContract, '2000.00');
    expect(work).toMatchObject({
      gross: '2280.00',
      retentionHeld: '228.00',
      withholding: '60.00',
      withholdingCategory: 'services',
      net: '1992.00',
    });
    // Below the threshold: nothing.
    expect((await paid(cleanerContract, '299.00')).withholding).toBe('0.00');
    // The invoice's own category wins: exempt.
    expect(
      (
        await paid(lawyerContract, '5000.00', {
          withholdingCategory: 'exempt',
        })
      ).withholding,
    ).toBe('0.00');
    const certs = (
      await http(
        'get',
        `/staff/finance/tax/withholding/certificates?quarter=${quarter()}`,
        acc(),
      ).expect(200)
    ).body as {
      data: {
        id: string;
        number: string;
        payoutId: string;
        vendorTaxNumber: string | null;
        category: string;
        amount: string;
      }[];
    };
    expect(certs.data.map((c) => [c.payoutId, c.category, c.amount])).toEqual([
      [work.id, 'services', '60.00'],
      [fees.id, 'professional', '500.00'],
    ]);
    expect(certs.data[0].number).toMatch(/^WHT-\d{6}$/);
    expect(certs.data[0].vendorTaxNumber).toBe('555-111-222');
    const pdf = await http(
      'get',
      `/staff/finance/tax/withholding/certificates/${certs.data[1].id}/pdf`,
      acc(),
    ).expect(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.headers['cache-control']).toBe('no-store');
  });

  it('a vendor’s category is set for it; its next payout withholds by it', async () => {
    const set = (
      await http('put', `/staff/finance/tax/vendors/${cleaner}`, acc(), {
        withholdingCategory: 'supplies',
      }).expect(200)
    ).body as { withholdingCategory: string; effectiveCategory: string };
    expect(set).toMatchObject({
      withholdingCategory: 'supplies',
      effectiveCategory: 'supplies',
    });
    expect(
      err(
        await http('put', `/staff/finance/tax/vendors/${cleaner}`, acc(), {
          withholdingCategory: 'none',
        }).expect(400),
      ).fields?.[0],
    ).toMatchObject({ field: 'withholdingCategory', code: 'INVALID_VALUE' });
    const p = await paid(cleanerContract, '1000.00');
    expect([p.withholdingCategory, p.withholding]).toEqual([
      'supplies',
      '10.00',
    ]);
    await http('put', `/staff/finance/tax/vendors/${cleaner}`, acc(), {
      withholdingCategory: null,
    }).expect(200);
  });

  it('the quarter’s tax is reported and paid from the bank against withholding payable, no more than is open', async () => {
    const [q] = (
      (
        await http(
          'get',
          '/staff/finance/tax/withholding/quarters',
          acc(),
        ).expect(200)
      ).body as {
        data: {
          quarter: string;
          withheld: string;
          open: string;
          certificates: number;
        }[];
      }
    ).data;
    expect(q).toMatchObject({
      quarter: quarter(),
      certificates: 3,
      withheld: '570.00',
      open: '570.00',
    });
    const pay = (amount: string) =>
      http('post', '/staff/finance/tax/payments', acc(), {
        kind: 'withholding',
        quarter: quarter(),
        amount,
        paidOn: day(0),
        method: 'bank_transfer',
        cashAccountId: bank.id,
      });
    expect(err(await pay('600').expect(409))).toMatchObject({
      code: 'TAX_PAYMENT_EXCEEDED',
      params: { open: '570.00' },
    });
    const paidTax = (await pay('570').expect(201)).body as {
      id: string;
      quarter: string;
    };
    expect(paidTax.quarter).toBe(quarter());
    expect(await short('tax_payment', paidTax.id)).toEqual([
      ['withholding_payable', '570.00'],
      [`cash:${bank.id}`, '-570.00'],
    ]);
    const report = (
      await http(
        'get',
        `/staff/reports/view?report=tax_withholding&from=${day(0)}&to=${day(0)}&groupBy=category`,
        acc(),
      ).expect(200)
    ).body as { rows: { values: (string | null)[] }[] };
    expect(report.rows.map((r) => r.values)).toEqual([
      ['professional', '1', '10000.00', '500.00'],
      ['services', '1', '2000.00', '60.00'],
      ['supplies', '1', '1000.00', '10.00'],
    ]);
    const byVendor = (
      await http(
        'get',
        `/staff/reports/view?report=tax_withholding&from=${day(0)}&to=${day(0)}`,
        acc(),
      ).expect(200)
    ).body as { rows: { values: (string | null)[] }[] };
    expect(byVendor.rows).toHaveLength(2);
    expect(byVendor.rows[0].values[1]).toBe('555-111-222');
    const r = (
      await http('get', '/staff/finance/gl/reconciliation', acc()).expect(200)
    ).body as {
      balanced: boolean;
      checks: { key: string; difference: string }[];
    };
    expect(r.balanced).toBe(true);
    for (const c of r.checks)
      expect([c.key, c.difference]).toEqual([c.key, '0.00']);
  });
});
