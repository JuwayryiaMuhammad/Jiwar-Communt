import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

const ROUNDS = 5;

/**
 * ADR 0053, the violations' race: an appeal and a payment of the same
 * violation at once. Both take the violation's row FOR UPDATE: exactly one
 * wins, and the row agrees.
 */
describe('Violations — races', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let accountant: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Violation Race Court');
    accountant = await x.staff(s.c, ['fines.billing']);
  }, 120_000);

  afterAll(() => h.close());

  it('R6: an appeal and a payment at once: one wins (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const v = (
        await x
          .http('post', '/staff/violations', s.manager.token, {
            kind: 'noise',
            unitCode: s.home.code,
            amount: '120',
            occurredOn: day(0),
          })
          .expect(201)
      ).body as { id: string };
      const [appeal, payment] = await Promise.all([
        x.http('post', `/violations/${v.id}/appeal`, s.alice.token, {
          reason: 'Race appeal',
        }),
        x.http('post', `/staff/violations/${v.id}/payments`, accountant.token, {
          amount: '120',
          receiptNumber: `RACE-${round}-${Date.now() % 100000}`,
          paidOn: day(0),
        }),
      ]);
      const row = await x.inTx(s.c, (tx) =>
        tx.unitViolation.findUniqueOrThrow({ where: { id: v.id } }),
      );
      const payments = await x.inTx(s.c, (tx) =>
        tx.unitViolationPayment.count({ where: { violationId: v.id } }),
      );
      if (appeal.status === 200) {
        expect(payment.status).toBe(409);
        expect(payment.body).toMatchObject({ code: 'VIOLATION_UNDER_APPEAL' });
        expect(row.status).toBe('under_appeal');
        expect(payments).toBe(0);
      } else {
        expect(payment.status).toBe(201);
        expect(appeal.status).toBe(409);
        expect(appeal.body).toMatchObject({ code: 'VIOLATION_APPEAL_CLOSED' });
        expect(row.status).toBe('paid');
        expect(row.appealedAt).toBeNull();
        expect(payments).toBe(1);
      }
    }
  });
});
