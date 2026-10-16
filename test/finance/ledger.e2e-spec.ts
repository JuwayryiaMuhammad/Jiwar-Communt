import type { Response } from 'supertest';
import { Prisma } from '@prisma/client';
import { addDays } from '../../src/core/common/slots/day-slots';
import { ExportLimit } from '../../src/core/common/csv';
import { day } from '../setup/facilities';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Entry {
  type: string;
  id: string;
  day: string;
  number: string;
  relatedNumber: string | null;
  unitId: string;
  unitCode: string;
  building: string | null;
  channel: string | null;
  method: string | null;
  amount: string;
  debit: string | null;
  credit: string | null;
}
interface Page {
  data: Entry[];
  nextCursor: string | null;
}

const body = <T>(res: Response) => res.body as T;
const code = (res: Response) => body<{ code: string }>(res).code;
const dec = (v: string | null) => new Prisma.Decimal(v ?? 0);

/**
 * The ledger (ADR 0048): the compound's journal computed from the
 * append-only money rows, from the units' side; filters, a cursor, and a
 * CSV twin. Per unit, over all time, Σ debit − Σ credit = outstanding −
 * credit, whatever happened.
 */
describe('Finance — ledger', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Ledger Court');
  });

  afterAll(() => h.close());

  const ledger = async (
    query: Record<string, string>,
    token = s.accountant.token,
  ) => {
    const qs = new URLSearchParams({
      from: day(0),
      to: day(0),
      limit: '100',
      ...query,
    });
    return body<Page>(
      await f.http('get', `/staff/finance/ledger?${qs}`, token).expect(200),
    );
  };
  const pay = (unitId: string, amount: string, invoiceIds?: string[]) =>
    f
      .http('post', `/staff/units/${unitId}/payments`, s.accountant.token, {
        amount,
        method: 'cash',
        paidOn: day(0),
        ...(invoiceIds ? { invoiceIds } : {}),
      })
      .expect(201);
  const statement = async (unitId: string) =>
    body<{ outstanding: string; credit: string }>(
      await f
        .http('get', `/staff/units/${unitId}/statement`, s.manager.token)
        .expect(200),
    );

  /** A unit whose day holds every kind of row. */
  async function busyUnit(building = 'L') {
    const home = await f.unit(s.c, building);
    const a = await f.issue(s.manager, home.id);
    const office = body<{ id: string; receiptNumber: string }>(
      await pay(home.id, '400', [a.invoiceId]),
    );
    await f
      .http(
        'post',
        `/staff/invoices/${a.invoiceId}/credit-notes`,
        s.manager.token,
        { amount: '100', reasonCode: 'goodwill' },
      )
      .expect(201);
    // Credit, then an issue it pays: credit applied.
    await f.giveCredit(s.c, home.id, '700');
    // A reversal frees what the office payment paid; the credit refills it.
    await f
      .http('post', `/staff/payments/${office.id}/reverse`, s.manager.token, {
        reasonCode: 'entered_in_error',
      })
      .expect(201);
    const b = await f.issue(s.manager, home.id, {
      lines: [{ descriptionEn: 'Fee', descriptionAr: 'رسم', amount: '50' }],
    });
    // What is owed paid in full (oldest first: A's 200, B's 50), then B
    // credited beyond what it owes: a release.
    await pay(home.id, '250');
    await f
      .http(
        'post',
        `/staff/invoices/${b.invoiceId}/credit-notes`,
        s.manager.token,
        { amount: '50', reasonCode: 'billing_error' },
      )
      .expect(201);
    // A refund and its reversal.
    await f.giveCredit(s.c, home.id, '80');
    await f.stepUp(s.manager.token);
    const refund = body<{ id: string }>(
      await f
        .http('post', `/staff/units/${home.id}/refunds`, s.manager.token, {
          amount: '30',
          channel: 'cash',
          refundedOn: day(0),
        })
        .expect(201),
    );
    await f
      .http('post', `/staff/refunds/${refund.id}/reverse`, s.manager.token, {
        reasonCode: 'entered_in_error',
      })
      .expect(201);
    return { home, a, b, office };
  }

  it('every kind of row once, on the right side; per unit the debits less the credits are what it owes less its credit', async () => {
    const { home } = await busyUnit();
    const rows = (await ledger({ unitId: home.id })).data;
    expect([...new Set(rows.map((r) => r.type))].sort()).toEqual(
      [
        'allocation_release',
        'credit_applied',
        'credit_note',
        'invoice',
        'payment',
        'payment_reversal',
        'refund',
        'refund_reversal',
      ].sort(),
    );
    for (const r of rows) {
      expect(r.unitCode).toBe(home.code);
      expect(r.building).toBe('L');
      const side = ['invoice', 'payment_reversal', 'refund'].includes(r.type)
        ? 'debit'
        : ['credit_note', 'payment', 'refund_reversal'].includes(r.type)
          ? 'credit'
          : null;
      expect([r.type, r.debit, r.credit]).toEqual([
        r.type,
        side === 'debit' ? r.amount : null,
        side === 'credit' ? r.amount : null,
      ]);
    }
    const net = rows.reduce(
      (sum, r) => sum.add(dec(r.debit)).sub(dec(r.credit)),
      new Prisma.Decimal(0),
    );
    const st = await statement(home.id);
    expect(net.toFixed(2)).toBe(
      dec(st.outstanding).sub(dec(st.credit)).toFixed(2),
    );
    const office = rows.find((r) => r.type === 'payment_reversal')!;
    expect(office).toMatchObject({ channel: 'office', method: 'cash' });
    const note = rows.find(
      (r) => r.type === 'credit_note' && r.amount === '100.00',
    )!;
    expect(note.relatedNumber).toMatch(/^INV-/);
    const applied = rows.find((r) => r.type === 'credit_applied')!;
    expect([applied.number, applied.relatedNumber]).toEqual([
      expect.stringMatching(/^INV-/) as string,
      expect.stringMatching(/^RC-/) as string,
    ]);
  });

  it('credit applied is only money the unit already held, never a payment’s own transaction', async () => {
    const home = await f.unit(s.c, 'L');
    const a = await f.issue(s.manager, home.id);
    await pay(home.id, '1000', [a.invoiceId]);
    expect(
      (await ledger({ unitId: home.id, type: 'credit_applied' })).data,
    ).toEqual([]);
    await f.giveCredit(s.c, home.id, '300');
    await f.issue(s.manager, home.id, {
      lines: [{ descriptionEn: 'Fee', descriptionAr: 'رسم', amount: '120' }],
    });
    expect(
      (await ledger({ unitId: home.id, type: 'credit_applied' })).data.map(
        (r) => r.amount,
      ),
    ).toEqual(['120.00']);
  });

  it('filters by type, unit and building; a cursor pages through in order, without a row twice', async () => {
    const one = await busyUnit('Filter-1');
    await busyUnit('Filter-2');
    const all = (await ledger({ building: 'Filter-1' })).data;
    expect(all.every((r) => r.unitId === one.home.id)).toBe(true);
    const invoices = (await ledger({ building: 'Filter-1', type: 'invoice' }))
      .data;
    expect(invoices.map((r) => r.type)).toEqual(['invoice', 'invoice']);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await ledger({
        building: 'Filter-1',
        limit: '3',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.data.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.map((r) => r.id));
    // Another period holds none of it.
    expect(
      (
        await ledger({
          building: 'Filter-1',
          from: addDays(day(0), -10),
          to: addDays(day(0), -1),
        })
      ).data,
    ).toEqual([]);
  });

  it('a period of a year at most, its end not before its start', async () => {
    const bad = async (q: Record<string, string>) =>
      body<{ fields: { field: string; code: string }[] }>(
        await f
          .http(
            'get',
            `/staff/finance/ledger?${new URLSearchParams(q)}`,
            s.manager.token,
          )
          .expect(400),
      ).fields;
    expect(await bad({ from: day(0), to: addDays(day(0), -1) })).toEqual([
      { field: 'to', code: 'ENDS_BEFORE_START' },
    ]);
    expect(await bad({ from: day(0), to: addDays(day(0), 366) })).toEqual([
      { field: 'to', code: 'PERIOD_TOO_LONG', params: { maxDays: 366 } },
    ]);
    await f
      .http(
        'get',
        `/staff/finance/ledger?from=${day(0)}&to=${addDays(day(0), 365)}`,
        s.manager.token,
      )
      .expect(200);
  });

  it('the CSV holds the same rows: a download, a byte-order mark, a header, formulas defused', async () => {
    const { home } = await busyUnit('=SUM(A1)');
    const json = (await ledger({ unitId: home.id })).data;
    const res = await f
      .http(
        'get',
        `/staff/finance/ledger/export?from=${day(0)}&to=${day(0)}&unitId=${home.id}`,
        s.accountant.token,
      )
      .expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="ledger-${day(0)}_${day(0)}.csv"`,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const text = res.text;
    expect(text.startsWith('\uFEFFday,recorded_at,type,number,')).toBe(true);
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(json.length + 1);
    expect(lines[1]).toContain(`'=SUM(A1)`);
    expect(lines.slice(1).map((l) => l.split(',')[2])).toEqual(
      json.map((r) => r.type),
    );
  });

  it('an export past the limit is refused: narrow the period', async () => {
    const limit = h.moduleRef.get(ExportLimit);
    const before = limit.maxRows;
    limit.maxRows = 2;
    try {
      const { home } = await busyUnit();
      const res = await f
        .http(
          'get',
          `/staff/finance/ledger/export?from=${day(0)}&to=${day(0)}&unitId=${home.id}`,
          s.manager.token,
        )
        .expect(422);
      expect(code(res)).toBe('EXPORT_TOO_LARGE');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    } finally {
      limit.maxRows = before;
    }
  });

  it('finance.reports only: a cashier with payments alone may not read it', async () => {
    const cashier = await f.staff(s.c, ['finance.payments']);
    expect(
      code(
        await f
          .http(
            'get',
            `/staff/finance/ledger?from=${day(0)}&to=${day(0)}`,
            cashier.token,
          )
          .expect(403),
      ),
    ).toBe('FORBIDDEN');
  });
});
