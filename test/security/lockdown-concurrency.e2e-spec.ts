import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type LockdownBody } from '../setup/security-ops';

const ROUNDS = 5;

/**
 * ADR 0053, the lockdown's races. Every start and end takes the compound's
 * lockdown row FOR UPDATE; every verify and entry in takes it FOR SHARE
 * before its subject. So:
 * - two starts of one scope make one lockdown;
 * - an entry and a start meet in one order: the entry committed before
 *   the lockdown started, or it is refused;
 * - an end and a start of the same scope meet in one order, and at most one
 *   lockdown of a scope is ever live.
 */
describe('Lockdown — races', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Lockdown Race Court');
  }, 120_000);

  afterAll(() => h.close());

  const liveOf = (gateId: string | null) =>
    x.inTx(s.c, (tx) =>
      tx.gateLockdown.findMany({ where: { endedAt: null, gateId } }),
    );

  it('R1: two guards lock one gate at once: one lockdown, one push each (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const gate = await x.g.gate(s.c);
      const a = await x.guardAt(s.c, gate.id);
      const b = await x.guardAt(s.c, gate.id);
      const body = { scope: 'gate', gateId: gate.id };
      const [ra, rb] = await Promise.all([
        x.lockdownRaw(a, body),
        x.lockdownRaw(b, body),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([200, 201]);
      const id = (ra.body as LockdownBody).id;
      expect((rb.body as LockdownBody).id).toBe(id);
      expect(await liveOf(gate.id)).toHaveLength(1);
      expect((await x.told(s.c, s.manager.id, id)).map((n) => n.kind)).toEqual([
        'gate_lockdown.started',
      ]);
      await x.endLockdownRaw(s.manager, id).expect(200);
    }
  });

  it('R2: a visitor’s entry and a lockdown at once: the entry was recorded before the lockdown started, or refused; verify likewise (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const gate = await x.g.gate(s.c);
      const guard = await x.guardAt(s.c, gate.id);
      const starter = await x.guardAt(s.c, gate.id);
      const pass = await x.passWithCode(s.alice, s.home.id);
      const [entry, verified, started] = await Promise.all([
        x.entryRaw(guard, 'visitor_pass', pass.id),
        x.verifyRaw(guard, { code: pass.code }),
        x.lockdownRaw(starter, { scope: 'gate', gateId: gate.id }),
      ]);
      expect(started.status).toBe(201);
      const lockdown = (started.body as LockdownBody).id;
      const startedAt = (
        await x.inTx(s.c, (tx) =>
          tx.gateLockdown.findUniqueOrThrow({ where: { id: lockdown } }),
        )
      ).startedAt;
      if (entry.status === 201) {
        const row = await x.inTx(s.c, (tx) =>
          tx.gateEntry.findUniqueOrThrow({
            where: { id: (entry.body as { id: string }).id },
          }),
        );
        expect(row.recordedAt.getTime()).toBeLessThan(startedAt.getTime());
      } else {
        expect(entry.status).toBe(409);
        expect(entry.body).toMatchObject({ code: 'LOCKDOWN_ACTIVE' });
      }
      expect(verified.status).toBe(200);
      const v = verified.body as { result: string; reason: string | null };
      expect(v.result === 'valid' || v.reason === 'lockdown_active').toBe(true);
      await x.endLockdownRaw(s.manager, lockdown).expect(200);
    }
  });

  it('R3: an end and a start of the same scope at once: one order, never two live (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const gate = await x.g.gate(s.c);
      const guard = await x.guardAt(s.c, gate.id);
      const first = await x.lockdown(guard, { scope: 'gate', gateId: gate.id });
      const [ended, started] = await Promise.all([
        x.endLockdownRaw(s.manager, first.id),
        x.lockdownRaw(guard, { scope: 'gate', gateId: gate.id }),
      ]);
      expect(ended.status).toBe(200);
      const live = await liveOf(gate.id);
      expect(live.length).toBeLessThanOrEqual(1);
      if (started.status === 201) {
        // The end came first: the new lockdown holds.
        expect(live.map((l) => l.id)).toEqual([
          (started.body as LockdownBody).id,
        ]);
        await x
          .endLockdownRaw(s.manager, (started.body as LockdownBody).id)
          .expect(200);
      } else {
        // The start came first: it answered with the one the end then ended.
        expect(started.status).toBe(200);
        expect((started.body as LockdownBody).id).toBe(first.id);
        expect(live).toEqual([]);
      }
    }
  });
});
