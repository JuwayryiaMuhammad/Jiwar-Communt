import { gateCompletionHelpers } from '../setup/gate-completion';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const ROUNDS = 5;

/**
 * ADR 0056, two overstay sweeps at once (two app instances): the alert's
 * key is the visitor's `in` entry, so the second insert waits for the
 * first and finds it there: one alert, one notice to the gate and one to
 * the host, whichever sweep wins.
 */
describe('Gate — visit overstay, concurrently (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Overstay Race Court');
  }, 180_000);

  afterAll(() => h.close());

  it('two sweeps at once: one alert, told once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const p = await g.pass(s.alice, s.home.id, { expectedMinutes: 15 });
      const entry = await g.enter(s.guard, 'visitor_pass', p.id);
      await g.backdate(entry, 20);
      await Promise.all([g.sweepOverstay(), g.sweepOverstay()]);
      expect(
        await g.inTx(s.c, (tx) =>
          tx.visitOverstayAlert.count({ where: { entryId: entry } }),
        ),
      ).toBe(1);
      expect((await g.told(s.c, s.guard.id, entry)).length).toBe(1);
      expect((await g.told(s.c, s.alice.id, entry)).length).toBe(1);
    }
    // Ten sweeps, each a transaction per compound in the shared test
    // database (160 and more late in a long run): longer than the default.
  }, 120_000);
});
