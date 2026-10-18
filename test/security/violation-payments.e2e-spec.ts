import { auditReaders } from '../setup/audit';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

interface StaffViolation {
  id: string;
  status: string;
  amount: string | null;
  payments: {
    id: string;
    kind: string;
    amount: string | null;
    receiptNumber: string | null;
    reversesId: string | null;
    recordedBy: { id: string };
  }[];
}

/**
 * ADR 0053: a violation is paid at the office (`fines.billing`) exactly as
 * a fine (ADR 0045): the whole amount, a receipt once among the compound's
 * violation payments, the local day; append-only, reversed once; a warning
 * is never paid; under appeal, it waits for the decision.
 */
describe('Violations — paid at the office', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let accountant: Who;
  let n = 0;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Violation Payments Court');
    accountant = await x.staff(s.c, ['fines.billing']);
  }, 120_000);

  afterAll(() => h.close());

  const issue = async (amount?: string) =>
    (
      await x
        .http('post', '/staff/violations', s.manager.token, {
          kind: 'pets',
          unitCode: s.home.code,
          occurredOn: day(0),
          ...(amount ? { amount } : {}),
        })
        .expect(201)
    ).body as StaffViolation;
  const pay = (as: Who, id: string, body: Record<string, unknown> = {}) =>
    x.http('post', `/staff/violations/${id}/payments`, as.token, {
      amount: '300',
      receiptNumber: `VR-${++n}-${Date.now() % 100000}`,
      paidOn: day(0),
      ...body,
    });

  it('paid in full with a receipt; reversed once: open again; audited by codes and amounts', async () => {
    const v = await issue('300');
    const paid = (await pay(accountant, v.id).expect(201))
      .body as StaffViolation;
    expect(paid).toMatchObject({ status: 'paid' });
    expect(paid.payments).toEqual([
      expect.objectContaining({
        kind: 'payment',
        amount: '300.00',
        recordedBy: {
          id: accountant.id,
          fullName: expect.any(String) as string,
        },
      }),
    ]);
    const paymentId = paid.payments[0].id;
    await pay(accountant, v.id)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'VIOLATION_NOT_PAYABLE',
          params: { status: 'paid' },
        }),
      );
    const reversed = (
      await x
        .http(
          'post',
          `/staff/violation-payments/${paymentId}/reverse`,
          accountant.token,
          {
            reasonCode: 'entered_in_error',
          },
        )
        .expect(201)
    ).body as StaffViolation;
    expect(reversed.status).toBe('open');
    expect(reversed.payments.map((p) => [p.kind, p.reversesId])).toEqual([
      ['payment', null],
      ['reversal', paymentId],
    ]);
    await x
      .http(
        'post',
        `/staff/violation-payments/${paymentId}/reverse`,
        accountant.token,
        {
          reasonCode: 'other',
        },
      )
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'VIOLATION_PAYMENT_ALREADY_REVERSED',
        }),
      );
    const [recorded] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'violation.payment_recorded',
      targetId: paymentId,
    });
    expect(recorded).toMatchObject({
      actorId: accountant.id,
      targetType: 'unit_violation_payment',
    });
    expect(recorded.metadata).toMatchObject({
      violationId: v.id,
      unitId: s.home.id,
      amount: '300.00',
      currency: 'EGP',
      paidOn: day(0),
    });
  });

  it('a warning is never paid; the whole amount only; a receipt once; not ahead, not before the day', async () => {
    const warning = await issue();
    await pay(accountant, warning.id)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'VIOLATION_NOT_PAYABLE',
          params: { status: 'warning' },
        }),
      );
    const v = await issue('300');
    const fields = async (body: Record<string, unknown>) =>
      (
        (await pay(accountant, v.id, body).expect(400)).body as {
          fields: { field: string; code: string }[];
        }
      ).fields.map((f) => [f.field, f.code]);
    expect(await fields({ amount: '299' })).toEqual([
      ['amount', 'AMOUNT_MISMATCH'],
    ]);
    expect(await fields({ paidOn: day(1) })).toEqual([
      ['paidOn', 'PAID_ON_OUT_OF_RANGE'],
    ]);
    const receipt = `VR-ONCE-${Date.now() % 100000}`;
    await pay(accountant, v.id, { receiptNumber: receipt }).expect(201);
    const other = await issue('300');
    await pay(accountant, other.id, { receiptNumber: receipt })
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'DUPLICATE_RESOURCE',
          fields: [{ field: 'receiptNumber', code: 'DUPLICATE_VALUE' }],
        }),
      );
  });

  it('under appeal it waits; the guard, the residents and the violations’ keepers never take payments', async () => {
    const v = await issue('300');
    await x
      .http('post', `/violations/${v.id}/appeal`, s.alice.token, {
        reason: 'Not our cat',
      })
      .expect(200);
    await pay(accountant, v.id)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'VIOLATION_UNDER_APPEAL' }),
      );
    const guard = await x.guardOnDuty(s.c);
    const keeper = await x.supervisor(s.c);
    for (const who of [guard, s.alice, keeper])
      await pay(who, v.id).expect(403);
  });
});
