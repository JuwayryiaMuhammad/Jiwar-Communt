import { AccountsService } from '../../src/core/accounts/accounts.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { day } from '../setup/facilities';
import { financeHelpers, type Who } from '../setup/finance';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { FakePaymob } from '../setup/paymob-fake';

/**
 * ADR 0046 with ADR 0023 and 0036: what a personal-data export holds of a
 * unit's money, and what becomes of an account's checkouts and payments
 * when it is deactivated, erased or leaves. Nothing is deleted.
 */
describe('Finance — export, erasure, deactivation and leaving', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  const paymob = new FakePaymob();

  beforeAll(async () => {
    h = await createHttpHarness({ paymob });
    f = financeHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  async function exportOf(p: Who & { email: string }) {
    await stepUp(h, p.token, p.email);
    const asked = await h
      .http()
      .post(`${API}/me/data-exports`)
      .set('Authorization', `Bearer ${p.token}`)
      .send({})
      .expect(201);
    await buildExports(h);
    const dl = await h
      .http()
      .get(
        `${API}/me/data-exports/${(asked.body as { id: string }).id}/download`,
      )
      .set('Authorization', `Bearer ${p.token}`)
      .expect(200);
    return readArchive((dl.body as { url: string }).url);
  }

  /** A second owner living in the unit: not its primary, so they can go. */
  async function resident(s: Awaited<ReturnType<typeof f.setUp>>) {
    const p = await f.x.resident(s.c, [s.home.id]);
    return { ...p, ...(await f.who(s.c, p.id, 'resident')) };
  }

  const sessions = (
    s: Awaited<ReturnType<typeof f.setUp>>,
    accountId: string,
  ) =>
    f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        tx.paymentSession.findMany({
          where: { accountId },
          select: { status: true },
        }),
      ),
    );

  it('the export holds, per unit whose money the account sees, its statement, invoices and payments; and its checkouts', async () => {
    const s = await f.setUp('Finance Privacy Export');
    await f.configureGateway(s.manager);
    const p = await resident(s);
    const { invoiceId } = await f.issue(s.manager, s.home.id);
    await f
      .http('post', `/staff/units/${s.home.id}/payments`, s.accountant.token, {
        amount: '400',
        method: 'cash',
        paidOn: day(0),
      })
      .expect(201);
    await f
      .http('post', `/units/${s.home.id}/payment-sessions`, p.token, {})
      .expect(201);
    const archive = await exportOf(p);
    const names = archive.names.filter((n) => n.startsWith('finance/')).sort();
    expect(names).toEqual(
      [
        'finance/checkouts.json',
        'finance/disputes.json',
        `finance/${s.home.code}.json`,
      ].sort(),
    );
    const unit = JSON.parse(archive.text(`finance/${s.home.code}.json`)) as {
      statement: { outstanding: string };
      invoices: { id: string }[];
      payments: { recordedBy: unknown; receiptCode: string }[];
    };
    expect(unit.statement.outstanding).toBe('600.00');
    expect(unit.invoices.map((i) => i.id)).toEqual([invoiceId]);
    expect(unit.payments).toHaveLength(1);
    expect(unit.payments[0].recordedBy).toBeNull();
    const checkouts = JSON.parse(archive.text('finance/checkouts.json')) as {
      status: string;
      amount: string;
    }[];
    expect(checkouts).toEqual([
      expect.objectContaining({ status: 'open', amount: '600.00' }),
    ]);
    expect(archive.text('finance/checkouts.json')).not.toMatch(
      /egy_csk|client/i,
    );
  });

  it('the export holds the disputes the account opened, with its own words; never another’s (ADR 0048)', async () => {
    const s = await f.setUp('Finance Privacy Disputes');
    const p = await resident(s);
    const { invoiceId } = await f.issue(s.manager, s.home.id);
    const other = await f.issue(s.manager, s.home.id);
    const mine = (
      await f
        .http('post', `/invoices/${invoiceId}/disputes`, p.token, {
          reasonCode: 'wrong_amount',
          text: 'My own words',
        })
        .expect(201)
    ).body as { id: string };
    await f
      .http('post', `/invoices/${other.invoiceId}/disputes`, s.owner.token, {
        reasonCode: 'other',
        text: 'The owner’s words',
      })
      .expect(201);
    await f
      .http(
        'post',
        `/staff/invoice-disputes/${mine.id}/decide`,
        s.manager.token,
        {
          decision: 'accept',
          amount: '100',
        },
      )
      .expect(201);
    const archive = await exportOf(p);
    const disputes = JSON.parse(archive.text('finance/disputes.json')) as {
      id: string;
      text: string;
      status: string;
      creditedAmount: string;
    }[];
    expect(disputes).toEqual([
      expect.objectContaining({
        id: mine.id,
        text: 'My own words',
        status: 'accepted',
        creditedAmount: '100.00',
      }),
    ]);
    expect(archive.text('finance/disputes.json')).not.toContain(
      'The owner’s words',
    );
  });

  it('deactivated: its open checkouts stop; its payments stay', async () => {
    const s = await f.setUp('Finance Privacy Deactivated');
    await f.configureGateway(s.manager);
    const p = await resident(s);
    await f.issue(s.manager, s.home.id);
    await f
      .http('post', `/units/${s.home.id}/payment-sessions`, p.token, {})
      .expect(201);
    await f.x.asManager(s.c, () =>
      h.moduleRef
        .get(AccountsService)
        .updateStatus(p.id, { status: 'inactive' }),
    );
    expect((await sessions(s, p.id)).map((x) => x.status)).toEqual([
      'superseded',
    ]);
  });

  it('erased: its checkouts stop; payments keep pointing at the tombstone', async () => {
    const s = await f.setUp('Finance Privacy Erased');
    await f.configureGateway(s.manager);
    const p = await resident(s);
    await f.issue(s.manager, s.home.id);
    await f
      .http('post', `/units/${s.home.id}/payment-sessions`, p.token, {})
      .expect(201);
    await eraseNow(h, s.c, p.id);
    expect((await sessions(s, p.id)).map((x) => x.status)).toEqual([
      'superseded',
    ]);
  });

  it('leaving the unit: its checkouts there stop', async () => {
    const s = await f.setUp('Finance Privacy Leaving');
    await f.configureGateway(s.manager);
    const p = await resident(s);
    await f.issue(s.manager, s.home.id);
    await f
      .http('post', `/units/${s.home.id}/payment-sessions`, p.token, {})
      .expect(201);
    await f.x.asManager(s.c, async () => {
      const occupancy = await f.x.prisma.tenant.unitOccupancy.findFirstOrThrow({
        where: { accountId: p.id, unitId: s.home.id, status: 'active' },
      });
      await f.x.residents.endOccupancy(occupancy.id, {
        code: 'moved_out',
        text: 'Moved out',
      });
    });
    expect((await sessions(s, p.id)).map((x) => x.status)).toEqual([
      'superseded',
    ]);
  });
});
