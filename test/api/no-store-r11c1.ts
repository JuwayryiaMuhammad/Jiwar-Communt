import type { Response } from 'supertest';
import { day } from '../setup/compound-clock';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of ADR 0069: a receipt's PDF, of a
 * payment made at A's office for an invoice of A's home (made once).
 */
export function r11c1Calls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  let paymentId: Promise<string> | null = null;
  const payment = () =>
    (paymentId ??= (async () => {
      const w = world();
      const manager = w.a.tokens.manager;
      await call(w, 'POST', '/staff/invoices', {
        token: manager,
        body: {
          target: 'unit',
          unitId: w.a.homeUnitId,
          kind: 'other',
          dueOn: day(10),
          lines: [
            { descriptionEn: 'Receipt', descriptionAr: 'إيصال', amount: '50' },
          ],
        },
      }).expect(201);
      const res = await call(
        w,
        'POST',
        `/staff/units/${w.a.homeUnitId}/payments`,
        {
          token: manager,
          body: { amount: '50', method: 'cash', paidOn: day(0) },
        },
      ).expect(201);
      return (res.body as { id: string }).id;
    })());
  return {
    'GET /payments/{id}/receipt': async () =>
      call(world(), 'GET', `/payments/${await payment()}/receipt`, {
        token: world().a.tokens.owner,
      }),
    'GET /staff/payments/{id}/receipt': async () =>
      call(world(), 'GET', `/staff/payments/${await payment()}/receipt`, {
        token: world().a.tokens.manager,
      }),
  };
}
