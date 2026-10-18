import { newId } from '../../src/core/common/uuid';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  securityOpsHelpers,
  type LockdownBody,
  type Who,
} from '../setup/security-ops';

interface StaffLockdown extends LockdownBody {
  startedBy: { id: string; fullName?: string | null };
  endedAt: string | null;
  endedBy: { id: string; fullName?: string | null } | null;
  endReason: string | null;
  endNote: string | null;
  overrides: { id: string; reasonCode: string; gate: { id: string } }[];
}

/**
 * ADR 0053: a guard on shift locks one gate or all down, at once, with a
 * reason code and the typed confirmation. While it is live every entry in
 * but a resident's is refused (LOCKDOWN_ACTIVE): verify, entries, gate
 * requests, material entries, and the plate lookup says so. Exits are
 * always recorded. A guard lets an emergency vehicle through a locked gate
 * with its code. Only the management ends it. Guards on shift and the
 * management get a critical push; residents a generic one, once.
 */
describe('Lockdown — the gates locked down', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
  }, 120_000);

  afterAll(() => h.close());

  /** A compound with two gates, a guard at each, and a resident's home. */
  async function scene(name: string) {
    const s = await x.setUp(name);
    const north = await x.g.gate(s.c);
    const south = await x.g.gate(s.c);
    const atNorth = await x.guardAt(s.c, north.id);
    const atSouth = await x.guardAt(s.c, south.id);
    return { ...s, north, south, atNorth, atSouth };
  }
  const kinds = async (c: Parameters<typeof x.told>[0], who: Who, id: string) =>
    (await x.told(c, who.id, id)).map((n) => n.kind);

  it('a guard locks one gate: the guards on shift and the management told (critical), every resident a generic notice; audited by codes and counts', async () => {
    const s = await scene('Lockdown Start Court');
    const res = await x
      .lockdownRaw(s.atNorth, { scope: 'gate', gateId: s.north.id })
      .expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const l = res.body as LockdownBody;
    expect(l).toMatchObject({
      scope: 'gate',
      gate: { id: s.north.id, name: s.north.name },
      reasonCode: 'security_threat',
      startedBy: { id: s.atNorth.id },
    });
    expect(await x.told(s.c, s.atSouth.id, l.id)).toEqual([
      { kind: 'gate_lockdown.started', params: { scope: 'gate' } },
    ]);
    expect(await kinds(s.c, s.manager, l.id)).toEqual([
      'gate_lockdown.started',
    ]);
    expect(await x.told(s.c, s.alice.id, l.id)).toEqual([
      { kind: 'gate_lockdown.resident_notice', params: {} },
    ]);
    expect(await kinds(s.c, s.atNorth, l.id)).toEqual([]);
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate_lockdown.started',
      targetId: l.id,
    });
    expect(row).toMatchObject({
      actorId: s.atNorth.id,
      targetType: 'gate_lockdown',
    });
    expect(row.metadata).toEqual({
      scope: 'gate',
      gateId: s.north.id,
      reasonCode: 'security_threat',
      shiftId: s.atNorth.shiftId,
      recipients: 2,
      residents: 1,
    });
  });

  it('one live per scope: a repeat answers 200 with it and tells nobody again; "all" is its own, and residents are told once', async () => {
    const s = await scene('Lockdown Repeat Court');
    const first = await x.lockdown(s.atNorth, {
      scope: 'gate',
      gateId: s.north.id,
    });
    const again = await x
      .lockdownRaw(s.atSouth, { scope: 'gate', gateId: s.north.id })
      .expect(200);
    expect((again.body as LockdownBody).id).toBe(first.id);
    expect(await kinds(s.c, s.manager, first.id)).toEqual([
      'gate_lockdown.started',
    ]);
    const all = await x.lockdown(s.atSouth, { reasonCode: 'intruder' });
    expect(all).toMatchObject({ scope: 'all', gate: null });
    expect(await kinds(s.c, s.alice, all.id)).toEqual([]);
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate_lockdown.started',
      targetId: all.id,
    });
    expect(row.metadata).toMatchObject({ scope: 'all', residents: 0 });
    const live = (
      await x.http('get', '/gate/lockdowns/active', s.atSouth.token).expect(200)
    ).body as LockdownBody[];
    expect(live.map((r) => r.id)).toEqual([first.id, all.id]);
  });

  it('refuses what is not a lockdown: no confirmation, a scope without its gate, a gate with "all", an unknown code or gate, off shift, without gate.operate', async () => {
    const s = await scene('Lockdown Refused Court');
    const fields = async (body: Record<string, unknown>) =>
      (
        (await x.lockdownRaw(s.atNorth, body).expect(400)).body as {
          fields: { field: string; code: string }[];
        }
      ).fields.map((f) => [f.field, f.code]);
    expect(await fields({ confirmation: 'yes' })).toEqual([
      ['confirmation', 'INVALID_VALUE'],
    ]);
    expect(await fields({ scope: 'gate' })).toEqual([
      ['gateId', 'FIELD_REQUIRED'],
    ]);
    expect(await fields({ gateId: s.north.id })).toEqual([
      ['gateId', 'FIELD_NOT_ALLOWED'],
    ]);
    expect(await fields({ reasonCode: 'boredom' })).toEqual([
      ['reasonCode', 'INVALID_REASON_CODE'],
    ]);
    await x
      .lockdownRaw(s.atNorth, { scope: 'gate', gateId: newId() })
      .expect(404)
      .expect((r) => expect(r.body).toMatchObject({ code: 'GATE_NOT_FOUND' }));
    const offShift = await x.guard(s.c);
    await x
      .lockdownRaw(offShift)
      .expect(403)
      .expect((r) => expect(r.body).toMatchObject({ code: 'NO_OPEN_SHIFT' }));
    for (const who of [s.manager, s.alice, await x.supervisor(s.c)])
      await x.lockdownRaw(who).expect(403);
  });

  it('a guard in a zone locks every gate down', async () => {
    const s = await scene('Lockdown Zone Court');
    const zone = (await x.places(s.alice)).phase_b;
    const patrol = await x.guardInZone(s.c, zone.id);
    const l = await x.lockdown(patrol);
    expect(l.scope).toBe('all');
  });

  it('while one gate is locked: visitors are refused there (verify, entry, gate request, materials, the plate lookup), not at the other gate; a resident still comes in; exits are recorded', async () => {
    const s = await scene('Lockdown Entries Court');
    const pass = await x.passWithCode(s.alice, s.home.id, {
      vehiclePlate: 'ق ب ط 7713',
    });
    // One of the two came in before the lockdown.
    await x.entryRaw(s.atNorth, 'visitor_pass', pass.id).expect(201);
    const l = await x.lockdown(s.atSouth, {
      scope: 'gate',
      gateId: s.north.id,
    });
    const verified = await x
      .verifyRaw(s.atNorth, { code: pass.code })
      .expect(200);
    expect(verified.body).toMatchObject({
      result: 'valid',
      next: 'out',
      reason: null,
    });
    await x
      .entryRaw(s.atNorth, 'visitor_pass', pass.id)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'LOCKDOWN_ACTIVE',
          params: { scope: 'gate' },
        }),
      );
    await x
      .http('post', '/gate/approval-requests', s.atNorth.token, {
        kind: 'uninvited_visitor',
        unitCode: s.home.code,
        visitorName: 'Lockdown Visitor',
      })
      .expect(409)
      .expect((r) => expect(r.body).toMatchObject({ code: 'LOCKDOWN_ACTIVE' }));
    await x
      .http('post', '/gate/material-entries', s.atNorth.token, {
        unitCode: s.home.code,
        description: 'Tiles',
      })
      .expect(409)
      .expect((r) => expect(r.body).toMatchObject({ code: 'LOCKDOWN_ACTIVE' }));
    const lookup = await x
      .http('post', '/gate/plate-lookup', s.atNorth.token, {
        plate: 'قبط٧٧١٣',
      })
      .expect(200);
    expect((lookup.body as { matches: unknown[] }).matches).toEqual([
      expect.objectContaining({
        kind: 'visitor_pass',
        pass: expect.objectContaining({
          valid: false,
          refusal: 'lockdown_active',
        }) as unknown,
      }),
    ]);
    // The one inside leaves.
    await x
      .entryRaw(s.atNorth, 'visitor_pass', pass.id, { direction: 'out' })
      .expect(201);
    // A resident comes in: their QR is valid through a lockdown.
    const resident = await x
      .verifyRaw(s.atNorth, { qr: await x.residentQr(s.alice) })
      .expect(200);
    expect(resident.body).toMatchObject({
      result: 'valid',
      subject: 'resident',
    });
    // The other gate is not locked.
    const other = await x.passWithCode(s.alice, s.home.id);
    const ok = await x.verifyRaw(s.atSouth, { code: other.code }).expect(200);
    expect(ok.body).toMatchObject({ result: 'valid', next: 'in' });
    await x.entryRaw(s.atSouth, 'visitor_pass', other.id).expect(201);
    // A fresh code at the locked gate: refused, not let in.
    const fresh = await x.passWithCode(s.alice, s.home.id);
    const refused = await x
      .verifyRaw(s.atNorth, { code: fresh.code })
      .expect(200);
    expect(refused.body).toMatchObject({
      result: 'invalid',
      reason: 'lockdown_active',
      next: null,
    });
    // Ended: the gate lets visitors in again.
    await x.endLockdownRaw(s.manager, l.id).expect(200);
    await x.entryRaw(s.atNorth, 'visitor_pass', fresh.id).expect(201);
  });

  it('"all" locks every gate', async () => {
    const s = await scene('Lockdown All Court');
    await x.lockdown(s.atNorth);
    const pass = await x.passWithCode(s.alice, s.home.id);
    await x
      .entryRaw(s.atSouth, 'visitor_pass', pass.id)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'LOCKDOWN_ACTIVE',
          params: { scope: 'all' },
        }),
      );
  });

  it('an entry recorded late is judged at the moment it happened: refused inside an ended lockdown, let in after it', async () => {
    const s = await scene('Lockdown Offline Court');
    const pass = await x.passWithCode(s.alice, s.home.id);
    const now = Date.now();
    await x.inTx(s.c, async (tx) => {
      await tx.gateLockdown.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          gateId: s.north.id,
          reasonCode: 'drill',
          startedById: s.atNorth.id,
          startedShiftId: s.atNorth.shiftId,
          startedAt: new Date(now + 60_000),
          endedAt: new Date(now + 180_000),
          endedById: s.manager.id,
          endReason: 'drill_over',
        },
      });
    });
    await x
      .entryRaw(s.atNorth, 'visitor_pass', pass.id, {
        occurredAt: new Date(now + 120_000).toISOString(),
      })
      .expect(409)
      .expect((r) => expect(r.body).toMatchObject({ code: 'LOCKDOWN_ACTIVE' }));
    await x
      .entryRaw(s.atNorth, 'visitor_pass', pass.id, {
        occurredAt: new Date(now + 240_000).toISOString(),
      })
      .expect(201);
  });

  it('an emergency vehicle through a locked gate: recorded with its code by a guard there, audited; refused elsewhere and once ended', async () => {
    const s = await scene('Lockdown Override Court');
    const l = await x.lockdown(s.atNorth, {
      scope: 'gate',
      gateId: s.north.id,
    });
    const res = await x
      .http('post', `/gate/lockdowns/${l.id}/overrides`, s.atNorth.token, {
        reasonCode: 'ambulance',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      lockdownId: l.id,
      gate: { id: s.north.id },
      reasonCode: 'ambulance',
      guard: { id: s.atNorth.id },
      emergencyId: null,
    });
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate_lockdown.override',
      targetId: l.id,
    });
    expect(row.metadata).toEqual({
      overrideId: (res.body as { id: string }).id,
      gateId: s.north.id,
      shiftId: s.atNorth.shiftId,
      kind: 'ambulance',
      emergencyId: null,
      gateServiceRequestId: null,
    });
    await x
      .http('post', `/gate/lockdowns/${l.id}/overrides`, s.atSouth.token, {
        reasonCode: 'police',
      })
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'LOCKDOWN_NOT_AT_GATE' }),
      );
    await x
      .http('post', `/gate/lockdowns/${l.id}/overrides`, s.atNorth.token, {
        reasonCode: 'taxi',
      })
      .expect(400);
    await x
      .http('post', `/gate/lockdowns/${newId()}/overrides`, s.atNorth.token, {
        reasonCode: 'police',
      })
      .expect(404)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'LOCKDOWN_NOT_FOUND' }),
      );
    await x.endLockdownRaw(s.manager, l.id).expect(200);
    await x
      .http('post', `/gate/lockdowns/${l.id}/overrides`, s.atNorth.token, {
        reasonCode: 'police',
      })
      .expect(409)
      .expect((r) => expect(r.body).toMatchObject({ code: 'LOCKDOWN_ENDED' }));
    const detail = (
      await x
        .http('get', `/staff/security/lockdowns/${l.id}`, s.manager.token)
        .expect(200)
    ).body as StaffLockdown;
    expect(detail.overrides).toEqual([
      expect.objectContaining({ reasonCode: 'ambulance' }),
    ]);
  });

  it('only the management ends it: once, with a code and a note; the residents are told once none is left', async () => {
    const s = await scene('Lockdown End Court');
    const gate = await x.lockdown(s.atNorth, {
      scope: 'gate',
      gateId: s.north.id,
    });
    const all = await x.lockdown(s.atSouth);
    await x.endLockdownRaw(await x.supervisor(s.c), gate.id).expect(403);
    await x.endLockdownRaw(s.atNorth, gate.id).expect(403);
    await x
      .endLockdownRaw(s.manager, gate.id, { reasonCode: 'nope' })
      .expect(400);
    const ended = (
      await x
        .endLockdownRaw(s.manager, gate.id, {
          reasonCode: 'false_alarm',
          note: 'Checked the cameras',
        })
        .expect(200)
    ).body as StaffLockdown;
    expect(ended).toMatchObject({
      endReason: 'false_alarm',
      endNote: 'Checked the cameras',
      endedBy: { id: s.manager.id },
    });
    expect(await kinds(s.c, s.atNorth, gate.id)).toEqual([
      'gate_lockdown.ended',
    ]);
    // "All" is still live: residents hear nothing yet.
    expect(await kinds(s.c, s.alice, gate.id)).toEqual([
      'gate_lockdown.resident_notice',
    ]);
    await x
      .endLockdownRaw(s.manager, gate.id)
      .expect(409)
      .expect((r) => expect(r.body).toMatchObject({ code: 'LOCKDOWN_ENDED' }));
    await x.endLockdownRaw(s.manager, all.id).expect(200);
    expect(await x.told(s.c, s.alice.id, all.id)).toEqual([
      { kind: 'gate_lockdown.ended', params: { scope: 'all' } },
    ]);
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate_lockdown.ended',
      targetId: gate.id,
    });
    expect(row.metadata).toEqual({
      scope: 'gate',
      gateId: s.north.id,
      reasonCode: 'false_alarm',
      note: true,
      recipients: 2,
      residents: 0,
    });
    expect(JSON.stringify(row)).not.toContain('Checked the cameras');
    const list = (
      await x
        .http('get', '/staff/security/lockdowns?status=ended', s.manager.token)
        .expect(200)
    ).body as { data: StaffLockdown[] };
    expect(list.data.map((r) => r.id).sort()).toEqual([gate.id, all.id].sort());
  });
});
