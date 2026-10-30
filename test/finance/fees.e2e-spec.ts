import { Prisma } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { err } from '../api/request';
import { addMonths } from '../../src/finance/billing-plans/periods';
import { dbDate, month } from '../setup/compound-clock';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { boardTermRow, publicationRows } from '../setup/governance-rows';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Fee {
  planId: string;
  nameEn: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  amount: string;
  ownTerms: boolean;
  changes: {
    fromAmount: string;
    toAmount: string;
    effectiveOn: string;
    decision: { publicationId: string; decidedOn: string | null } | null;
  }[];
}

let counter = 0;
/**
 * A number for a raw plan invoice, rising: far above the compound's own
 * counter, and the compound is the suite's own.
 */
const nextNumber = () => 900_000_000 + ++counter;

/**
 * ADR 0069: what each fee is and pays for, what a unit pays and when and
 * why its amount changed — and an invoice against the one before it,
 * line by line, with the cause of each change read from the records.
 */
// A plan starts from this month to a year ahead: its periods count from the
// next month on the compound's clock.
const ahead = (n: number) => addMonths(`${month()}-01`, n);

describe('Finance — fee transparency', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Fees Court');
  }, 90_000);

  afterAll(() => h.close());

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) => f.inTx(s.c, fn);

  async function plan(body: object = {}) {
    return (
      await f
        .http('post', '/staff/billing-plans', s.manager.token, {
          nameEn: 'Service charge',
          nameAr: 'رسوم الخدمات',
          kind: 'service_charge',
          frequency: 'monthly',
          amount: '500',
          startsOn: ahead(1),
          issueDaysBefore: 7,
          dueDaysAfterIssue: 10,
          descriptionEn: 'Security, cleaning and the gardens.',
          descriptionAr: 'الأمن والنظافة والحدائق.',
          ...body,
        })
        .expect(201)
    ).body as { id: string };
  }
  const patch = (id: string, body: object) =>
    f.http('patch', `/staff/billing-plans/${id}`, s.manager.token, body);

  /** A board decision the board published; its id. */
  const decision = () =>
    inTx(async (tx) =>
      publicationRows(tx, {
        tenantId: s.c.tenantId,
        termId: await boardTermRow(tx, {
          tenantId: s.c.tenantId,
          createdById: s.c.managerId,
        }),
        accountId: s.c.managerId,
      }),
    );

  /** A plan's invoice to the home for one period, written as the sweep would. */
  const planInvoice = (
    planId: string,
    period: { start: string; end: string },
    amount: string,
  ) =>
    inTx(async (tx) => {
      const batchId = newId();
      await tx.invoiceBatch.create({
        data: {
          id: batchId,
          tenantId: s.c.tenantId,
          target: 'unit',
          unitId: s.home.id,
          kind: 'service_charge',
          unitCount: 1,
          issuedOn: dbDate(period.start),
          dueOn: dbDate(period.start),
          planId,
          periodStartsOn: dbDate(period.start),
        },
      });
      const id = newId();
      await tx.invoice.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          number: nextNumber(),
          batchId,
          unitId: s.home.id,
          kind: 'service_charge',
          total: new Prisma.Decimal(amount),
          currency: 'EGP',
          issuedOn: dbDate(period.start),
          dueOn: dbDate(period.start),
          planId,
          periodStartsOn: dbDate(period.start),
          periodEndsOn: dbDate(period.end),
          lines: {
            create: {
              id: newId(),
              position: 1,
              descriptionEn: `Service charge — ${period.start}`,
              descriptionAr: `رسوم الخدمات — ${period.start}`,
              amount: new Prisma.Decimal(amount),
            },
          },
        },
      });
      return id;
    });

  const fees = async (token: string, unitId = s.home.id) =>
    (
      (await f.http('get', `/units/${unitId}/fees`, token).expect(200))
        .body as { data: Fee[] }
    ).data;

  it('a plan says what it pays for, in both languages or neither', async () => {
    const p = await plan();
    expect(
      err(await patch(p.id, { descriptionEn: null }).expect(400)).fields,
    ).toEqual([{ field: 'descriptionEn', code: 'FIELD_REQUIRED' }]);
    await patch(p.id, { descriptionEn: null, descriptionAr: null }).expect(200);
    expect(
      err(
        await f
          .http('post', '/staff/billing-plans', s.manager.token, {
            nameEn: 'X',
            nameAr: 'س',
            kind: 'service_charge',
            frequency: 'monthly',
            amount: '1',
            startsOn: ahead(1),
            issueDaysBefore: 0,
            dueDaysAfterIssue: 0,
            descriptionAr: 'وحدها',
          })
          .expect(400),
      ).fields,
    ).toEqual([{ field: 'descriptionEn', code: 'FIELD_REQUIRED' }]);
  });

  it('a new amount is kept, from the first period not yet issued, with the board’s decision when one set it; the decision only with a new amount', async () => {
    const p = await plan({ amount: '400' });
    expect(
      err(await patch(p.id, { decisionPublicationId: newId() }).expect(400))
        .fields,
    ).toEqual([{ field: 'decisionPublicationId', code: 'FIELD_NOT_ALLOWED' }]);
    expect(
      err(
        await patch(p.id, {
          amount: '450',
          decisionPublicationId: newId(),
        }).expect(404),
      ).code,
    ).toBe('BOARD_PUBLICATION_NOT_FOUND');
    const decided = await decision();
    expect(
      err(
        await patch(p.id, {
          amount: '400',
          decisionPublicationId: decided,
        }).expect(400),
      ).fields,
    ).toEqual([{ field: 'decisionPublicationId', code: 'FIELD_NOT_ALLOWED' }]);
    // Nothing issued yet: the plan's first period.
    await patch(p.id, { amount: '450', decisionPublicationId: decided }).expect(
      200,
    );
    await planInvoice(p.id, { start: ahead(1), end: ahead(2) }, '450');
    await patch(p.id, { amount: '480' }).expect(200);
    const changes = (
      (
        await f
          .http(
            'get',
            `/staff/billing-plans/${p.id}/amount-changes`,
            s.accountant.token,
          )
          .expect(200)
      ).body as {
        data: {
          fromAmount: string;
          toAmount: string;
          effectiveOn: string;
          decisionPublicationId: string | null;
        }[];
      }
    ).data;
    expect(
      changes.map(
        ({ fromAmount, toAmount, effectiveOn, decisionPublicationId }) => ({
          fromAmount,
          toAmount,
          effectiveOn,
          decisionPublicationId,
        }),
      ),
    ).toEqual([
      {
        fromAmount: '450.00',
        toAmount: '480.00',
        effectiveOn: ahead(2),
        decisionPublicationId: null,
      },
      {
        fromAmount: '400.00',
        toAmount: '450.00',
        effectiveOn: ahead(1),
        decisionPublicationId: decided,
      },
    ]);
    // A change is a fact: the database keeps it as it was.
    await expect(
      inTx((tx) =>
        tx.billingPlanAmountChange.updateMany({
          where: { planId: p.id },
          data: { toAmount: new Prisma.Decimal('1') },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a unit’s fees: what each pays for, its own amount, the changes and the decisions; an excluded plan is not its fee; who sees its money reads them', async () => {
    const p = await plan({
      nameEn: `Water ${newId().slice(0, 4)}`,
      amount: '100',
    });
    const decided = await decision();
    await patch(p.id, { amount: '120', decisionPublicationId: decided }).expect(
      200,
    );
    const away = await plan({ amount: '75' });
    await f
      .http(
        'put',
        `/staff/billing-plans/${away.id}/overrides/${s.home.id}`,
        s.manager.token,
        { excluded: true },
      )
      .expect(200);
    await f
      .http(
        'put',
        `/staff/billing-plans/${p.id}/overrides/${s.home.id}`,
        s.manager.token,
        { amount: '90' },
      )
      .expect(200);
    const mine = await fees(s.owner.token);
    expect(mine.find((x) => x.planId === away.id)).toBeUndefined();
    expect(mine.find((x) => x.planId === p.id)).toMatchObject({
      descriptionEn: 'Security, cleaning and the gardens.',
      amount: '90.00',
      ownTerms: true,
      changes: [
        {
          fromAmount: '100.00',
          toAmount: '120.00',
          decision: { publicationId: decided },
        },
      ],
    });
    const landlordHome = await f.unit(s.c, 'A');
    const landlord = await f.landlord(s.c, landlordHome.id);
    await f.tenant(s.c, landlordHome.id);
    await fees(landlord.token, landlordHome.id);
    expect(
      err(
        await f
          .http('get', `/units/${landlordHome.id}/fees`, s.owner.token)
          .expect(404),
      ).code,
    ).toBe('UNIT_NOT_FOUND');
    const member = await f.family(s.c, s.home.id, s.owner);
    await f.http('get', `/units/${s.home.id}/fees`, member.token).expect(403);
    await f.grantFinance(s.c, s.owner, member.memberId);
    await fees(member.token);
  });

  it('an invoice against the one before: a plan’s amount changed, with its decision; the delta; the first has none before it', async () => {
    const p = await plan({ amount: '500' });
    const first = await planInvoice(
      p.id,
      { start: ahead(3), end: ahead(4) },
      '500',
    );
    const decided = await decision();
    await patch(p.id, { amount: '600', decisionPublicationId: decided }).expect(
      200,
    );
    const second = await planInvoice(
      p.id,
      { start: ahead(4), end: ahead(5) },
      '600',
    );
    const compare = async (id: string) =>
      (
        await f
          .http('get', `/invoices/${id}/comparison`, s.owner.token)
          .expect(200)
      ).body as Record<string, unknown>;
    expect(await compare(first)).toMatchObject({
      invoiceId: first,
      total: '500.00',
      previous: null,
      delta: null,
      lines: [{ change: 'added', amount: '500.00', previousAmount: null }],
    });
    expect(await compare(second)).toMatchObject({
      invoiceId: second,
      total: '600.00',
      previous: { id: first, total: '500.00', issuedOn: ahead(3) },
      delta: '100.00',
      lines: [
        {
          descriptionEn: `Service charge — ${ahead(4)}`,
          amount: '600.00',
          previousAmount: '500.00',
          change: 'changed',
          cause: 'plan_amount_changed',
          decision: { publicationId: decided },
        },
      ],
    });
    // Someone who does not see the unit's money finds no invoice.
    const stranger = await f.owner(s.c, (await f.unit(s.c, 'B')).id);
    expect(
      err(
        await f
          .http('get', `/invoices/${second}/comparison`, stranger.token)
          .expect(404),
      ).code,
    ).toBe('INVOICE_NOT_FOUND');
  });

  it('other invoices pair their lines by text: the same, added and removed', async () => {
    const lines = (...ls: [string, string][]) =>
      ls.map(([descriptionEn, amount]) => ({
        descriptionEn,
        descriptionAr: descriptionEn,
        amount,
      }));
    await f.issue(s.accountant, s.home.id, {
      kind: 'other',
      lines: lines(['Lift', '200'], ['Pool', '50']),
    });
    const { invoiceId } = await f.issue(s.accountant, s.home.id, {
      kind: 'other',
      lines: lines(['Lift', '200'], ['Paint', '80']),
    });
    const body = (
      await f
        .http('get', `/invoices/${invoiceId}/comparison`, s.owner.token)
        .expect(200)
    ).body as {
      delta: string;
      lines: { descriptionEn: string; change: string; cause: string | null }[];
    };
    expect(body.delta).toBe('30.00');
    expect(body.lines.map((l) => [l.descriptionEn, l.change, l.cause])).toEqual(
      [
        ['Lift', 'same', null],
        ['Paint', 'added', null],
        ['Pool', 'removed', null],
      ],
    );
  });
});
