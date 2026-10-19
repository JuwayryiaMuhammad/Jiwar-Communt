import { gateCompletionHelpers } from '../setup/gate-completion';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const ROUNDS = 5;

/**
 * ADR 0056, the races of a service vehicle's plate:
 * - two guards record the same plate coming in at once: the entry takes
 *   the plate's lock, so one comes in and the other is told it is inside;
 * - an entry while the plate is banned: the ban's write and the entry's
 *   check share the blocklist's lock, so the entry either came in before
 *   the ban (and the ban finds it inside) or is refused, never in after it.
 */
describe('Gate — a service vehicle’s plate, concurrently (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Service Vehicle Race Court');
  }, 180_000);

  afterAll(() => h.close());

  it('two entries of one plate at once: one comes in', async () => {
    const other = await g.guardAt(s.c, s.guard.gateId);
    for (let round = 0; round < ROUNDS; round++) {
      const plate = `ر س ${7000 + round}`;
      const [one, two] = await Promise.all([
        g.serviceInRaw(s.guard, { plate }),
        g.serviceInRaw(other, { plate: plate.replace(/\s/g, '') }),
      ]);
      expect([one.status, two.status].sort()).toEqual([201, 409]);
      const refused = one.status === 409 ? one : two;
      expect((refused.body as { code: string }).code).toBe(
        'SERVICE_VEHICLE_INSIDE',
      );
      expect(
        await g.inTx(s.c, (tx) =>
          tx.serviceVehicleVisit.count({
            where: { plateKey: plate.replace(/\s/g, ''), exitedAt: null },
          }),
        ),
      ).toBe(1);
    }
  });

  it('an entry while the plate is banned: in before the ban, or refused', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const plate = `ب ن ${8000 + round}`;
      const [entered, banned] = await Promise.all([
        g.serviceInRaw(s.guard, { plate }),
        g.blockRaw(s.manager, { subject: 'plate', plate }),
      ]);
      expect(banned.status).toBe(201);
      const visits = await g.inTx(s.c, (tx) =>
        tx.serviceVehicleVisit.count({
          where: { plateKey: plate.replace(/\s/g, '') },
        }),
      );
      if (entered.status === 201) expect(visits).toBe(1);
      else {
        expect((entered.body as { code: string }).code).toBe('ENTRY_BLOCKED');
        expect(visits).toBe(0);
      }
    }
  });
});
