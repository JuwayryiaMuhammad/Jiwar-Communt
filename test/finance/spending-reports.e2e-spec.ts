import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { err } from '../api/request';
import { dbDate } from '../setup/compound-clock';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import {
  activateBudget,
  budgetLineRow,
  budgetRow,
  expenseRow,
} from '../setup/finance-rows';
import { boardTermRow, publicationRows } from '../setup/governance-rows';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Report {
  id: string;
  fiscalYear: number;
  startsOn: string;
  asOf: string;
  summaryEn: string | null;
  supersedesId: string | null;
  supersededById: string | null;
  lines: {
    category: string;
    allowance: string;
    spent: string;
    usedPct: string;
  }[];
  totals: { allowance: string; spent: string; usedPct: string };
  items: {
    position: number;
    textEn: string;
    decision: { publicationId: string; decidedOn: string | null } | null;
  }[];
}

/**
 * ADR 0069: where the fees went — a snapshot the finance staff publish of
 * an approved budget as of a day, by category, with the improvements it
 * paid for; read by everyone who sees a unit's money, tenants included,
 * and told to them; never an expense, a vendor or a name; never changed
 * after — a newer report of the budget supersedes its latest, and
 * residents read only that.
 */
describe('Finance — where the fees went', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;
  let budgetId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Spending Court');
    budgetId = await inTx(async (tx) => {
      const id = await budgetRow(tx, {
        tenantId: s.c.tenantId,
        createdById: s.c.managerId,
      });
      for (const category of ['security', 'cleaning']) {
        const lineId = await budgetLineRow(tx, {
          tenantId: s.c.tenantId,
          budgetId: id,
          category,
        });
        if (category === 'security')
          for (let i = 0; i < 3; i++)
            await expenseRow(tx, {
              tenantId: s.c.tenantId,
              lineId,
              recordedById: s.c.managerId,
            });
      }
      await activateBudget(tx, {
        tenantId: s.c.tenantId,
        budgetId: id,
        raisedById: s.c.managerId,
      });
      return id;
    });
  }, 90_000);

  afterAll(() => h.close());

  function inTx<T>(fn: (tx: TenantTxClient) => Promise<T>) {
    return f.inTx(s.c, fn);
  }

  const publish = (body: object, token = s.accountant.token) =>
    f.http('post', '/staff/finance/spending-reports', token, body);
  const published = async (body: object) =>
    (await publish(body).expect(201)).body as Report;
  /** An approved budget of its own, with a line. */
  const activeBudget = () =>
    inTx(async (tx) => {
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

  it('one act: the budget’s figures by category as of its last day, the improvements in the staff’s words with the decision they carried out; told to who sees a unit’s money', async () => {
    const decided = await inTx(async (tx) =>
      publicationRows(tx, {
        tenantId: s.c.tenantId,
        termId: await boardTermRow(tx, {
          tenantId: s.c.tenantId,
          createdById: s.c.managerId,
        }),
        accountId: s.c.managerId,
      }),
    );
    const tenantHome = await f.unit(s.c, 'B');
    await f.landlord(s.c, tenantHome.id);
    const tenant = await f.tenant(s.c, tenantHome.id);
    const report = (
      await publish({
        budgetId,
        summaryEn: 'Half the year.',
        summaryAr: 'نصف العام.',
        items: [
          {
            textEn: 'New gate barriers',
            textAr: 'حواجز جديدة للبوابة',
            decisionPublicationId: decided,
          },
          { textEn: 'Gardens replanted', textAr: 'زراعة الحدائق' },
        ],
      }).expect(201)
    ).body as Report;
    expect(report).toMatchObject({
      summaryEn: 'Half the year.',
      lines: [
        {
          category: 'security',
          allowance: '1000.00',
          spent: '30.00',
          usedPct: '3.0',
        },
        {
          category: 'cleaning',
          allowance: '1000.00',
          spent: '0.00',
          usedPct: '0.0',
        },
      ],
      totals: { allowance: '2000.00', spent: '30.00', usedPct: '1.5' },
      items: [
        {
          position: 1,
          textEn: 'New gate barriers',
          decision: { publicationId: decided },
        },
        { position: 2, textEn: 'Gardens replanted', decision: null },
      ],
    });
    // A year that ended is reported as it closed.
    expect(report.asOf.slice(5)).toBe('12-31');
    expect(JSON.stringify(report)).not.toContain('A vendor');
    // Tenants read it, and are told, as owners are.
    const read = (
      await f
        .http('get', `/finance/spending-reports/${report.id}`, tenant.token)
        .expect(200)
    ).body as Report;
    expect(read).toEqual(report);
    for (const who of [tenant, s.owner]) {
      const told = await inTx((tx) =>
        tx.notification.findMany({
          where: {
            accountId: who.id,
            kind: 'finance.spending_report_published',
            targetId: report.id,
          },
        }),
      );
      expect(told).toHaveLength(1);
      expect(told[0].params).toEqual({
        fiscalYear: String(report.fiscalYear),
        asOf: report.asOf,
      });
    }
    const list = (
      await f
        .http('get', '/finance/spending-reports', s.owner.token)
        .expect(200)
    ).body as { data: Report[] };
    expect(list.data.map((r) => r.id)).toContain(report.id);
    // The budget has a report: a newer one supersedes it, never a second first.
    expect(err(await publish({ budgetId }).expect(409))).toMatchObject({
      code: 'SPENDING_REPORT_EXISTS',
      params: { reportId: report.id },
    });
    // Never changed after.
    await expect(
      inTx((tx) =>
        tx.financeSpendingReportItem.updateMany({
          where: { reportId: report.id },
          data: { textEn: 'Edited' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('only an approved budget; a decision that is not published is not cited; summaries in both languages or neither', async () => {
    const draft = await inTx((tx) =>
      budgetRow(tx, { tenantId: s.c.tenantId, createdById: s.c.managerId }),
    );
    expect(err(await publish({ budgetId: draft }).expect(409))).toMatchObject({
      code: 'BUDGET_NOT_ACTIVE',
      params: { status: 'draft' },
    });
    expect(err(await publish({ budgetId: newId() }).expect(404)).code).toBe(
      'BUDGET_NOT_FOUND',
    );
    expect(
      err(
        await publish({
          budgetId,
          items: [{ textEn: 'X', textAr: 'س', decisionPublicationId: newId() }],
        }).expect(404),
      ).code,
    ).toBe('BOARD_PUBLICATION_NOT_FOUND');
    expect(
      err(await publish({ budgetId, summaryEn: 'Only English' }).expect(400))
        .fields,
    ).toEqual([{ field: 'summaryAr', code: 'FIELD_REQUIRED' }]);
  });

  it('who reads: whoever sees some unit’s money; staff publish with finance.reports', async () => {
    const member = await f.family(s.c, s.home.id, s.owner);
    await f.http('get', '/finance/spending-reports', member.token).expect(403);
    await f.grantFinance(s.c, s.owner, member.memberId);
    await f.http('get', '/finance/spending-reports', member.token).expect(200);
    await publish({ budgetId }, s.owner.token).expect(403);
  });

  it('a newer report supersedes the latest: residents read only it, the staff both; told again; audited', async () => {
    const budget = await activeBudget();
    const old = await published({
      budgetId: budget,
      items: [{ textEn: 'Gate barriers', textAr: 'حواجز' }],
    });
    expect(old).toMatchObject({ supersedesId: null, supersededById: null });
    const newer = await published({
      supersedesId: old.id,
      items: [{ textEn: 'Gate barriers, corrected', textAr: 'حواجز، مصححة' }],
    });
    expect(newer).toMatchObject({
      fiscalYear: old.fiscalYear,
      supersedesId: old.id,
      supersededById: null,
    });
    // Residents: the latest only; the old one is not found, with the latest.
    const theirs = (
      await f
        .http('get', '/finance/spending-reports', s.owner.token)
        .expect(200)
    ).body as { data: Report[] };
    expect(theirs.data.map((r) => r.id)).toContain(newer.id);
    expect(theirs.data.map((r) => r.id)).not.toContain(old.id);
    expect(
      err(
        await f
          .http('get', `/finance/spending-reports/${old.id}`, s.owner.token)
          .expect(404),
      ),
    ).toMatchObject({
      code: 'SPENDING_REPORT_NOT_FOUND',
      params: { latestId: newer.id },
    });
    // The staff: both, the old one as it was, saying what replaced it.
    const staffList = (
      await f
        .http('get', '/staff/finance/spending-reports', s.accountant.token)
        .expect(200)
    ).body as { data: Report[] };
    expect(staffList.data.map((r) => r.id)).toEqual(
      expect.arrayContaining([old.id, newer.id]),
    );
    const kept = (
      await f
        .http(
          'get',
          `/staff/finance/spending-reports/${old.id}`,
          s.accountant.token,
        )
        .expect(200)
    ).body as Report;
    expect(kept).toEqual({ ...old, supersededById: newer.id });
    // Readers are told of the newer one.
    expect(
      await inTx((tx) =>
        tx.notification.count({
          where: {
            accountId: s.owner.id,
            kind: 'finance.spending_report_published',
            targetId: newer.id,
          },
        }),
      ),
    ).toBe(1);
    // Superseded once: the old one again names the newer; the newer is next.
    expect(
      err(await publish({ supersedesId: old.id }).expect(409)),
    ).toMatchObject({
      code: 'SPENDING_REPORT_SUPERSEDED',
      params: { reportId: newer.id },
    });
    expect(err(await publish({ budgetId: budget }).expect(409))).toMatchObject({
      code: 'SPENDING_REPORT_EXISTS',
      params: { reportId: newer.id },
    });
    // The same period: never another budget's; never a report that is not.
    expect(
      err(await publish({ supersedesId: newer.id, budgetId }).expect(400))
        .fields,
    ).toEqual([
      {
        field: 'budgetId',
        code: 'INVALID_VALUE',
        params: { budgetId: budget },
      },
    ]);
    expect(err(await publish({ supersedesId: newId() }).expect(404)).code).toBe(
      'SPENDING_REPORT_NOT_FOUND',
    );
    // Set once: the link is never moved.
    await expect(
      inTx((tx) =>
        tx.financeSpendingReport.update({
          where: { id: newer.id },
          data: { supersedesId: null },
        }),
      ),
    ).rejects.toThrow();
  });

  it('the database keeps the line: a report supersedes only its own budget’s, once, and never itself', async () => {
    const [one, two] = [await activeBudget(), await activeBudget()];
    const a = await published({ budgetId: one });
    const b = await published({ budgetId: two });
    const row = (budgetId: string, supersedesId: string, id = newId()) =>
      inTx((tx) =>
        tx.financeSpendingReport.create({
          data: {
            id,
            tenantId: s.c.tenantId,
            budgetId,
            fiscalYear: a.fiscalYear,
            startsOn: dbDate(a.startsOn),
            asOf: dbDate(a.asOf),
            supersedesId,
            publishedBy: s.c.managerId,
          },
        }),
      );
    // Another budget's report.
    await expect(row(two, a.id)).rejects.toThrow();
    // Itself.
    const self = newId();
    await expect(row(one, self, self)).rejects.toThrow();
    // Twice.
    await row(two, b.id);
    await expect(row(two, b.id)).rejects.toThrow();
  });

  it.each([1, 2, 3])(
    'round %i: two newer reports superseding the same one leave one',
    async () => {
      const budget = await activeBudget();
      const old = await published({ budgetId: budget });
      const both = await Promise.all([
        publish({ supersedesId: old.id }),
        publish({ supersedesId: old.id }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(err(both.find((r) => r.status === 409)!).code).toBe(
        'SPENDING_REPORT_SUPERSEDED',
      );
      expect(
        await inTx((tx) =>
          tx.financeSpendingReport.count({ where: { supersedesId: old.id } }),
        ),
      ).toBe(1);
    },
  );

  it('race: two first publications of a budget leave one report', async () => {
    const other = await activeBudget();
    const both = await Promise.all([
      publish({ budgetId: other }),
      publish({ budgetId: other }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await inTx((tx) =>
        tx.financeSpendingReport.count({ where: { budgetId: other } }),
      ),
    ).toBe(1);
  });
});
