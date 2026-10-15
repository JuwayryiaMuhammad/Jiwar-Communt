import { day } from '../setup/facilities';
import { financeHelpers } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * A credit note that releases paid money, a refund of the unit's credit and
 * an issue that uses credit, all at once on one unit (ADR 0048). Each takes
 * the unit's finance lock and decides on what it finds under it. Whatever
 * the order, the credit never goes below zero, the new invoice is paid from
 * the released money, and a refund either fits or is refused with the
 * credit it found.
 */
describe('Finance — release vs refund vs credit use (races)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  it.each([1, 2, 3])(
    'round %i: release, refund and issue at once',
    async () => {
      const s = await f.setUp('Release Refund Race');
      const { invoiceId } = await f.issue(s.manager, s.home.id);
      await f
        .http(
          'post',
          `/staff/units/${s.home.id}/payments`,
          s.accountant.token,
          {
            amount: '1000',
            method: 'cash',
            paidOn: day(0),
            invoiceIds: [invoiceId],
          },
        )
        .expect(201);
      await f.stepUp(s.manager.token);
      const [release, refund, issue] = await Promise.all([
        f.http(
          'post',
          `/staff/invoices/${invoiceId}/credit-notes`,
          s.accountant.token,
          { amount: '1000', reasonCode: 'billing_error' },
        ),
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
      expect(release.status).toBe(201);
      expect(issue.status).toBe(201);
      const statement = (
        await f
          .http('get', `/staff/units/${s.home.id}/statement`, s.manager.token)
          .expect(200)
      ).body as { outstanding: string; credit: string };
      if (refund.status === 201) {
        expect(statement).toMatchObject({
          outstanding: '0.00',
          credit: '200.00',
        });
      } else {
        // The refund came before the release: there was no credit.
        expect(refund.body).toMatchObject({
          code: 'REFUND_EXCEEDS_CREDIT',
          params: { credit: '0.00' },
        });
        expect(statement).toMatchObject({
          outstanding: '0.00',
          credit: '700.00',
        });
      }
    },
  );
});
