import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { uniqueSuffix } from '../setup/fixtures';
import { facilitiesHelpers } from '../setup/facilities';
import { day, vehicleHelpers, type Who } from '../setup/vehicles';

interface FineView {
  id: string;
  status: string;
  payable: 'online' | 'office';
  charge: { invoiceId: string; status: string } | null;
}

/**
 * ADR 0070: a vehicle fine issued now is owed through a `fine` invoice of
 * the unit's, due in two weeks and payable online as any invoice; paid
 * through finance, the fine is paid. The office still takes it on the
 * fine's route — its cash a payment of that invoice in finance, which the
 * fine's record points at — and reversing it there owes the invoice again.
 * An accepted appeal, the staff's cancel or the board's overturn credit the
 * charge off; a payment and an acceptance at once leave one credit note and
 * no money lost.
 */
describe('Fines through finance (ADR 0070)', () => {
  let h: HttpHarness;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof vehicleHelpers>['setUp']>>;
  let billing: Who;
  let accountant: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    v = vehicleHelpers(h);
    s = await v.setUp();
    billing = await v.staff(s.c, ['fines.billing']);
    accountant = await facilitiesHelpers(h).accountant(s.c);
  }, 120_000);

  afterAll(() => h.close());

  const view = async (id: string) =>
    (
      await v
        .http('get', `/staff/vehicle-fines/${id}`, billing.token)
        .expect(200)
    ).body as FineView;
  const invoice = async (id: string) =>
    (await v.http('get', `/staff/invoices/${id}`, s.manager.token).expect(200))
      .body as { kind: string; total: string; status: string; dueOn: string };
  const financePay = (
    invoiceId: string,
    amount = '500.00',
    unitId: string = s.home.id,
  ) =>
    v.http('post', `/staff/units/${unitId}/payments`, accountant.token, {
      amount,
      method: 'cash',
      paidOn: day(0),
      invoiceIds: [invoiceId],
    });
  const officePay = (fineId: string) =>
    v.http('post', `/staff/vehicle-fines/${fineId}/payments`, billing.token, {
      amount: '500',
      receiptNumber: `RC-${uniqueSuffix()}`,
      paidOn: day(0),
    });
  const appeal = (fineId: string, as: Who = s.alice) =>
    v
      .http('post', `/vehicle-fines/${fineId}/appeal`, as.token, {
        reason: 'Review',
      })
      .expect(200);
  const decide = (fineId: string, decision: 'upheld' | 'cancelled') =>
    v.http(
      'post',
      `/staff/vehicle-fines/${fineId}/decide-appeal`,
      s.manager.token,
      { decision },
    );
  const chargeOf = (fineId: string) =>
    v.inTx(s.c, (tx) =>
      tx.financeCharge.findFirstOrThrow({
        where: { source: 'vehicle_fine', sourceId: fineId },
      }),
    );

  it('issued: owed through a `fine` invoice due in two weeks, payable online', async () => {
    const fine = await v.fine(s.manager, s.home.code, { amount: '500' });
    const f = await view(fine.id);
    expect(f).toMatchObject({
      payable: 'online',
      charge: { invoiceId: expect.any(String) as string, status: 'open' },
    });
    expect(await invoice(f.charge!.invoiceId)).toMatchObject({
      kind: 'fine',
      total: '500.00',
      dueOn: day(14),
    });
  });

  it('its invoice paid in finance: the fine is paid', async () => {
    const fine = await v.fine(s.manager, s.home.code, { amount: '500' });
    const { charge } = await view(fine.id);
    await financePay(charge!.invoiceId).expect(201);
    expect(await view(fine.id)).toMatchObject({
      status: 'paid',
      charge: { status: 'paid' },
    });
  });

  it('taken at the office on the fine’s route: a payment of its invoice in finance; reversed there, owed again', async () => {
    const fine = await v.fine(s.manager, s.home.code, { amount: '500' });
    const { charge } = await view(fine.id);
    const paid = (await officePay(fine.id).expect(201)).body as { id: string };
    const record = await v.inTx(s.c, (tx) =>
      tx.vehicleFinePayment.findUniqueOrThrow({ where: { id: paid.id } }),
    );
    expect(record.financePaymentId).toEqual(expect.any(String));
    expect(await invoice(charge!.invoiceId)).toMatchObject({ status: 'paid' });
    expect((await view(fine.id)).status).toBe('paid');
    await v
      .http(
        'post',
        `/staff/vehicle-fine-payments/${paid.id}/reverse`,
        billing.token,
        { reasonCode: 'entered_in_error' },
      )
      .expect(201);
    expect(await view(fine.id)).toMatchObject({
      status: 'unpaid',
      charge: { status: 'open' },
    });
    expect((await invoice(charge!.invoiceId)).status).not.toBe('paid');
  });

  it('an office payment reversed in finance owes the fine again', async () => {
    const fine = await v.fine(s.manager, s.home.code, { amount: '500' });
    const { charge } = await view(fine.id);
    const payment = (await financePay(charge!.invoiceId).expect(201)).body as {
      id: string;
    };
    await v
      .http('post', `/staff/payments/${payment.id}/reverse`, accountant.token, {
        reasonCode: 'entered_in_error',
      })
      .expect(201);
    expect(await view(fine.id)).toMatchObject({
      status: 'unpaid',
      charge: { status: 'open' },
    });
  });

  it('an accepted appeal and the staff’s cancel credit the charge off', async () => {
    const appealed = await v.fine(s.manager, s.home.code, { amount: '500' });
    await appeal(appealed.id);
    await decide(appealed.id, 'cancelled').expect(200);
    expect(await chargeOf(appealed.id)).toMatchObject({
      cancelReason: 'appeal_accepted',
    });
    const cancelled = await v.fine(s.manager, s.home.code, { amount: '500' });
    await v
      .http(
        'post',
        `/staff/vehicle-fines/${cancelled.id}/cancel`,
        s.manager.token,
        { reasonCode: 'issued_in_error' },
      )
      .expect(200);
    expect(await chargeOf(cancelled.id)).toMatchObject({
      cancelReason: 'fine_cancelled',
    });
  });

  it('paid online while under appeal: upheld, the fine is paid', async () => {
    const fine = await v.fine(s.manager, s.home.code, { amount: '500' });
    const { charge } = await view(fine.id);
    await appeal(fine.id);
    await financePay(charge!.invoiceId).expect(201);
    expect((await view(fine.id)).status).toBe('under_appeal');
    await decide(fine.id, 'upheld').expect(200);
    expect((await view(fine.id)).status).toBe('paid');
  });

  it.each([1, 2, 3])(
    'round %i: a payment of its invoice and an accepted appeal at once — cancelled, one credit note, no money lost',
    async () => {
      // A home of its own each round: a round's credit never pays the next.
      const home = await v.unit(s.c, 'A');
      const owner = await v.owner(s.c, home.id);
      const fine = await v.fine(s.manager, home.code, { amount: '500' });
      const { charge } = await view(fine.id);
      await appeal(fine.id, owner);
      const [paid, decided] = await Promise.all([
        financePay(charge!.invoiceId, '500.00', home.id),
        decide(fine.id, 'cancelled'),
      ]);
      expect(decided.status).toBe(200);
      expect((await view(fine.id)).status).toBe('cancelled');
      const notes = await v.inTx(s.c, (tx) =>
        tx.creditNote.findMany({ where: { invoiceId: charge!.invoiceId } }),
      );
      expect(notes).toHaveLength(1);
      // Paid first: the note released it to the unit's credit. Decided
      // first: the office found nothing owed.
      if (paid.status === 201)
        expect(
          (
            await v.inTx(s.c, (tx) =>
              tx.financeAllocationRelease.aggregate({
                where: { creditNoteId: notes[0].id },
                _sum: { amount: true },
              }),
            )
          )._sum.amount?.toFixed(2),
        ).toBe('500.00');
      else expect(paid.status).toBe(409);
    },
  );
});
