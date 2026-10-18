import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type BlocklistBody } from '../setup/security-ops';

const ROUNDS = 5;

/**
 * ADR 0053, the blocklist's races. A ban is written under the compound's
 * blocklist lock taken exclusively; every check at the gate takes it shared
 * and holds it to its commit. So a ban added while a visitor comes in
 * either committed first and refuses them, or waits for their entry: an
 * entry recorded always committed before the ban was made.
 */
describe('Blocklist — races', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Blocklist Race Court');
  }, 120_000);

  afterAll(() => h.close());

  it('R4: a ban added while the visitor comes in: the entry committed first, or it is refused (×5)', async () => {
    const guard = await x.guardOnDuty(s.c);
    for (let round = 0; round < ROUNDS; round++) {
      const plate = `RC ${round}${Date.now() % 1000}`;
      const pass = await x.passWithCode(s.alice, s.home.id, {
        vehiclePlate: plate,
      });
      const [entry, banned] = await Promise.all([
        x.entryRaw(guard, 'visitor_pass', pass.id),
        x.blockRaw(s.manager, { subject: 'plate', plate }),
      ]);
      expect(banned.status).toBe(201);
      const ban = await x.inTx(s.c, (tx) =>
        tx.blocklistEntry.findUniqueOrThrow({
          where: { id: (banned.body as BlocklistBody).id },
        }),
      );
      if (entry.status === 201) {
        const row = await x.inTx(s.c, (tx) =>
          tx.gateEntry.findUniqueOrThrow({
            where: { id: (entry.body as { id: string }).id },
          }),
        );
        expect(row.recordedAt.getTime()).toBeLessThan(ban.createdAt.getTime());
      } else {
        expect(entry.status).toBe(409);
        expect(entry.body).toMatchObject({ code: 'ENTRY_BLOCKED' });
        const refused = await x.inTx(s.c, (tx) =>
          tx.blocklistMatch.count({
            where: { entryId: ban.id, source: 'entry', outcome: 'refused' },
          }),
        );
        expect(refused).toBe(1);
      }
    }
  });

  it('R5: a ban added while the guard verifies the pass: valid before it, entry_blocked after it, never in between (×5)', async () => {
    const guard = await x.guardOnDuty(s.c);
    for (let round = 0; round < ROUNDS; round++) {
      const plate = `RV ${round}${Date.now() % 1000}`;
      const pass = await x.passWithCode(s.alice, s.home.id, {
        vehiclePlate: plate,
      });
      const [verified, banned] = await Promise.all([
        x.verifyRaw(guard, { code: pass.code }),
        x.blockRaw(s.manager, { subject: 'plate', plate }),
      ]);
      expect([verified.status, banned.status]).toEqual([200, 201]);
      const v = verified.body as {
        result: string;
        reason: string | null;
        display: { blocklist: { kind: string } | null };
      };
      const banId = (banned.body as BlocklistBody).id;
      const noted = await x.inTx(s.c, (tx) =>
        tx.blocklistMatch.count({
          where: { entryId: banId, source: 'verify' },
        }),
      );
      if (v.result === 'valid') {
        expect(v.display.blocklist).toBeNull();
        expect(noted).toBe(0);
      } else {
        expect(v).toMatchObject({
          reason: 'entry_blocked',
          display: { blocklist: { kind: 'ban' } },
        });
        expect(noted).toBe(1);
      }
    }
  });
});
