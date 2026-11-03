import { err } from '../api/request';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type LockdownBody } from '../setup/security-ops';

const ROUNDS = 5;

interface StaffLockdown extends LockdownBody {
  startedFrom: 'gate' | 'office';
  endedAt: string | null;
}

/**
 * ADR 0087, amending ADR 0053: the management starts a lockdown from the
 * office (`lockdown.start`, the manager only), with the same scope, reason
 * code and typed confirmation, under the same state row and with no shift;
 * the same people are told, a repeat of a live scope answers 200 with it,
 * and two starts at once make one lockdown, whoever starts them.
 */
describe('Lockdown from the office (ADR 0087)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Office Lockdown Court');
  }, 180_000);

  afterAll(() => h.close());

  const startRaw = (token: string, body: Record<string, unknown>) =>
    x.http('post', '/staff/security/lockdowns', token, {
      reasonCode: 'security_threat',
      confirmation: 'LOCKDOWN',
      ...body,
    });
  const liveOf = (gateId: string | null) =>
    x.inTx(s.c, (tx) =>
      tx.gateLockdown.findMany({ where: { endedAt: null, gateId } }),
    );

  it('the manager locks a gate down: no shift, the guards on shift and every resident told, the gate refuses visitors', async () => {
    const gate = await x.g.gate(s.c);
    const guard = await x.guardAt(s.c, gate.id);
    const res = await startRaw(s.manager.token, {
      scope: 'gate',
      gateId: gate.id,
    }).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const l = res.body as StaffLockdown;
    expect(l).toMatchObject({
      scope: 'gate',
      gate: { id: gate.id },
      startedFrom: 'office',
      startedBy: { id: s.manager.id },
    });
    const row = await x.inTx(s.c, (tx) =>
      tx.gateLockdown.findUniqueOrThrow({ where: { id: l.id } }),
    );
    expect(row).toMatchObject({ startedShiftId: null, startedFrom: 'office' });
    expect(await x.told(s.c, guard.id, l.id)).toEqual([
      { kind: 'gate_lockdown.started', params: { scope: 'gate' } },
    ]);
    expect(await x.told(s.c, s.alice.id, l.id)).toEqual([
      { kind: 'gate_lockdown.resident_notice', params: {} },
    ]);
    expect(await x.told(s.c, s.manager.id, l.id)).toEqual([]);
    // The guard sees it as any, started from the office.
    const active = (
      await x.http('get', '/gate/lockdowns/active', guard.token).expect(200)
    ).body as StaffLockdown[];
    expect(active.find((a) => a.id === l.id)).toMatchObject({
      startedFrom: 'office',
    });
    const pass = await x.passWithCode(s.alice, s.home.id);
    expect(
      err(await x.entryRaw(guard, 'visitor_pass', pass.id).expect(409)).code,
    ).toBe('LOCKDOWN_ACTIVE');
    const [audit] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate_lockdown.started',
      targetId: l.id,
    });
    expect(audit.metadata).toEqual({
      scope: 'gate',
      gateId: gate.id,
      reasonCode: 'security_threat',
      shiftId: null,
      from: 'office',
      recipients: 1,
      residents: 1,
    });
    await x.endLockdownRaw(s.manager, l.id).expect(200);
  });

  it('a repeat of a live scope answers 200 with it and tells nobody again; a guard’s live one too', async () => {
    const gate = await x.g.gate(s.c);
    const guard = await x.guardAt(s.c, gate.id);
    const first = await x.lockdown(guard, { scope: 'gate', gateId: gate.id });
    const again = await startRaw(s.manager.token, {
      scope: 'gate',
      gateId: gate.id,
    }).expect(200);
    expect((again.body as StaffLockdown).id).toBe(first.id);
    expect((again.body as StaffLockdown).startedFrom).toBe('gate');
    expect(
      (await x.told(s.c, s.manager.id, first.id)).map((n) => n.kind),
    ).toEqual(['gate_lockdown.started']);
    await x.endLockdownRaw(s.manager, first.id).expect(200);
  });

  it('the typed confirmation and the scope’s gate are required; the security supervisor may not start one', async () => {
    expect(
      err(
        await startRaw(s.manager.token, {
          scope: 'all',
          confirmation: 'lockdown',
        }).expect(400),
      ).fields,
    ).toEqual([
      {
        field: 'confirmation',
        code: 'INVALID_VALUE',
        params: { allowed: ['LOCKDOWN'] },
      },
    ]);
    expect(
      err(await startRaw(s.manager.token, { scope: 'gate' }).expect(400))
        .fields,
    ).toEqual([{ field: 'gateId', code: 'FIELD_REQUIRED' }]);
    const supervisor = await x.supervisor(s.c);
    await startRaw(supervisor.token, { scope: 'all' }).expect(403);
  });

  it('R1: the manager and a guard lock every gate at once: one lockdown, told once (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const gate = await x.g.gate(s.c);
      const guard = await x.guardAt(s.c, gate.id);
      const [a, b] = await Promise.all([
        startRaw(s.manager.token, { scope: 'all' }),
        x.lockdownRaw(guard, { scope: 'all' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      const id = (a.body as StaffLockdown).id;
      expect((b.body as StaffLockdown).id).toBe(id);
      expect(await liveOf(null)).toHaveLength(1);
      expect((await x.told(s.c, s.alice.id, id)).map((n) => n.kind)).toEqual([
        'gate_lockdown.resident_notice',
      ]);
      await x.endLockdownRaw(s.manager, id).expect(200);
    }
  });

  it('R2: two office starts of one gate at once: one lockdown (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const gate = await x.g.gate(s.c);
      const body = { scope: 'gate', gateId: gate.id };
      const [a, b] = await Promise.all([
        startRaw(s.manager.token, body),
        startRaw(s.manager.token, body),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect((a.body as StaffLockdown).id).toBe((b.body as StaffLockdown).id);
      expect(await liveOf(gate.id)).toHaveLength(1);
      await x
        .endLockdownRaw(s.manager, (a.body as StaffLockdown).id)
        .expect(200);
    }
  });
});
