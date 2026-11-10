import { Prisma } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { err } from '../api/request';
import { day, dbDate, ofDbDate } from '../setup/compound-clock';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Year {
  startsOn: string;
  endsOn: string;
  status: string;
  closable: boolean;
  openMonths: string[];
  closeId: string | null;
  revenue: string | null;
  result: string | null;
  entryId: string | null;
  reopenings: number;
}
interface Row {
  code: string;
  amount: string;
}

/**
 * ADR 0093: a fiscal year (January by default) is closed once every month
 * of it is, and every earlier year is: one closing entry, dated its last
 * day, zeroes each revenue and expense account into accumulated surplus,
 * and the year's months stay closed. The balance sheet shows the year's
 * result apart from accumulated surplus; a closed year's income statement
 * still reads its own revenue. Reopening is the manager's alone, the
 * latest year first, and reverses the closing entry.
 */
describe('The general ledger — the fiscal year-end close (ADR 0093)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;
  const y = () => Number(day(0).slice(0, 4));
  const first = (n: number) => `${y() - n}-01-01`;
  const last = (n: number) => `${y() - n}-12-31`;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Year Close Court');
    // TEST-ONLY: service charges invoiced two years ago and last year,
    // written as of then (the triggers post them on their days).
    await inTx(async (tx) => {
      await invoiceOn(tx, `${y() - 2}-03-15`, '1000.00');
      await invoiceOn(tx, `${y() - 1}-03-15`, '3000.00');
    });
    await f.issue(s.accountant, s.home.id, {
      lines: [
        { descriptionEn: 'Dues', descriptionAr: 'مستحقات', amount: '500' },
      ],
    });
  }, 90_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  const acc = () => s.accountant.token;
  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    f.x.asManager(s.c, () => h.moduleRef.get(TenantTx).withTenantTx(fn));
  let n = 0;
  async function invoiceOn(tx: TenantTxClient, on: string, total: string) {
    const batchId = newId();
    await tx.invoiceBatch.create({
      data: {
        id: batchId,
        tenantId: s.c.tenantId,
        target: 'unit',
        unitId: s.home.id,
        kind: 'service_charge',
        unitCount: 1,
        issuedOn: dbDate(on),
        dueOn: dbDate(on),
        createdById: s.accountant.id,
      },
    });
    const id = newId();
    await tx.invoice.create({
      data: {
        id,
        tenantId: s.c.tenantId,
        number: 800_000 + (Date.now() % 90_000) + ++n,
        batchId,
        unitId: s.home.id,
        kind: 'service_charge',
        total,
        currency: 'EGP',
        issuedOn: dbDate(on),
        dueOn: dbDate(on),
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
        amount: total,
      },
    });
  }
  const years = async () =>
    (
      (await f.http('get', '/staff/finance/gl/years', acc()).expect(200))
        .body as { data: Year[] }
    ).data;
  const close = (startsOn: string, token = acc()) =>
    f.http('post', '/staff/finance/gl/years/close', token, { startsOn });
  const reopen = (startsOn: string, token = m(), reasonCode?: string) =>
    f.http('post', '/staff/finance/gl/years/reopen', token, {
      startsOn,
      ...(reasonCode ? { reasonCode } : {}),
    });
  const linesOf = (source: string, sourceId: string) =>
    inTx(async (tx) =>
      (
        await tx.$queryRaw<
          {
            key: string | null;
            posted_on: Date;
            debit: Prisma.Decimal;
            credit: Prisma.Decimal;
          }[]
        >`
          SELECT a.system_key AS key, l.posted_on, l.debit, l.credit
            FROM gl_lines l
            JOIN gl_entries e ON e.id = l.entry_id
            JOIN gl_accounts a ON a.id = l.account_id
           WHERE e.source = ${source} AND e.source_id = ${sourceId}::uuid
           ORDER BY l.line_no`
      ).map((r) => [
        r.key,
        ofDbDate(r.posted_on),
        r.debit.sub(r.credit).toFixed(2),
      ]),
    );
  const balanceSheet = async (asOf: string) =>
    (
      await f
        .http('get', `/staff/finance/gl/balance-sheet?asOf=${asOf}`, acc())
        .expect(200)
    ).body as {
      equity: Row[];
      surplus: string;
      fiscalYearStartsOn: string;
      currentYearResult: string;
      priorYearsResult: string;
      balanced: boolean;
    };
  const surplusAccount = (b: { equity: Row[] }) =>
    b.equity.find((r) => r.code === '3200')?.amount ?? '0.00';

  it('lists the fiscal years from the first entry’s; a year is closed once every month of it is, and every earlier year is', async () => {
    const before = await years();
    expect(before.map((x) => [x.startsOn, x.status, x.closable])).toEqual([
      [first(0), 'open', false],
      [first(1), 'open', false],
      [first(2), 'open', false],
    ]);
    expect(before[2].openMonths[0]).toBe(`${y() - 2}-03`);
    expect(err(await close(first(1)).expect(409))).toMatchObject({
      code: 'GL_YEAR_MONTHS_OPEN',
    });
    expect(err(await close(`${y() - 1}-02-01`).expect(400)).fields).toEqual([
      {
        field: 'startsOn',
        code: 'INVALID_VALUE',
        params: { startMonth: 1 },
      },
    ]);
    await f
      .http('post', '/staff/finance/gl/periods/close', acc(), {
        month: `${y() - 1}-12`,
      })
      .expect(201);
    expect(err(await close(first(1)).expect(409))).toMatchObject({
      code: 'GL_YEAR_PREVIOUS_OPEN',
      params: { startsOn: first(2) },
    });
    expect((await years())[2]).toMatchObject({
      startsOn: first(2),
      closable: true,
      openMonths: [],
    });
    // This year has not ended.
    expect(err(await close(first(0)).expect(409)).code).toBe(
      'GL_YEAR_MONTHS_OPEN',
    );
  });

  it('closing a year posts one entry on its last day, zeroing its revenue into accumulated surplus, and locks it', async () => {
    const closed = (await close(first(2)).expect(201)).body as { data: Year[] };
    const two = closed.data.find((x) => x.startsOn === first(2))!;
    expect(two).toMatchObject({
      status: 'closed',
      revenue: '1000.00',
      result: '1000.00',
    });
    expect(await linesOf('year_close', two.closeId!)).toEqual([
      ['revenue:service_charge', last(2), '1000.00'],
      ['accumulated_surplus', last(2), '-1000.00'],
    ]);
    expect(err(await close(first(2)).expect(409)).code).toBe('GL_YEAR_CLOSED');
    await close(first(1)).expect(201);
    expect(
      err(
        await f
          .http('post', '/staff/finance/gl/periods/reopen', m(), {
            month: `${y() - 1}-06`,
            reasonCode: 'correction',
          })
          .expect(409),
      ),
    ).toMatchObject({ code: 'GL_YEAR_CLOSED', params: { startsOn: first(1) } });
    // The fiscal year's month is fixed now.
    expect(
      err(
        await f
          .http('patch', '/staff/finance/budget-settings', m(), {
            fiscalYearStartMonth: 7,
          })
          .expect(409),
      ).code,
    ).toBe('FISCAL_YEAR_LOCKED');
  });

  it('the statements: a closed year still reads its own revenue; the balance sheet shows the year’s result apart from accumulated surplus', async () => {
    const is = (
      await f
        .http(
          'get',
          `/staff/finance/gl/income-statement?from=${first(1)}&to=${last(1)}`,
          acc(),
        )
        .expect(200)
    ).body as { totalRevenue: string; surplus: string };
    expect([is.totalRevenue, is.surplus]).toEqual(['3000.00', '3000.00']);
    const atEnd = await balanceSheet(last(1));
    expect(atEnd).toMatchObject({
      fiscalYearStartsOn: first(1),
      currentYearResult: '3000.00',
      priorYearsResult: '0.00',
      balanced: true,
    });
    expect(surplusAccount(atEnd)).toBe('1000.00');
    const now = await balanceSheet(day(0));
    expect(now).toMatchObject({
      fiscalYearStartsOn: first(0),
      currentYearResult: '500.00',
      priorYearsResult: '0.00',
      balanced: true,
    });
    expect(surplusAccount(now)).toBe('4000.00');
    const tb = (
      await f
        .http('get', `/staff/finance/gl/trial-balance?asOf=${last(1)}`, acc())
        .expect(200)
    ).body as {
      balanced: boolean;
      rows: { code: string; debit: string; credit: string }[];
    };
    expect(tb.balanced).toBe(true);
    // Closed into accumulated surplus: revenue holds nothing at the year's end.
    expect(tb.rows.find((r) => r.code === '4100')).toMatchObject({
      debit: '0.00',
      credit: '0.00',
    });
  });

  it('reopening is the manager’s alone, with a reason, the latest year first; it reverses the closing entry, and the year closes again', async () => {
    await reopen(first(1), acc(), 'correction').expect(403);
    await reopen(first(1), m()).expect(400);
    expect(
      err(await reopen(first(2), m(), 'correction').expect(409)),
    ).toMatchObject({
      code: 'GL_YEAR_LATER_CLOSED',
      params: { startsOn: first(1) },
    });
    const open = (await reopen(first(1), m(), 'late_document').expect(201))
      .body as { data: Year[] };
    const one = open.data.find((x) => x.startsOn === first(1))!;
    expect(one).toMatchObject({
      status: 'open',
      closable: true,
      reopenings: 1,
    });
    const [closeRow] = await inTx((tx) =>
      tx.glYearClose.findMany({
        where: { startsOn: dbDate(first(1)) },
      }),
    );
    expect(await linesOf('year_reopen', closeRow.id)).toEqual([
      ['revenue:service_charge', last(1), '-3000.00'],
      ['accumulated_surplus', last(1), '3000.00'],
    ]);
    const now = await balanceSheet(day(0));
    expect(now).toMatchObject({
      currentYearResult: '500.00',
      priorYearsResult: '3000.00',
      balanced: true,
    });
    expect(surplusAccount(now)).toBe('1000.00');
    await close(first(1)).expect(201);
    expect((await years()).find((x) => x.startsOn === first(1))).toMatchObject({
      status: 'closed',
      reopenings: 1,
      result: '3000.00',
    });
    expect(surplusAccount(await balanceSheet(day(0)))).toBe('4000.00');
  });
});
