import { day } from '../setup/facilities';
import { financeHelpers } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * A refund of a unit's credit while the same credit is being used (ADR
 * 0048): an issue pours it into the unit's new invoice. Both take the unit's
 * finance lock, and the refund decides on the credit it finds under it.
 * Whoever wins, money is paid back or applied once, never both, and the
 * credit never goes below zero.
 */
describe('Finance — refund vs credit use (races)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  it.each([1, 2, 3])(
    'round %i: a refund of all the credit and an issue that uses it, at once',
    async () => {
      const s = await f.setUp('Refund Credit Race');
      await f.giveCredit(s.c, s.home.id, '500');
      await f.stepUp(s.manager.token);
      const [refund, issue] = await Promise.all([
        f.http('post', `/staff/units/${s.home.id}/refunds`, s.manager.token, {
          amount: '500',
          channel: 'cash',
          refundedOn: day(0),
        }),
        f.http('post', '/staff/invoices', s.accountant.token, {
          target: 'unit',
          unitId: s.home.id,
          kind: 'other',
          dueOn: day(10),
          lines: [
            { descriptionEn: 'Fee', descriptionAr: 'رسم', amount: '300' },
          ],
        }),
      ]);
      expect(issue.status).toBe(201);
      const statement = (
        await f
          .http('get', `/staff/units/${s.home.id}/statement`, s.manager.token)
          .expect(200)
      ).body as { outstanding: string; credit: string };
      if (refund.status === 201) {
        // The refund won: the invoice found no credit.
        expect(statement).toMatchObject({
          outstanding: '300.00',
          credit: '0.00',
        });
      } else {
        // The issue won: what is left is less than the refund asked.
        expect(refund.body).toMatchObject({
          code: 'REFUND_EXCEEDS_CREDIT',
          params: { credit: '200.00' },
        });
        expect(statement).toMatchObject({
          outstanding: '0.00',
          credit: '200.00',
        });
      }
    },
  );
});
