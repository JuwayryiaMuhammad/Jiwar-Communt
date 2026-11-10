import { Prisma } from '@prisma/client';
import { Client } from 'pg';
import { addDays } from '../../src/core/common/slots/day-slots';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { err } from '../api/request';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { at, clock, day, dbDate } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { deferred } from '../setup/permits';
import { required } from '../setup/test-env';

interface VatMonth {
  month: string;
  status: string;
  taxableSales: string;
  outputVat: string;
  taxablePurchases: string;
  inputVat: string;
  carriedIn: string;
  netDue: string;
  carriedOut: string;
  declarationId: string | null;
  paid: string;
  open: string;
}

/**
 * ADR 0093: VAT is off until the compound registers; then each line of a
 * taxable kind's invoice carries its VAT apart from its net, posted to VAT
 * payable, and a credit note takes back its share. The VAT a vendor
 * charged stays part of the cost unless the compound is registered and the
 * category is marked recoverable. A month's VAT is read from the ledger,
 * declared once the ledger closed it, in order and once, and stays
 * declared; what is due is paid from a treasury account.
 */
describe('Taxes — VAT and its monthly declaration (ADR 0093)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;
  let unitId: string;
  let bank: { id: string };
  let vendorId: string;
  let contractId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [
        { category: 'maintenance', amount: '500000.00' },
        { category: 'cleaning', amount: '100000.00' },
      ],
    );
    unitId = (await f.fin.unit(s.c, 'A')).id;
    await f.fin.owner(s.c, unitId);
    bank = (
      await f
        .http('post', '/staff/finance/cash-accounts', s.manager.token, {
          kind: 'bank',
          name: `VAT bank ${uniqueSuffix()}`,
          openedOn: day(0),
          openingBalance: '50000.00',
        })
        .expect(201)
    ).body as { id: string };
    vendorId = (
      (
        await f
          .http('post', '/staff/vendors', s.manager.token, {
            name: `VAT vendor ${uniqueSuffix()}`,
            categories: ['maintenance'],
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    contractId = (
      (
        await f
          .http('post', '/maintenance/contracts', s.manager.token, {
            code: `VAT-${uniqueSuffix()}`,
            kind: 'amc',
            vendorId,
            startsOn: budget.startsOn,
            endsOn: addDays(budget.endsOn, 60),
            annualValue: '90000.00',
            budgetLineId: line('maintenance').id,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
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
  const line = (category: string) =>
    budget.lines.find((l) => l.category === category)!;
  const settings = (body: object) =>
    http('patch', '/staff/finance/tax/settings', acc(), body);
  const thisMonth = () => `${day(0).slice(0, 7)}-01`;
  const lastMonthStart = () => `${addDays(thisMonth(), -1).slice(0, 7)}-01`;
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
  const invoice = async (id: string) =>
    (await http('get', `/staff/invoices/${id}`, acc()).expect(200)).body as {
      total: string;
      net: string;
      vat: string;
      vatRate: string;
      lines: { amount: string; vat: string }[];
      creditNotes: { vat: string }[];
    };
  const vendorInvoice = async (amount: string, taxCode = 'vat_14') =>
    (
      await deferred(
        (async () =>
          http('post', '/staff/finance/vendor-invoices', acc(), {
            vendorNumber: `VAT-${uniqueSuffix()}`,
            issuedOn: clock().today,
            dueOn: day(10),
            invoiceFileId: await f.invoice(s.accountant),
            contractId,
            lines: [{ description: 'Service', amount, taxCode }],
          }))(),
      ).expect(201)
    ).body as { id: string; tax: string; total: string };
  const months = async () =>
    (
      (await http('get', '/staff/finance/tax/vat/months', acc()).expect(200))
        .body as { data: VatMonth[] }
    ).data;

  it('is off by default — 14 %, no taxable kind, no recoverable category; registering needs its number; an invoice before it carries no VAT', async () => {
    expect(
      (await http('get', '/staff/finance/tax/settings', acc()).expect(200))
        .body,
    ).toEqual({
      vatRegistered: false,
      vatNumber: null,
      vatRate: '14.00',
      vatSince: null,
      taxableKinds: [],
      recoverableCategories: [],
      withholdingEnabled: false,
      withholdingRates: {
        supplies: '1.00',
        services: '3.00',
        professional: '5.00',
      },
      withholdingThreshold: '300.00',
    });
    expect(
      err(await settings({ vatRegistered: true }).expect(400)).fields,
    ).toEqual([{ field: 'vatNumber', code: 'FIELD_REQUIRED' }]);
    expect(err(await settings({ vatRate: '0' }).expect(400)).fields).toEqual([
      {
        field: 'vatRate',
        code: 'INVALID_VALUE',
        params: { min: '0.01', max: '100.00' },
      },
    ]);
    await settings({ taxableKinds: ['service_charge'] }).expect(200);
    const { invoiceId } = await f.fin.issue(s.accountant, unitId);
    expect(await invoice(invoiceId)).toMatchObject({
      total: '1000.00',
      net: '1000.00',
      vat: '0.00',
      vatRate: '0.00',
    });
    expect(await months()).toEqual([]);
    await http('patch', '/staff/finance/tax/settings', m(), {
      taxableKinds: [],
    }).expect(200);
  });

  it('registered, each line of a taxable kind’s invoice carries its VAT apart, posted to VAT payable; an untaxed kind’s carries none', async () => {
    const on = (
      await settings({
        vatRegistered: true,
        vatNumber: '123-456-789',
        taxableKinds: ['service_charge'],
      }).expect(200)
    ).body as { vatSince: string; vatRegistered: boolean };
    expect(on).toMatchObject({ vatRegistered: true, vatSince: day(0) });
    const { invoiceId } = await f.fin.issue(s.accountant, unitId, {
      lines: [
        { descriptionEn: 'Dues', descriptionAr: 'مستحقات', amount: '1000' },
        { descriptionEn: 'Pool', descriptionAr: 'حمام', amount: '250' },
      ],
    });
    const inv = await invoice(invoiceId);
    expect(inv).toMatchObject({
      total: '1425.00',
      net: '1250.00',
      vat: '175.00',
      vatRate: '14.00',
    });
    expect(inv.lines.map((l) => [l.amount, l.vat])).toEqual([
      ['1000.00', '140.00'],
      ['250.00', '35.00'],
    ]);
    expect(await short('invoice', invoiceId)).toEqual([
      ['receivables', '1425.00'],
      ['revenue:service_charge', '-1250.00'],
      ['vat_payable', '-175.00'],
    ]);
    const other = await f.fin.issue(s.accountant, unitId, {
      kind: 'maintenance',
    });
    expect(await invoice(other.invoiceId)).toMatchObject({
      total: '1000.00',
      vat: '0.00',
    });
    expect(await short('invoice', other.invoiceId)).toEqual([
      ['receivables', '1000.00'],
      ['revenue:maintenance', '-1000.00'],
    ]);

    // A credit note takes back its share of the VAT.
    const credit = (
      await http('post', `/staff/invoices/${invoiceId}/credit-notes`, acc(), {
        amount: '114',
        reasonCode: 'goodwill',
      }).expect(201)
    ).body as { id: string; vat: string };
    expect(credit.vat).toBe('14.00');
    expect(await short('credit_note', credit.id)).toEqual([
      ['revenue:service_charge', '100.00'],
      ['vat_payable', '14.00'],
      ['receivables', '-114.00'],
    ]);
  });

  it('an instalment plan carries the VAT its credit note took back, each instalment its share', async () => {
    const { invoiceId } = await f.fin.issue(s.accountant, unitId);
    expect((await invoice(invoiceId)).vat).toBe('140.00');
    const plan = (
      await http(
        'post',
        `/staff/invoices/${invoiceId}/instalment-plan`,
        acc(),
        {
          instalments: [
            { dueOn: day(10), amount: '400.00' },
            { dueOn: day(40), amount: '400.00' },
            { dueOn: day(70), amount: '340.00' },
          ],
        },
      ).expect(201)
    ).body as { id: string; instalments: { invoiceId: string }[] };
    const parts = await inTx((tx) =>
      tx.invoice.findMany({
        where: { instalmentPlanId: plan.id },
        orderBy: { instalmentPosition: 'asc' },
        select: { total: true, vat: true, vatRate: true },
      }),
    );
    expect(parts.map((p) => [p.total.toFixed(2), p.vat.toFixed(2)])).toEqual([
      ['400.00', '49.12'],
      ['400.00', '49.12'],
      ['340.00', '41.76'],
    ]);
    expect(parts.every((p) => p.vatRate.toFixed(2) === '14.00')).toBe(true);
    const note = (await invoice(invoiceId)).creditNotes[0];
    expect(note.vat).toBe('140.00');
  });

  it('a vendor’s VAT is part of the cost unless the compound is registered and the category is recoverable; then it is input VAT', async () => {
    const cost = await vendorInvoice('5000.00');
    expect([cost.tax, cost.total]).toEqual(['700.00', '5700.00']);
    await http(
      'post',
      `/staff/finance/vendor-invoices/${cost.id}/approve`,
      m(),
      {},
    ).expect(200);
    expect(await short('vendor_invoice', cost.id)).toEqual([
      ['expense:maintenance', '5700.00'],
      ['payables', '-5700.00'],
    ]);
    await settings({ recoverableCategories: ['maintenance'] }).expect(200);
    const input = await vendorInvoice('1000.00');
    const approved = (
      await http(
        'post',
        `/staff/finance/vendor-invoices/${input.id}/approve`,
        m(),
        {},
      ).expect(200)
    ).body as { vatRecoverable: string };
    expect(approved.vatRecoverable).toBe('140.00');
    expect(await short('vendor_invoice', input.id)).toEqual([
      ['expense:maintenance', '1000.00'],
      ['vat_receivable', '140.00'],
      ['payables', '-1140.00'],
    ]);
    // This month so far: 175 − 14 of output, and the instalments' 140
    // for the 140 their credit note took back; 140 of input.
    const [now] = await months();
    expect(now).toMatchObject({
      month: day(0).slice(0, 7),
      status: 'open',
      taxableSales: '2150.00',
      outputVat: '301.00',
      inputVat: '140.00',
      netDue: '161.00',
      declarationId: null,
    });
  });

  it('a month is declared once the ledger closed it, in order from the month VAT began, once; then it is not reopened', async () => {
    // TEST-ONLY: VAT began last month, when one invoice of 2000 net and a
    // vendor's invoice of 1000 were approved (written as of then).
    const last = lastMonthStart();
    const mid = `${last.slice(0, 7)}-15`;
    await inTx(async (tx) => {
      await tx.financeSettings.update({
        where: { tenantId: s.c.tenantId },
        data: { vatSince: dbDate(last) },
      });
      const batchId = newId();
      await tx.invoiceBatch.create({
        data: {
          id: batchId,
          tenantId: s.c.tenantId,
          target: 'unit',
          unitId,
          kind: 'service_charge',
          unitCount: 1,
          issuedOn: dbDate(mid),
          dueOn: dbDate(mid),
          createdById: s.accountant.id,
        },
      });
      const id = newId();
      await tx.invoice.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          number: 900_000 + (Date.now() % 90_000),
          batchId,
          unitId,
          kind: 'service_charge',
          total: '2280.00',
          vat: '280.00',
          vatRate: '14.00',
          currency: 'EGP',
          issuedOn: dbDate(mid),
          dueOn: dbDate(mid),
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
          amount: '2000.00',
          vat: '280.00',
        },
      });
    });
    const purchase = await vendorInvoice('1000.00');
    await inTx((tx) =>
      tx.financeVendorInvoice.update({
        where: { id: purchase.id },
        data: {
          status: 'approved',
          budgetLineId: line('maintenance').id,
          decidedAt: at(mid, 10),
          decidedById: s.manager.id,
        },
      }),
    );
    expect(await short('vendor_invoice', purchase.id)).toEqual([
      ['expense:maintenance', '1000.00'],
      ['vat_receivable', '140.00'],
      ['payables', '-1140.00'],
    ]);
    const declare = (month: string) =>
      http('post', '/staff/finance/tax/vat/declarations', acc(), { month });
    // Not closed yet.
    expect(err(await declare(last.slice(0, 7)).expect(409))).toMatchObject({
      code: 'TAX_MONTH_NOT_CLOSED',
      params: { month: last.slice(0, 7) },
    });
    await http('post', '/staff/finance/gl/periods/close', acc(), {
      month: last.slice(0, 7),
    }).expect(201);
    expect(err(await declare(day(0).slice(0, 7)).expect(409))).toMatchObject({
      code: 'TAX_MONTH_OUT_OF_ORDER',
      params: { next: last.slice(0, 7) },
    });
    const declared = (await declare(last.slice(0, 7)).expect(201))
      .body as VatMonth;
    expect(declared).toMatchObject({
      month: last.slice(0, 7),
      status: 'declared',
      taxableSales: '2000.00',
      outputVat: '280.00',
      taxablePurchases: '1000.00',
      inputVat: '140.00',
      carriedIn: '0.00',
      netDue: '140.00',
      carriedOut: '0.00',
      paid: '0.00',
      open: '140.00',
    });
    // The input set off against the output: VAT payable keeps what is due.
    expect(await short('vat_declaration', declared.declarationId!)).toEqual([
      ['vat_payable', '140.00'],
      ['vat_receivable', '-140.00'],
    ]);
    expect(err(await declare(last.slice(0, 7)).expect(409)).code).toBe(
      'TAX_MONTH_DECLARED',
    );
    expect(
      err(
        await http('post', '/staff/finance/gl/periods/reopen', m(), {
          month: last.slice(0, 7),
          reasonCode: 'correction',
        }).expect(409),
      ),
    ).toMatchObject({
      code: 'TAX_MONTH_DECLARED',
      params: { month: last.slice(0, 7) },
    });
    // This month: next in order, but not closed.
    expect(err(await declare(day(0).slice(0, 7)).expect(409)).code).toBe(
      'TAX_MONTH_NOT_CLOSED',
    );
    const list = await months();
    expect(list.map((x) => [x.month, x.status])).toEqual([
      [day(0).slice(0, 7), 'open'],
      [last.slice(0, 7), 'declared'],
    ]);
  });

  it('the VAT due is paid from a treasury account against VAT payable, no more than is open', async () => {
    const declared = (await months())[1];
    const pay = (amount: string, over: object = {}) =>
      http('post', '/staff/finance/tax/payments', acc(), {
        kind: 'vat',
        declarationId: declared.declarationId,
        amount,
        paidOn: day(0),
        method: 'bank_transfer',
        cashAccountId: bank.id,
        reference: 'ETA-1',
        ...over,
      });
    expect(
      err(await pay('100', { quarter: '2026-Q1' }).expect(400)).fields,
    ).toEqual([{ field: 'quarter', code: 'FIELD_NOT_ALLOWED' }]);
    expect(err(await pay('200').expect(409))).toMatchObject({
      code: 'TAX_PAYMENT_EXCEEDED',
      params: { open: '140.00' },
    });
    const paid = (await pay('140').expect(201)).body as {
      id: string;
      number: string;
      month: string;
    };
    expect(paid.number).toMatch(/^TXP-\d{6}$/);
    expect(paid.month).toBe(declared.month);
    expect(await short('tax_payment', paid.id)).toEqual([
      ['vat_payable', '140.00'],
      [`cash:${bank.id}`, '-140.00'],
    ]);
    const [movement] = await inTx((tx) =>
      tx.financeCashMovement.findMany({ where: { taxPaymentId: paid.id } }),
    );
    expect([movement.kind, movement.amount.toFixed(2)]).toEqual([
      'tax_payment',
      '-140.00',
    ]);
    expect((await months())[1]).toMatchObject({ paid: '140.00', open: '0.00' });
    const r = (
      await http('get', '/staff/finance/gl/reconciliation', acc()).expect(200)
    ).body as { balanced: boolean; cashAccounts: { difference: string }[] };
    expect(r.balanced).toBe(true);
    expect(r.cashAccounts.every((c) => c.difference === '0.00')).toBe(true);
  });

  it('the reports platform reads the declaration by month and by source, and exports it', async () => {
    const from = lastMonthStart();
    const res = (
      await http(
        'get',
        `/staff/reports/view?report=tax_vat&from=${from}&to=${day(0)}`,
        acc(),
      ).expect(200)
    ).body as { rows: { values: (string | null)[] }[] };
    expect(res.rows.map((r) => r.values)).toEqual([
      [from.slice(0, 7), '2000.00', '280.00', '1000.00', '140.00', '140.00'],
      [day(0).slice(0, 7), '2150.00', '301.00', '1000.00', '140.00', '161.00'],
    ]);
    const bySource = (
      await http(
        'get',
        `/staff/reports/view?report=tax_vat&from=${from}&to=${day(0)}&groupBy=source`,
        acc(),
      ).expect(200)
    ).body as { rows: { values: (string | null)[] }[] };
    expect(bySource.rows.map((r) => r.values[0])).toEqual([
      'credit_note',
      'invoice',
      'vendor_invoice',
    ]);
    await http(
      'get',
      `/staff/reports/export?report=tax_vat&from=${from}&to=${day(0)}&format=pdf`,
      acc(),
    ).expect(200);
  });

  it('the backfill writes the VAT lines the triggers wrote', async () => {
    const snapshot = async (db: Client) =>
      (
        await db.query<{ row: string }>(
          `SELECT concat_ws('|', e.source, e.source_id, e.posted_on, e.event_on, e.reference,
                            a.system_key, l.debit, l.credit, l.unit_id, l.vendor_id) AS row
             FROM gl_lines l
             JOIN gl_entries e ON e.id = l.entry_id
             JOIN gl_accounts a ON a.id = l.account_id
            WHERE l.tenant_id = $1 ORDER BY 1`,
          [s.c.tenantId],
        )
      ).rows.map((r) => r.row);
    const db = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await db.connect();
    try {
      const posted = await snapshot(db);
      expect(posted.some((r) => r.includes('|vat_payable|'))).toBe(true);
      // TEST-ONLY: the entries set aside (replica skips the immutability
      // triggers), then the backfill run again.
      await db.query('BEGIN');
      await db.query('SET LOCAL session_replication_role = replica');
      await db.query('DELETE FROM gl_lines WHERE tenant_id = $1', [
        s.c.tenantId,
      ]);
      await db.query(
        `DELETE FROM gl_entries WHERE tenant_id = $1 AND source <> 'manual'`,
        [s.c.tenantId],
      );
      await db.query('SELECT gl_backfill($1)::text', [s.c.tenantId]);
      await db.query('COMMIT');
      expect(await snapshot(db)).toEqual(posted);
    } finally {
      await db.end();
    }
  });
});
