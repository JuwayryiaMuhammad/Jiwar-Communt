import { Prisma } from '@prisma/client';
import { Client } from 'pg';
import { addDays } from '../../src/core/common/slots/day-slots';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { err } from '../api/request';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { clock, day } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { deferred } from '../setup/permits';
import { required } from '../setup/test-env';

interface Line {
  key: string | null;
  code: string;
  debit: string;
  credit: string;
  unitId: string | null;
  vendorId: string | null;
}
interface Account {
  id: string;
  code: string;
  nameEn: string;
  type: string;
  parentId: string | null;
  system: boolean;
  systemKey: string | null;
  cashAccountId: string | null;
  control: boolean;
  postable: boolean;
  balance: string;
}
interface Check {
  key: string;
  register: string;
  ledger: string;
  difference: string;
}

/**
 * ADR 0092: every money event posts its balanced entry in its own
 * transaction, from the unit's side and the compound's — an invoice, its
 * credit note, an office payment and its allocation, the reversal; the
 * treasury's opening, adjustment and transfer; a manual expense and its
 * void; a vendor's invoice approved and paid out with its retention — and
 * the ledger then agrees with every register it posts from. The chart,
 * the statements, an account's ledger with its running balance, and the
 * exports.
 */
describe('The general ledger — automatic postings (ADR 0092)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;
  let unitId: string;
  let bank: { id: string };
  let box: { id: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [{ category: 'maintenance', amount: '500000.00' }],
    );
    unitId = (await f.fin.unit(s.c, 'A')).id;
    await f.fin.owner(s.c, unitId);
    bank = (
      await f
        .http('post', '/staff/finance/cash-accounts', s.manager.token, {
          kind: 'bank',
          name: `GL bank ${uniqueSuffix()}`,
          openedOn: day(0),
          openingBalance: '10000.00',
        })
        .expect(201)
    ).body as { id: string };
    box = (
      await f
        .http('post', '/staff/finance/cash-accounts', s.manager.token, {
          kind: 'cash',
          name: `GL box ${uniqueSuffix()}`,
          openedOn: day(0),
        })
        .expect(201)
    ).body as { id: string };
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
  const maintenance = () =>
    budget.lines.find((l) => l.category === 'maintenance')!;

  /** The lines an event posted, by its entry's source and the row's id. */
  const linesOf = (source: string, sourceId: string) =>
    inTx(async (tx) =>
      (
        await tx.$queryRaw<
          {
            key: string | null;
            code: string;
            debit: Prisma.Decimal;
            credit: Prisma.Decimal;
            unit_id: string | null;
            vendor_id: string | null;
          }[]
        >`
          SELECT a.system_key AS key, a.code, l.debit, l.credit, l.unit_id, l.vendor_id
            FROM gl_lines l
            JOIN gl_entries e ON e.id = l.entry_id
            JOIN gl_accounts a ON a.id = l.account_id
           WHERE e.source = ${source} AND e.source_id = ${sourceId}::uuid
           ORDER BY l.line_no`
      ).map((r): Line => ({
        key: r.key,
        code: r.code,
        debit: r.debit.toFixed(2),
        credit: r.credit.toFixed(2),
        unitId: r.unit_id,
        vendorId: r.vendor_id,
      })),
    );
  /** As keys and signed amounts: debit positive. */
  const short = async (source: string, sourceId: string) =>
    (await linesOf(source, sourceId)).map((l) => [
      l.key,
      new Prisma.Decimal(l.debit).sub(l.credit).toFixed(2),
    ]);
  const cashKey = (id: string) => `cash:${id}`;
  const chart = async () =>
    (
      (await http('get', '/staff/finance/gl/accounts', acc()).expect(200))
        .body as { accounts: Account[] }
    ).accounts;
  const reconciliation = async () =>
    (await http('get', '/staff/finance/gl/reconciliation', acc()).expect(200))
      .body as {
      balanced: boolean;
      checks: Check[];
      cashAccounts: (Check & { cashAccountId: string })[];
    };
  const agreed = async () => {
    const r = await reconciliation();
    expect(r.balanced).toBe(true);
    for (const c of [...r.checks, ...r.cashAccounts])
      expect([c.key, c.difference]).toEqual([c.key, '0.00']);
    return r;
  };

  it('a compound starts with the standard chart, and each bank and cash account opens its own account under its heading', async () => {
    const accounts = await chart();
    const byKey = (k: string) => accounts.find((a) => a.systemKey === k)!;
    for (const k of [
      'receivables',
      'unit_credit',
      'deposits_held',
      'payables',
      'retentions',
      'opening_balances',
      'suspense',
      'revenue:service_charge',
      'expense:maintenance',
    ])
      expect(byKey(k)).toBeDefined();
    expect(byKey('receivables')).toMatchObject({
      code: '1300',
      type: 'asset',
      control: true,
      system: true,
    });
    expect(byKey('assets')).toMatchObject({ postable: false });
    const mine = accounts.find((a) => a.cashAccountId === bank.id)!;
    expect(mine).toMatchObject({
      type: 'asset',
      control: true,
      parentId: byKey('bank_accounts').id,
      balance: '10000.00',
    });
    expect(mine.code).toMatch(/^1110\.\d{2}$/);
    expect(accounts.find((a) => a.cashAccountId === box.id)).toMatchObject({
      parentId: byKey('cash_boxes').id,
      balance: '0.00',
    });
    // The bank's opening balance against the opening balances.
    const [opening] = await inTx((tx) =>
      tx.financeCashMovement.findMany({
        where: { accountId: bank.id, kind: 'opening' },
      }),
    );
    expect(await short('cash_movement', opening.id)).toEqual([
      [cashKey(bank.id), '10000.00'],
      ['opening_balances', '-10000.00'],
    ]);
  });

  it('an invoice, its credit note, an office payment and its allocation, and the payment reversed, each post their entry', async () => {
    const { invoiceId } = await f.fin.issue(s.accountant, unitId, {
      lines: [
        { descriptionEn: 'Dues', descriptionAr: 'مستحقات', amount: '1000' },
      ],
    });
    expect(await linesOf('invoice', invoiceId)).toEqual([
      expect.objectContaining({
        key: 'receivables',
        debit: '1000.00',
        unitId,
      }),
      expect.objectContaining({
        key: 'revenue:service_charge',
        credit: '1000.00',
        unitId: null,
      }),
    ]);
    const credit = (
      await http('post', `/staff/invoices/${invoiceId}/credit-notes`, acc(), {
        amount: '100',
        reasonCode: 'goodwill',
      }).expect(201)
    ).body as { id: string };
    expect(await short('credit_note', credit.id)).toEqual([
      ['revenue:service_charge', '100.00'],
      ['receivables', '-100.00'],
    ]);
    const pay = (
      await http('post', `/staff/units/${unitId}/payments`, acc(), {
        amount: '600',
        method: 'cash',
        paidOn: day(0),
      }).expect(201)
    ).body as { id: string };
    expect(await short('payment', pay.id)).toEqual([
      ['undeposited_cash', '600.00'],
      ['unit_credit', '-600.00'],
    ]);
    const [alloc] = await inTx((tx) =>
      tx.financeAllocation.findMany({ where: { paymentId: pay.id } }),
    );
    expect(await short('allocation', alloc.id)).toEqual([
      ['unit_credit', '600.00'],
      ['receivables', '-600.00'],
    ]);
    await agreed();
    await http('post', `/staff/payments/${pay.id}/reverse`, acc(), {
      reasonCode: 'entered_in_error',
    }).expect(201);
    const [rev] = await inTx((tx) =>
      tx.financePayment.findMany({ where: { reversesId: pay.id } }),
    );
    expect(await short('payment_reversal', rev.id)).toEqual([
      ['undeposited_cash', '-600.00'],
      ['unit_credit', '600.00'],
      ['receivables', '600.00'],
      ['unit_credit', '-600.00'],
    ]);
    const r = await agreed();
    expect(r.checks.map((c) => c.key)).toContain('receivables');
  });

  it('the treasury: an adjustment against its reason’s account, a transfer through the transfers account', async () => {
    const adj = (
      await http(
        'post',
        `/staff/finance/cash-accounts/${bank.id}/adjustments`,
        acc(),
        { amount: '-25.50', reasonCode: 'bank_charge', onDay: day(0) },
      ).expect(201)
    ).body as { id: string };
    expect(await short('cash_movement', adj.id)).toEqual([
      [cashKey(bank.id), '-25.50'],
      ['expense:bank_charges', '25.50'],
    ]);
    const t = (
      await http('post', '/staff/finance/cash-transfers', acc(), {
        fromAccountId: bank.id,
        toAccountId: box.id,
        amount: '1000',
        onDay: day(0),
      }).expect(201)
    ).body as { legs: { id: string; accountId: string }[] };
    const legs = await Promise.all(
      t.legs.map((l) => short('cash_movement', l.id)),
    );
    expect(legs).toEqual([
      [
        [cashKey(bank.id), '-1000.00'],
        ['internal_transfers', '1000.00'],
      ],
      [
        [cashKey(box.id), '1000.00'],
        ['internal_transfers', '-1000.00'],
      ],
    ]);
    const internal = (await chart()).find(
      (a) => a.systemKey === 'internal_transfers',
    )!;
    expect(internal.balance).toBe('0.00');
    await agreed();
  });

  it('a manual expense was paid outside the treasury, and its void undoes it', async () => {
    const res = await f.expense(s.accountant, maintenance().id, '900.00');
    expect(res.status).toBe(201);
    const ex = res.body as { id: string };
    expect(await short('expense', ex.id)).toEqual([
      ['expense:maintenance', '900.00'],
      ['unregistered_payments', '-900.00'],
    ]);
    await http('post', `/staff/finance/expenses/${ex.id}/void`, acc(), {
      reasonCode: 'duplicate',
    }).expect(200);
    expect(await short('expense_void', ex.id)).toEqual([
      ['expense:maintenance', '-900.00'],
      ['unregistered_payments', '900.00'],
    ]);
  });

  it('a vendor’s invoice approved is an expense owed to its vendor; its payout pays it, holding back the contract’s retention, out of the bank', async () => {
    const vendorId = (
      (
        await http('post', '/staff/vendors', m(), {
          name: `GL payee ${uniqueSuffix()}`,
          categories: ['maintenance'],
        }).expect(201)
      ).body as { id: string }
    ).id;
    const contract = (
      await http('post', '/maintenance/contracts', m(), {
        code: `GL-${uniqueSuffix()}`,
        kind: 'amc',
        vendorId,
        startsOn: budget.startsOn,
        endsOn: addDays(budget.endsOn, 60),
        annualValue: '60000.00',
        budgetLineId: maintenance().id,
        retentionPct: '10',
      }).expect(201)
    ).body as { id: string };
    const inv = (
      await deferred(
        (async () =>
          http('post', '/staff/finance/vendor-invoices', acc(), {
            vendorNumber: `GL-${uniqueSuffix()}`,
            issuedOn: clock().today,
            dueOn: day(10),
            invoiceFileId: await f.invoice(s.accountant),
            contractId: contract.id,
            lines: [{ description: 'Service', amount: '5000.00' }],
          }))(),
      ).expect(201)
    ).body as { id: string };
    await http(
      'post',
      `/staff/finance/vendor-invoices/${inv.id}/approve`,
      m(),
      {},
    ).expect(200);
    expect(await linesOf('vendor_invoice', inv.id)).toEqual([
      expect.objectContaining({
        key: 'expense:maintenance',
        debit: '5000.00',
        vendorId,
      }),
      expect.objectContaining({ key: 'payables', credit: '5000.00', vendorId }),
    ]);
    const paid = (
      await http(
        'post',
        `/staff/finance/vendor-invoices/${inv.id}/pay`,
        acc(),
        {
          paidOn: clock().today,
          method: 'bank_transfer',
          reference: 'TRF-GL',
          cashAccountId: bank.id,
        },
      ).expect(200)
    ).body as { payout: { id: string; expenseId: string } };
    expect(await short('vendor_payout', paid.payout.id)).toEqual([
      ['payables', '5000.00'],
      ['retentions', '-500.00'],
      [cashKey(bank.id), '-4500.00'],
    ]);
    // The payout's expense is the invoice's, posted when it was approved.
    expect(await linesOf('expense', paid.payout.expenseId)).toEqual([]);
    await agreed();
  });

  it('the statements: the trial balance agrees, the balance sheet balances, the income statement has the period’s revenue and expenses', async () => {
    const tb = (
      await http('get', '/staff/finance/gl/trial-balance', acc()).expect(200)
    ).body as { balanced: boolean; debit: string; credit: string };
    expect(tb.balanced).toBe(true);
    expect(tb.debit).toBe(tb.credit);
    const bs = (
      await http('get', '/staff/finance/gl/balance-sheet', acc()).expect(200)
    ).body as { balanced: boolean; surplus: string };
    expect(bs.balanced).toBe(true);
    const is = (
      await http(
        'get',
        `/staff/finance/gl/income-statement?from=${day(0)}&to=${day(0)}`,
        acc(),
      ).expect(200)
    ).body as {
      totalRevenue: string;
      totalExpenses: string;
      surplus: string;
      revenue: { code: string; amount: string }[];
    };
    // 1000 invoiced less a 100 credit note; 5000 of maintenance and 25.50
    // of bank charges (the voided expense nets to nothing).
    expect(is.revenue).toEqual([
      expect.objectContaining({ code: '4100', amount: '900.00' }),
    ]);
    expect(is.totalExpenses).toBe('5025.50');
    expect(is.surplus).toBe('-4125.50');
    expect(bs.surplus).toBe(is.surplus);
  });

  it('an account’s ledger pages oldest first with its running balance, and exports as CSV; the journal exports every line', async () => {
    const mine = (await chart()).find((a) => a.cashAccountId === bank.id)!;
    const page = async (cursor?: string) =>
      (
        await http(
          'get',
          `/staff/finance/gl/accounts/${mine.id}/ledger?from=${day(0)}&to=${day(0)}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
          acc(),
        ).expect(200)
      ).body as {
        data: { debit: string; credit: string; balance: string }[];
        nextCursor: string | null;
      };
    const first = await page();
    expect(first.data.map((l) => l.balance)).toEqual(['10000.00', '9974.50']);
    const second = await page(first.nextCursor!);
    expect(second.data.map((l) => l.balance)).toEqual(['8974.50', '4474.50']);
    expect(second.nextCursor).toBeNull();
    expect(mine.balance).toBe('4474.50');
    const csv = await http(
      'get',
      `/staff/finance/gl/accounts/${mine.id}/ledger/export?from=${day(0)}&to=${day(0)}`,
      acc(),
    ).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe(
      '﻿posted_on,event_on,source,reference,unit,memo,debit,credit,balance',
    );
    const journal = await http(
      'get',
      `/staff/finance/gl/journal/export?from=${day(0)}&to=${day(0)}`,
      acc(),
    ).expect(200);
    expect(journal.text).toContain('vendor_payout');
    expect(journal.headers['cache-control']).toBe('no-store');
    expect(
      err(
        await http(
          'get',
          `/staff/finance/gl/journal/export?from=${day(0)}&to=${day(-1)}`,
          acc(),
        ).expect(400),
      ).fields,
    ).toEqual([{ field: 'to', code: 'ENDS_BEFORE_START' }]);
  });

  it('the chart: a sub-account under any but a control account, of its parent’s type; renamed; removed while unused; a system account never', async () => {
    const accounts = await chart();
    const repairs = accounts.find(
      (a) => a.systemKey === 'expense:maintenance',
    )!;
    const receivables = accounts.find((a) => a.systemKey === 'receivables')!;
    expect(
      err(
        await http('post', '/staff/finance/gl/accounts', acc(), {
          parentId: receivables.id,
          code: '1300.01',
          nameEn: 'Tower A',
          nameAr: 'برج أ',
        }).expect(409),
      ),
    ).toMatchObject({
      code: 'GL_ACCOUNT_CONTROLLED',
      params: { accountId: receivables.id },
    });
    expect(
      err(
        await http('post', '/staff/finance/gl/accounts', acc(), {
          parentId: repairs.id,
          code: '5131.01',
          nameEn: 'Lifts',
          nameAr: 'المصاعد',
        }).expect(400),
      ).fields,
    ).toEqual([
      { field: 'code', code: 'INVALID_FORMAT', params: { prefix: '5130.' } },
    ]);
    const lifts = (
      await http('post', '/staff/finance/gl/accounts', acc(), {
        parentId: repairs.id,
        code: '5130.01',
        nameEn: 'Lifts',
        nameAr: 'المصاعد',
      }).expect(201)
    ).body as Account;
    expect(lifts).toMatchObject({
      type: 'expense',
      system: false,
      control: false,
      parentId: repairs.id,
    });
    expect(
      err(
        await http('post', '/staff/finance/gl/accounts', acc(), {
          parentId: repairs.id,
          code: '5130.01',
          nameEn: 'Again',
          nameAr: 'مرة أخرى',
        }).expect(409),
      ).code,
    ).toBe('DUPLICATE_RESOURCE');
    const renamed = (
      await http('patch', `/staff/finance/gl/accounts/${repairs.id}`, acc(), {
        nameEn: 'Repairs and maintenance',
      }).expect(200)
    ).body as Account;
    expect(renamed).toMatchObject({
      nameEn: 'Repairs and maintenance',
      code: '5130',
      system: true,
    });
    expect(
      err(
        await http(
          'delete',
          `/staff/finance/gl/accounts/${repairs.id}`,
          acc(),
        ).expect(409),
      ).code,
    ).toBe('GL_ACCOUNT_SYSTEM');
    await http(
      'delete',
      `/staff/finance/gl/accounts/${lifts.id}`,
      acc(),
    ).expect(204);
    // The database keeps a system account's type and place whatever asks.
    await expect(
      inTx((tx) =>
        tx.glAccount.update({
          where: { id: repairs.id },
          data: { type: 'asset' },
        }),
      ),
    ).rejects.toThrow(/only its names change/);
    await expect(
      inTx((tx) => tx.glAccount.delete({ where: { id: repairs.id } })),
    ).rejects.toThrow(/never removed/);
  });

  it('the reports platform reads the trial balance, the income statement, the balance sheet and the general ledger', async () => {
    for (const report of [
      'gl_trial_balance',
      'gl_income_statement',
      'gl_balance_sheet',
      'gl_general_ledger',
    ]) {
      const res = await http(
        'get',
        `/staff/reports/view?report=${report}&from=${day(0)}&to=${day(0)}`,
        acc(),
      ).expect(200);
      expect((res.body as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
    }
    const tb = (
      await http(
        'get',
        `/staff/reports/view?report=gl_trial_balance&from=${day(0)}&to=${day(0)}&groupBy=type`,
        acc(),
      ).expect(200)
    ).body as { totals: { values: (string | null)[] } };
    expect(tb.totals.values[1]).toBe(tb.totals.values[2]);
    await http(
      'get',
      `/staff/reports/export?report=gl_trial_balance&from=${day(0)}&to=${day(0)}&format=xlsx`,
      acc(),
    ).expect(200);
  });

  it('the backfill posts history by the triggers’ own rules: the compound’s ledger written again from its rows is the same lines, and twice is once', async () => {
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
      expect(posted.length).toBeGreaterThan(20);
      // TEST-ONLY: the compound's entries set aside (replica skips the
      // immutability triggers), then the migration's backfill run again.
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
      await db.query('SELECT gl_backfill($1)::text', [s.c.tenantId]);
      await db.query('COMMIT');
      expect(await snapshot(db)).toEqual(posted);
    } finally {
      await db.end();
    }
    await agreed();
  });
});
