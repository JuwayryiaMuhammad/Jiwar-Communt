import type { Response } from 'supertest';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { INVOICE_REMINDERS_SWEEP } from '../../src/finance/invoices/invoice-reminders.sweep';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { eraseNow } from '../setup/erasure';
import { day } from '../setup/facilities';
import { fileHelpers } from '../setup/files';
import { financeHelpers, type FinanceSetUp, type Who } from '../setup/finance';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { FakePaymob } from '../setup/paymob-fake';

interface Dispute {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  reasonCode: string;
  text: string | null;
  photoUrl: string | null;
  mine: boolean;
  status: string;
  decision: {
    reasonCode: string | null;
    creditedAmount: string | null;
    creditNoteId: string | null;
  } | null;
}
interface StaffDispute extends Omit<Dispute, 'mine'> {
  unitCode: string;
  cleared: boolean;
  outstanding: string;
}

const body = <T>(res: Response) => res.body as T;
const code = (res: Response) => body<{ code: string }>(res).code;
const params = (res: Response) =>
  body<{ params: Record<string, unknown> }>(res).params;

/**
 * Invoice disputes (ADR 0048): whoever sees a unit's money disputes an
 * invoice that still owes something, once at a time; while open the
 * invoice is frozen. The staff accept with a credit note (at most what is
 * owed then) or reject with a reason, once; the opener is told. The
 * opener's words and photo are theirs, and go when they are erased.
 */
describe('Finance — invoice disputes', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let files: ReturnType<typeof fileHelpers>;
  let s: FinanceSetUp;
  const paymob = new FakePaymob();

  beforeAll(async () => {
    h = await createHttpHarness({ paymob });
    f = financeHelpers(h);
    files = fileHelpers(h);
    s = await f.setUp('Disputes Court');
  });

  afterAll(() => h.close());

  const open = (
    invoiceId: string,
    who: Who,
    payload: Record<string, unknown> = { reasonCode: 'wrong_amount' },
  ) => f.http('post', `/invoices/${invoiceId}/disputes`, who.token, payload);
  const decide = (id: string, payload: Record<string, unknown>) =>
    f.http(
      'post',
      `/staff/invoice-disputes/${id}/decide`,
      s.accountant.token,
      payload,
    );
  const staffView = async (id: string) =>
    body<StaffDispute>(
      await f
        .http('get', `/staff/invoice-disputes/${id}`, s.manager.token)
        .expect(200),
    );
  const invoice = async (id: string) =>
    body<{
      status: string;
      credited: string;
      paid: string;
      outstanding: string;
      dispute: { id: string; status: string; mine: boolean } | null;
    }>(
      await f.http('get', `/staff/invoices/${id}`, s.manager.token).expect(200),
    );
  const sweep = (name: string) =>
    h.moduleRef.get(SweepRunner).run(name, new Date());
  /** A unit with its owner and a tenant: two people who see its money. */
  async function household() {
    const home = await f.unit(s.c, 'A');
    return {
      home,
      owner: await f.owner(s.c, home.id),
      tenant: await f.tenant(s.c, home.id),
    };
  }

  describe('opening', () => {
    it('the opener’s words and photo are theirs and the staff’s; the unit’s other viewers see the code and the status', async () => {
      const { home, owner, tenant } = await household();
      const { invoiceId } = await f.issue(s.manager, home.id);
      const photo = await files.ready(owner.token, 'dispute_photo');
      const res = await open(invoiceId, owner, {
        reasonCode: 'service_not_provided',
        text: '  The lift was never fixed  ',
        photoFileId: photo,
      }).expect(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const mine = body<Dispute>(res);
      expect(mine).toMatchObject({
        invoiceId,
        reasonCode: 'service_not_provided',
        text: 'The lift was never fixed',
        photoUrl: expect.any(String) as string,
        mine: true,
        status: 'open',
        decision: null,
      });
      const theirs = body<Dispute[]>(
        await f
          .http('get', `/invoices/${invoiceId}/disputes`, tenant.token)
          .expect(200),
      );
      expect(theirs).toEqual([
        expect.objectContaining({
          id: mine.id,
          reasonCode: 'service_not_provided',
          text: null,
          photoUrl: null,
          mine: false,
          status: 'open',
        }),
      ]);
      expect(JSON.stringify(theirs)).not.toContain(owner.id);
      const staff = await staffView(mine.id);
      expect(staff).toMatchObject({
        unitCode: home.code,
        text: 'The lift was never fixed',
        photoUrl: expect.any(String) as string,
        cleared: false,
        outstanding: '1000.00',
      });
      expect((await invoice(invoiceId)).dispute).toMatchObject({
        id: mine.id,
        status: 'open',
        mine: false,
      });
      // The photo was attached: the opener cannot reuse it.
      const { invoiceId: other } = await f.issue(s.manager, home.id);
      const reused = await open(other, owner, {
        reasonCode: 'other',
        photoFileId: photo,
      }).expect(400);
      expect(
        body<{ fields: { field: string; code: string }[] }>(reused).fields,
      ).toEqual([{ field: 'photoFileId', code: 'FILE_NOT_AVAILABLE' }]);
    });

    it('one open dispute per invoice, even at once; not on an invoice that owes nothing; not by someone who does not see the money', async () => {
      const { home, owner, tenant } = await household();
      const { invoiceId } = await f.issue(s.manager, home.id);
      const both = await Promise.all([
        open(invoiceId, owner),
        open(invoiceId, tenant),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(code(both.find((r) => r.status === 409)!)).toBe(
        'DISPUTE_ALREADY_OPEN',
      );
      const { invoiceId: paid } = await f.issue(s.manager, home.id);
      await f
        .http('post', `/staff/units/${home.id}/payments`, s.accountant.token, {
          amount: '1000',
          method: 'cash',
          paidOn: day(0),
          invoiceIds: [paid],
        })
        .expect(201);
      expect(code(await open(paid, owner).expect(409))).toBe(
        'INVOICE_NOT_DISPUTABLE',
      );
      const stranger = await f.owner(s.c, (await f.unit(s.c, 'B')).id);
      expect(code(await open(invoiceId, stranger).expect(404))).toBe(
        'INVOICE_NOT_FOUND',
      );
      const bad = await open(invoiceId, owner, { reasonCode: 'too_expensive' });
      expect(bad.status).toBe(400);
    });

    it('after a decision the invoice may be disputed again, three times in all', async () => {
      const { home, owner } = await household();
      const { invoiceId } = await f.issue(s.manager, home.id);
      for (let i = 0; i < 3; i += 1) {
        const d = body<Dispute>(await open(invoiceId, owner).expect(201));
        await decide(d.id, {
          decision: 'reject',
          reasonCode: 'charge_is_correct',
        }).expect(201);
      }
      const fourth = await open(invoiceId, owner).expect(409);
      expect([code(fourth), params(fourth)]).toEqual([
        'DISPUTE_LIMIT_REACHED',
        { max: 3 },
      ]);
    });
  });

  describe('while open, the invoice is frozen', () => {
    it('it cannot be credited, paid by name, split; payments naming nothing leave it out', async () => {
      const { home, owner } = await household();
      const disputed = await f.issue(s.manager, home.id);
      const other = await f.issue(s.manager, home.id, { dueOn: day(20) });
      await open(disputed.invoiceId, owner).expect(201);
      const credit = await f
        .http(
          'post',
          `/staff/invoices/${disputed.invoiceId}/credit-notes`,
          s.manager.token,
          { amount: '10', reasonCode: 'waiver' },
        )
        .expect(409);
      expect(code(credit)).toBe('INVOICE_DISPUTED');
      const named = await f
        .http('post', `/staff/units/${home.id}/payments`, s.accountant.token, {
          amount: '100',
          method: 'cash',
          paidOn: day(0),
          invoiceIds: [disputed.invoiceId],
        })
        .expect(409);
      expect([code(named), params(named)]).toEqual([
        'INVOICE_DISPUTED',
        { invoiceIds: [disputed.invoiceId] },
      ]);
      const unnamed = await f
        .http('post', `/staff/units/${home.id}/payments`, s.accountant.token, {
          amount: '1500',
          method: 'cash',
          paidOn: day(0),
        })
        .expect(409);
      expect([code(unnamed), params(unnamed)]).toEqual([
        'PAYMENT_EXCEEDS_OUTSTANDING',
        { outstanding: '1000.00' },
      ]);
      const split = await f
        .http(
          'post',
          `/staff/invoices/${disputed.invoiceId}/instalment-plan`,
          s.manager.token,
          {
            instalments: [
              { dueOn: day(5), amount: '500' },
              { dueOn: day(35), amount: '500' },
            ],
          },
        )
        .expect(409);
      expect(code(split)).toBe('INVOICE_DISPUTED');
      // Paying what is not disputed works, oldest due first among those.
      await f
        .http('post', `/staff/units/${home.id}/payments`, s.accountant.token, {
          amount: '1000',
          method: 'cash',
          paidOn: day(0),
        })
        .expect(201);
      expect((await invoice(other.invoiceId)).outstanding).toBe('0.00');
      expect((await invoice(disputed.invoiceId)).outstanding).toBe('1000.00');
    });

    it('a checkout cannot name it, and one naming nothing leaves it out; opening the dispute closes the live checkout', async () => {
      const t = await f.setUp('Disputes Checkout');
      await f.configureGateway(t.manager);
      const disputed = await f.issue(t.manager, t.home.id);
      const live = body<{ id: string }>(
        await f
          .http(
            'post',
            `/units/${t.home.id}/payment-sessions`,
            t.owner.token,
            {},
          )
          .expect(201),
      );
      await f
        .http(
          'post',
          `/invoices/${disputed.invoiceId}/disputes`,
          t.owner.token,
          {
            reasonCode: 'already_paid',
          },
        )
        .expect(201);
      expect(
        body<{ status: string }>(
          await f
            .http('get', `/payment-sessions/${live.id}`, t.owner.token)
            .expect(200),
        ).status,
      ).toBe('superseded');
      const named = await f
        .http('post', `/units/${t.home.id}/payment-sessions`, t.owner.token, {
          invoiceIds: [disputed.invoiceId],
        })
        .expect(409);
      expect(code(named)).toBe('INVOICE_DISPUTED');
      expect(
        code(
          await f
            .http(
              'post',
              `/units/${t.home.id}/payment-sessions`,
              t.owner.token,
              {},
            )
            .expect(409),
        ),
      ).toBe('NOTHING_TO_PAY');
      const other = await f.issue(t.manager, t.home.id, { dueOn: day(20) });
      const session = body<{
        amount: string;
        invoices: { invoiceId: string }[];
      }>(
        await f
          .http(
            'post',
            `/units/${t.home.id}/payment-sessions`,
            t.owner.token,
            {},
          )
          .expect(201),
      );
      expect(session.amount).toBe('1000.00');
      expect(session.invoices.map((i) => i.invoiceId)).toEqual([
        other.invoiceId,
      ]);
    });

    it('credit waits: it pays the invoice once the dispute is rejected', async () => {
      const t = await f.setUp('Disputes Credit');
      const creds = await f.configureGateway(t.manager);
      const small = await f.issue(t.manager, t.home.id, {
        lines: [{ descriptionEn: 'Fee', descriptionAr: 'رسم', amount: '300' }],
      });
      // A checkout of the small invoice, overtaken by an office payment:
      // its late success becomes the unit's credit.
      const session = body<{ id: string }>(
        await f
          .http('post', `/units/${t.home.id}/payment-sessions`, t.owner.token, {
            invoiceIds: [small.invoiceId],
          })
          .expect(201),
      );
      await f
        .http(
          'post',
          `/staff/units/${t.home.id}/payments`,
          t.accountant.token,
          {
            amount: '300',
            method: 'cash',
            paidOn: day(0),
          },
        )
        .expect(201);
      const disputed = await f.issue(t.manager, t.home.id);
      const d = body<Dispute>(
        await f
          .http(
            'post',
            `/invoices/${disputed.invoiceId}/disputes`,
            t.owner.token,
            {
              reasonCode: 'wrong_amount',
            },
          )
          .expect(201),
      );
      const intention = paymob.byReference(`jw-${session.id}`);
      intention.paid = true;
      const cb = paymob.callback(intention, creds.hmacSecret);
      await h
        .http()
        .post(`${API}/public/payments/paymob/${t.c.tenantId}?hmac=${cb.hmac}`)
        .send(cb.body)
        .expect(200);
      const statement = async () =>
        body<{ outstanding: string; credit: string }>(
          await f
            .http('get', `/units/${t.home.id}/statement`, t.owner.token)
            .expect(200),
        );
      expect(await statement()).toMatchObject({
        outstanding: '1000.00',
        credit: '300.00',
      });
      await f
        .http(
          'post',
          `/staff/invoice-disputes/${d.id}/decide`,
          t.manager.token,
          {
            decision: 'reject',
            reasonCode: 'charge_is_correct',
          },
        )
        .expect(201);
      expect(await statement()).toMatchObject({
        outstanding: '700.00',
        credit: '0.00',
      });
    });

    it('reminders pause, and resume after the decision', async () => {
      const { home, owner } = await household();
      const { invoiceId } = await f.issue(s.manager, home.id, {
        dueOn: day(2),
      });
      const d = body<Dispute>(await open(invoiceId, owner).expect(201));
      await sweep(INVOICE_REMINDERS_SWEEP);
      expect(await f.notifications(s.c, owner.id, 'invoice.due_soon')).toEqual(
        [],
      );
      await decide(d.id, {
        decision: 'reject',
        reasonCode: 'charge_is_correct',
      }).expect(201);
      await sweep(INVOICE_REMINDERS_SWEEP);
      expect(
        (await f.notifications(s.c, owner.id, 'invoice.due_soon')).map(
          (n) => n.targetId,
        ),
      ).toEqual([invoiceId]);
    });
  });

  describe('deciding', () => {
    it('accept credits at most what is owed now; the opener alone is told; once', async () => {
      const { home, owner, tenant } = await household();
      const { invoiceId } = await f.issue(s.manager, home.id);
      const d = body<Dispute>(await open(invoiceId, tenant).expect(201));
      const shape = await decide(d.id, { decision: 'accept' }).expect(400);
      expect(
        body<{ fields: { field: string; code: string }[] }>(shape).fields,
      ).toEqual([{ field: 'amount', code: 'FIELD_REQUIRED' }]);
      const extra = await decide(d.id, {
        decision: 'reject',
        reasonCode: 'other',
        amount: '1',
      }).expect(400);
      expect(
        body<{ fields: { field: string; code: string }[] }>(extra).fields,
      ).toEqual([{ field: 'amount', code: 'FIELD_NOT_ALLOWED' }]);
      const over = await decide(d.id, {
        decision: 'accept',
        amount: '1000.01',
      }).expect(409);
      expect([code(over), params(over)]).toEqual([
        'CREDIT_EXCEEDS_OUTSTANDING',
        { outstanding: '1000.00' },
      ]);
      const accepted = body<StaffDispute>(
        await decide(d.id, { decision: 'accept', amount: '250' }).expect(201),
      );
      expect(accepted).toMatchObject({
        status: 'accepted',
        outstanding: '750.00',
        decision: {
          reasonCode: null,
          creditedAmount: '250.00',
          creditNoteId: expect.any(String) as string,
        },
      });
      expect(await invoice(invoiceId)).toMatchObject({
        credited: '250.00',
        outstanding: '750.00',
        status: 'unpaid',
      });
      const detail = body<{
        creditNotes: { reasonCode: string; amount: string }[];
      }>(
        await f
          .http('get', `/staff/invoices/${invoiceId}`, s.manager.token)
          .expect(200),
      );
      expect(detail.creditNotes).toEqual([
        expect.objectContaining({ reasonCode: 'dispute', amount: '250.00' }),
      ]);
      expect(
        (await f.notifications(s.c, tenant.id, 'invoice.dispute_accepted')).map(
          (n) => [n.targetId, n.params],
        ),
      ).toEqual([[d.id, {}]]);
      expect(
        await f.notifications(s.c, owner.id, 'invoice.dispute_accepted'),
      ).toEqual([]);
      const again = await decide(d.id, {
        decision: 'reject',
        reasonCode: 'other',
      }).expect(409);
      expect([code(again), params(again)]).toEqual([
        'DISPUTE_ALREADY_DECIDED',
        { status: 'accepted' },
      ]);
    });

    it('reject: the invoice stands, the opener is told, the reason shows', async () => {
      const { home, owner } = await household();
      const { invoiceId } = await f.issue(s.manager, home.id);
      const d = body<Dispute>(await open(invoiceId, owner).expect(201));
      await decide(d.id, {
        decision: 'reject',
        reasonCode: 'outside_policy',
      }).expect(201);
      const seen = body<Dispute>(
        await f
          .http('get', `/invoice-disputes/${d.id}`, owner.token)
          .expect(200),
      );
      expect(seen).toMatchObject({
        status: 'rejected',
        decision: { reasonCode: 'outside_policy', creditedAmount: null },
      });
      expect(
        (await f.notifications(s.c, owner.id, 'invoice.dispute_rejected')).map(
          (n) => n.targetId,
        ),
      ).toEqual([d.id]);
      expect((await invoice(invoiceId)).outstanding).toBe('1000.00');
    });

    it('a checkout paid late after the dispute opened lands; the staff reject with no_longer_owed', async () => {
      const t = await f.setUp('Disputes Late');
      const creds = await f.configureGateway(t.manager);
      const { invoiceId } = await f.issue(t.manager, t.home.id);
      const session = body<{ id: string }>(
        await f
          .http(
            'post',
            `/units/${t.home.id}/payment-sessions`,
            t.owner.token,
            {},
          )
          .expect(201),
      );
      const d = body<Dispute>(
        await f
          .http('post', `/invoices/${invoiceId}/disputes`, t.owner.token, {
            reasonCode: 'already_paid',
          })
          .expect(201),
      );
      const intention = paymob.byReference(`jw-${session.id}`);
      intention.paid = true;
      const cb = paymob.callback(intention, creds.hmacSecret);
      await h
        .http()
        .post(`${API}/public/payments/paymob/${t.c.tenantId}?hmac=${cb.hmac}`)
        .send(cb.body)
        .expect(200);
      const staff = body<StaffDispute>(
        await f
          .http('get', `/staff/invoice-disputes/${d.id}`, t.manager.token)
          .expect(200),
      );
      expect(staff).toMatchObject({ status: 'open', outstanding: '0.00' });
      await f
        .http(
          'post',
          `/staff/invoice-disputes/${d.id}/decide`,
          t.manager.token,
          {
            decision: 'reject',
            reasonCode: 'no_longer_owed',
          },
        )
        .expect(201);
    });
  });

  describe('erasure', () => {
    it('clears the opener’s words and photo; the dispute stays and can still be decided', async () => {
      const home = await f.unit(s.c, 'A');
      await f.owner(s.c, home.id);
      const p = await f.x.resident(s.c, [home.id]);
      const opener = await f.who(s.c, p.id, 'resident');
      const { invoiceId } = await f.issue(s.manager, home.id);
      const photo = await files.ready(opener.token, 'dispute_photo');
      const d = body<Dispute>(
        await open(invoiceId, opener, {
          reasonCode: 'wrong_amount',
          text: 'My own words',
          photoFileId: photo,
        }).expect(201),
      );
      await eraseNow(h, s.c, p.id);
      const row = await f.x.asManager(s.c, () =>
        h.moduleRef
          .get(TenantTx)
          .withTenantTx((tx) =>
            tx.invoiceDispute.findUniqueOrThrow({ where: { id: d.id } }),
          ),
      );
      expect(row).toMatchObject({
        text: null,
        photoFileId: null,
        reasonCode: 'wrong_amount',
        status: 'open',
        openedById: p.id,
      });
      expect(row.textClearedAt).not.toBeNull();
      const file = await f.x.asManager(s.c, () =>
        h.moduleRef
          .get(TenantTx)
          .withTenantTx((tx) =>
            tx.storedFile.findUnique({ where: { id: photo } }),
          ),
      );
      expect(file?.deletedAt ?? 'purged').not.toBeNull();
      expect(await staffView(d.id)).toMatchObject({
        text: null,
        photoUrl: null,
        cleared: true,
      });
      await decide(d.id, { decision: 'accept', amount: '100' }).expect(201);
    });
  });
});
