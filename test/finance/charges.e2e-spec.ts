import { unitCredit } from '../../src/finance/payments/allocation';
import { at, day } from '../setup/compound-clock';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { FakePaymob } from '../setup/paymob-fake';

/**
 * The charges port's finance side (ADR 0070): a charge is paid once its
 * invoice is settled by payments — at the office, online, or by the unit's
 * credit as it is issued — stamped once in that transaction, which runs the
 * source's handler; a cancel credits what the invoice could still take,
 * and paid money becomes the unit's credit. A cancel and a payment at once
 * leave one credit note and no money lost.
 */
describe('Finance — charges (ADR 0070)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  const paymob = new FakePaymob();

  beforeAll(async () => {
    h = await createHttpHarness({ paymob });
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  /** A paying court and one booking of it by the owner: the booking, its invoice. */
  async function charged(s: FinanceSetUp, fee = '150.00', dayN = 5) {
    const court = await f.facility(s.c, s.manager, {
      weeklyQuota: 20,
      capacity: 5,
      feeAmount: fee,
    });
    const booking = await f.book(s.owner, s.home.id, court, at(day(dayN), 10));
    const charge = await f.inTx(s.c, (tx) =>
      tx.financeCharge.findFirstOrThrow({
        where: { source: 'booking', sourceId: booking.id },
      }),
    );
    return { booking, charge };
  }
  const chargeRow = (s: FinanceSetUp, id: string) =>
    f.inTx(s.c, (tx) => tx.financeCharge.findUniqueOrThrow({ where: { id } }));
  const pay = (s: FinanceSetUp, amount: string, invoiceIds: string[]) =>
    f.http('post', `/staff/units/${s.home.id}/payments`, s.accountant.token, {
      amount,
      method: 'cash',
      paidOn: day(0),
      ...(invoiceIds.length ? { invoiceIds } : {}),
    });

  it('settled at the office: stamped paid, once; a part of it is not', async () => {
    const s = await f.setUp('Charges Office Court');
    const { charge } = await charged(s);
    await pay(s, '100.00', [charge.invoiceId]).expect(201);
    expect((await chargeRow(s, charge.id)).paidAt).toBeNull();
    await pay(s, '50.00', [charge.invoiceId]).expect(201);
    const paid = await chargeRow(s, charge.id);
    expect(paid.paidAt).toBeInstanceOf(Date);
    const audits = await f.inTx(s.c, (tx) =>
      tx.auditLog.findMany({
        where: { action: 'finance_charge.paid', targetId: charge.id },
      }),
    );
    expect(audits).toHaveLength(1);
  });

  it('keeps its source, invoice and amount; is paid once and cancelled once (trigger)', async () => {
    const s = await f.setUp('Charges Trigger Court');
    const { charge } = await charged(s);
    const refused = (sql: string) =>
      expect(
        f.inTx(s.c, (tx) => tx.$executeRawUnsafe(sql, charge.id)),
      ).rejects.toThrow(/keeps its source, invoice and amount/);
    await refused(`UPDATE finance_charges SET amount = 1 WHERE id = $1::uuid`);
    // Never deleted: the app holds no DELETE on it at all.
    await expect(
      f.inTx(s.c, (tx) =>
        tx.$executeRawUnsafe(
          `DELETE FROM finance_charges WHERE id = $1::uuid`,
          charge.id,
        ),
      ),
    ).rejects.toThrow(/permission denied for table finance_charges/);
    await pay(s, '150.00', [charge.invoiceId]).expect(201);
    await refused(
      `UPDATE finance_charges SET paid_at = now() + interval '1 day' WHERE id = $1::uuid`,
    );
    await f.inTx(s.c, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE finance_charges SET cancelled_at = now(), cancel_reason = 'closure' WHERE id = $1::uuid`,
        charge.id,
      ),
    );
    await refused(
      `UPDATE finance_charges SET cancel_reason = 'booking_cancelled' WHERE id = $1::uuid`,
    );
  });

  it('the unit’s credit pays a fee as it is raised', async () => {
    const s = await f.setUp('Charges Credit Court');
    await f.giveCredit(s.c, s.home.id, '500.00');
    const { charge } = await charged(s);
    expect((await chargeRow(s, charge.id)).paidAt).toBeInstanceOf(Date);
  });

  it('online: the webhook that settles a fee stamps it, by nobody', async () => {
    const s = await f.setUp('Charges Online Court');
    const creds = await f.configureGateway(s.manager);
    const { charge } = await charged(s);
    const sessionId = (
      (
        await f
          .http(
            'post',
            `/units/${s.home.id}/payment-sessions`,
            s.owner.token,
            {},
          )
          .expect(201)
      ).body as { id: string }
    ).id;
    const intention = paymob.byReference(`jw-${sessionId}`);
    intention.paid = true;
    const cb = paymob.callback(intention, creds.hmacSecret);
    await h
      .http()
      .post(`${API}/public/payments/paymob/${s.c.tenantId}?hmac=${cb.hmac}`)
      .send(cb.body)
      .expect(200);
    expect((await chargeRow(s, charge.id)).paidAt).toBeInstanceOf(Date);
    const audit = await f.inTx(s.c, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'finance_charge.paid', targetId: charge.id },
      }),
    );
    expect(audit.actorId).toBeNull();
  });

  it.each([1, 2, 3])(
    'round %i: the resident cancels and the office takes the fee at once — one credit note, and no money lost',
    async () => {
      const s = await f.setUp('Charges Cancel Payment Race');
      const { booking, charge } = await charged(s);
      const [cancelled, paid] = await Promise.all([
        f.cancel(s.owner, booking.id),
        pay(s, '150.00', [charge.invoiceId]),
      ]);
      expect(cancelled.status).toBe(204);
      const after = await chargeRow(s, charge.id);
      expect(after.cancelReason).toBe('booking_cancelled');
      const { notes, credit } = await f.inTx(s.c, async (tx) => ({
        notes: await tx.creditNote.findMany({
          where: { invoiceId: charge.invoiceId },
        }),
        credit: await unitCredit(tx, s.home.id),
      }));
      // Paid first: the note released the payment to the unit's credit.
      // Cancelled first: the office found nothing owed and took nothing.
      // Either way, one note of the whole fee, and no money lost.
      expect(notes).toHaveLength(1);
      expect(notes[0].amount.toFixed(2)).toBe('150.00');
      if (paid.status === 201) {
        expect(after.paidAt).toBeInstanceOf(Date);
        expect(credit.toFixed(2)).toBe('150.00');
      } else {
        expect(paid.status).toBe(409);
        expect(after.paidAt).toBeNull();
        expect(credit.toFixed(2)).toBe('0.00');
      }
      const invoice = (
        await f
          .http('get', `/staff/invoices/${charge.invoiceId}`, s.manager.token)
          .expect(200)
      ).body as { outstanding: string };
      expect(invoice.outstanding).toBe('0.00');
    },
  );
});
