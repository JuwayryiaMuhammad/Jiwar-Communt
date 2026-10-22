import {
  TenantTx,
  type TenantTxClient,
} from '../../src/core/database/tenant-tx.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { LATE_NOTICES_SWEEP } from '../../src/finance/late-notices/late-notices.service';
import { dbClock } from '../setup/compound-clock';
import { day } from '../setup/facilities';
import {
  backdateInvoice,
  financeHelpers,
  type FinanceSetUp,
} from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { drainOutbox } from '../setup/outbox';

interface Notice {
  id: string;
  number: string;
  type: string;
  subjectId: string;
  amount: string;
  dueOn: string;
  deliveredAt: string;
  emailedAt: string | null;
  readAt: string | null;
}

/**
 * The formal late-payment notice (ADR 0058): after the due date and the
 * compound's cure period, once per invoice, to the unit's finance holders,
 * with proofs of delivery (the inbox, the email's sending) and of reading
 * (the first opening), each kept once.
 */
describe('Finance — the formal late-payment notice', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  const sweep = () => h.moduleRef.get(SweepRunner).run(LATE_NOTICES_SWEEP);
  const mine = async (s: FinanceSetUp) =>
    (
      (await f.http('get', '/me/notices', s.owner.token).expect(200)).body as {
        data: Notice[];
      }
    ).data;
  const noticesOf = (s: FinanceSetUp, invoiceId: string) =>
    f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        tx.formalNotice.findMany({
          where: { subjectId: invoiceId },
          include: { recipients: true },
        }),
      ),
    );
  const pay = (s: FinanceSetUp, amount: string) =>
    f.http('post', `/staff/units/${s.home.id}/payments`, s.accountant.token, {
      amount,
      method: 'cash',
      paidOn: day(0),
    });

  it('after the cure period: once, delivered, emailed and read, each proof kept', async () => {
    const s = await f.setUp('Late Notice Court');
    const { invoiceId } = await f.issue(s.manager, s.home.id);
    await backdateInvoice(invoiceId, 25); // due 15 days ago (due in 10)
    await sweep();
    const [notice] = await noticesOf(s, invoiceId);
    expect(notice).toMatchObject({ type: 'late_payment', unitId: s.home.id });
    expect(notice.recipients.map((r) => r.accountId)).toEqual([s.owner.id]);
    // Once.
    await sweep();
    expect(await noticesOf(s, invoiceId)).toHaveLength(1);

    const told = await f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        tx.notification.findMany({
          where: { targetId: notice.id, kind: 'formal_notice.issued' },
        }),
      ),
    );
    expect(told.map((n) => [n.accountId, n.params])).toEqual([
      [s.owner.id, { type: 'late_payment' }],
    ]);

    const [listed] = await mine(s);
    expect(listed).toMatchObject({
      id: notice.id,
      number: expect.stringMatching(/^FN-\d{6}$/) as string,
      subjectId: invoiceId,
      amount: '1000.00',
      emailedAt: null,
      readAt: null,
    });
    await drainOutbox(h);
    const [emailed] = await mine(s);
    expect(emailed.emailedAt).not.toBeNull();

    const opened = (
      await f.http('get', `/me/notices/${notice.id}`, s.owner.token).expect(200)
    ).body as Notice;
    expect(opened.readAt).not.toBeNull();
    const again = (
      await f.http('get', `/me/notices/${notice.id}`, s.owner.token).expect(200)
    ).body as Notice;
    expect(again.readAt).toBe(opened.readAt);
    expect(again.emailedAt).toBe(emailed.emailedAt);

    // The staff see each recipient's proofs.
    const staff = (
      (
        await f
          .http('get', '/staff/finance/late-notices', s.manager.token)
          .expect(200)
      ).body as {
        data: { id: string; recipients: { readAt: string | null }[] }[];
      }
    ).data;
    expect(staff.find((n) => n.id === notice.id)?.recipients[0].readAt).toBe(
      opened.readAt,
    );
    // Someone else's notice is not found.
    const other = await f.setUp('Late Notice Other');
    const refused = await f
      .http('get', `/me/notices/${notice.id}`, other.owner.token)
      .expect(404);
    expect((refused.body as { code: string }).code).toBe(
      'FORMAL_NOTICE_NOT_FOUND',
    );
  });

  it('the cure period is the compound’s; nothing while paid or disputed', async () => {
    const s = await f.setUp('Late Notice Cure');
    const early = (await f.issue(s.manager, s.home.id)).invoiceId;
    await backdateInvoice(early, 18); // due 8 days ago
    await sweep();
    expect(await noticesOf(s, early)).toEqual([]);
    await f
      .http('patch', '/staff/finance/notice-settings', s.manager.token, {
        lateNoticeCureDays: 5,
      })
      .expect(200);
    await sweep();
    expect(await noticesOf(s, early)).toHaveLength(1);

    // Another unit's compound: one invoice paid, one disputed.
    const t = await f.setUp('Late Notice Paid');
    const paid = (await f.issue(t.manager, t.home.id)).invoiceId;
    await pay(t, '1000').expect(201);
    await backdateInvoice(paid, 30);
    const disputed = (await f.issue(t.manager, t.home.id)).invoiceId;
    await f
      .http('post', `/invoices/${disputed}/disputes`, t.owner.token, {
        reasonCode: 'wrong_amount',
      })
      .expect(201);
    await backdateInvoice(disputed, 30);
    await sweep();
    expect(await noticesOf(t, paid)).toEqual([]);
    expect(await noticesOf(t, disputed)).toEqual([]);
  });

  it('a payment racing the sweep: a notice only for what was still owed (×3)', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await f.setUp(`Late Notice Race ${i}`);
      const { invoiceId } = await f.issue(s.manager, s.home.id);
      await backdateInvoice(invoiceId, 30);
      const [paid] = await Promise.all([
        pay(s, '1000').then((r) => r.status),
        sweep(),
      ]);
      expect(paid).toBe(201);
      const notices = await noticesOf(s, invoiceId);
      if (notices.length) {
        // The sweep came first: the notice says what was owed then.
        expect(notices[0].amount.toFixed(2)).toBe('1000.00');
        expect(notices[0].issuedAt.getTime()).toBeLessThanOrEqual(
          dbClock().getTime() + 1000,
        );
      }
      // Either way, a later sweep never notices a paid invoice.
      await sweep();
      expect(await noticesOf(s, invoiceId)).toHaveLength(notices.length);
    }
  });

  it('a notice never changes, and a proof is set once (the database)', async () => {
    const s = await f.setUp('Late Notice Immutable');
    const { invoiceId } = await f.issue(s.manager, s.home.id);
    await backdateInvoice(invoiceId, 30);
    await sweep();
    const [notice] = await noticesOf(s, invoiceId);
    await f.http('get', `/me/notices/${notice.id}`, s.owner.token).expect(200);
    const raw = (sql: (tx: TenantTxClient) => Promise<unknown>) =>
      f.x.asManager(s.c, () => h.moduleRef.get(TenantTx).withTenantTx(sql));
    await expect(
      raw(
        (tx) =>
          tx.$executeRaw`UPDATE formal_notices SET amount = 1 WHERE id = ${notice.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      raw(
        (tx) =>
          tx.$executeRaw`UPDATE formal_notice_recipients SET read_at = NULL WHERE notice_id = ${notice.id}::uuid`,
      ),
    ).rejects.toThrow(/set once/);
    await expect(
      raw(
        (tx) =>
          tx.$executeRaw`UPDATE formal_notice_recipients SET read_at = now() + interval '1 day' WHERE notice_id = ${notice.id}::uuid`,
      ),
    ).rejects.toThrow(/set once/);
  });
});
