import { dbDate, today } from '../setup/compound-clock';
import { gateCompletionHelpers } from '../setup/gate-completion';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const ROUNDS = 5;

/**
 * ADR 0056, two guards counting resident vehicles at one gate at once: the
 * day's count is one upsert, so both are counted, never one lost.
 */
describe('Gate — resident vehicles counted, concurrently (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Vehicle Count Race Court');
  }, 180_000);

  afterAll(() => h.close());

  it('two counts at once: both counted', async () => {
    const other = await g.guardAt(s.c, s.guard.gateId);
    const vehicleId = (await g.register(s.alice, s.home.id)).id;
    const inToday = () =>
      g.inTx(
        s.c,
        async (tx) =>
          (
            await tx.gateVehicleCount.findFirst({
              where: {
                gateId: s.guard.gateId,
                direction: 'in',
                day: dbDate(today()),
              },
            })
          )?.count ?? 0,
      );
    for (let round = 0; round < ROUNDS; round++) {
      const before = await inToday();
      const results = await Promise.all(
        [s.guard, other].map((who) =>
          g.http('post', '/gate/vehicle-passages', who.token, {
            vehicleId,
            direction: 'in',
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      expect(await inToday()).toBe(before + 2);
    }
  });
});
