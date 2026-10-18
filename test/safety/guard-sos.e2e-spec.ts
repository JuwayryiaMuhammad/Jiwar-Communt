import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  securityOpsHelpers,
  type StaffEmergencyBody,
  type Who,
} from '../setup/security-ops';

/**
 * ADR 0053: a guard's SOS is an emergency from the post of their open shift,
 * a gate or a zone, with ADR 0047's flow and nobody's family. One open per
 * post and type. The other guards on shift, the responders and the
 * management are told at once; with no responder there, the management gets
 * it as an escalation. The guard who raised it cancels it, and never
 * accepts it.
 */
describe('Emergencies — a guard’s SOS from their post', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
  }, 120_000);

  afterAll(() => h.close());

  async function scene(name: string) {
    const s = await x.setUp(name);
    const gate = await x.g.gate(s.c);
    const raiser = await x.guardAt(s.c, gate.id);
    return { ...s, gate, raiser };
  }

  const kinds = async (
    s: { c: Parameters<typeof x.told>[0] },
    who: Who,
    id: string,
  ) => (await x.told(s.c, who.id, id)).map((n) => n.kind);

  it('from a gate: the post, no unit, the other guards, the responders and the management told; audited by ids', async () => {
    const s = await scene('SOS Gate Court');
    const other = await x.guardOnDuty(s.c);
    const responder = await x.staff(s.c, ['emergencies.respond']);
    const res = await x.sosRaw(s.raiser, 'security').expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const e = res.body as StaffEmergencyBody;
    expect(e).toMatchObject({
      type: 'security',
      status: 'reported',
      location: null,
      post: { gateId: s.gate.id, gateName: s.gate.name, zone: null },
      reportedBy: { id: s.raiser.id },
      respondersNotified: 2,
      familyNotified: 0,
      escalatedAt: null,
    });
    expect(e.reference).toMatch(/^E-\d{4}$/);
    for (const who of [other, responder, s.manager])
      expect(await x.told(s.c, who.id, e.id)).toEqual([
        { kind: 'emergency.reported', params: { emergencyType: 'security' } },
      ]);
    expect(await kinds(s, s.raiser, e.id)).toEqual([]);
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'emergency.reported',
      targetId: e.id,
    });
    expect(row.metadata).toEqual({
      number: expect.any(Number) as number,
      type: 'security',
      unitId: null,
      gateId: s.gate.id,
      placeId: null,
      shiftId: s.raiser.shiftId,
      respondersNotified: 2,
      familyNotified: 0,
    });
    // The responders' queue shows it with its post.
    const queue = (
      await x
        .http('get', '/gate/emergencies?status=open', other.token)
        .expect(200)
    ).body as { data: StaffEmergencyBody[] };
    expect(queue.data.find((q) => q.id === e.id)).toMatchObject({
      location: null,
      post: { gateId: s.gate.id },
    });
  });

  it('one open per post and type: a repeat answers 200 with it, another type is its own', async () => {
    const s = await scene('SOS Repeat Court');
    await x.guardOnDuty(s.c);
    const first = await x.sos(s.raiser, 'medical');
    const again = await x.sosRaw(s.raiser, 'medical').expect(200);
    expect((again.body as StaffEmergencyBody).id).toBe(first.id);
    // Another guard at the same gate meets the same one.
    const colleague = await x.guardAt(s.c, s.gate.id);
    const theirs = await x.sosRaw(colleague, 'medical').expect(200);
    expect((theirs.body as StaffEmergencyBody).id).toBe(first.id);
    const fire = await x.sos(s.raiser, 'fire');
    expect(fire.id).not.toBe(first.id);
    // An Idempotency-Key replay answers the same.
    const key = { 'Idempotency-Key': `sos-${first.id}` };
    const k1 = await x.sosRaw(s.raiser, 'facilities', key).expect(201);
    const k2 = await x.sosRaw(s.raiser, 'facilities', key).expect(201);
    expect((k2.body as StaffEmergencyBody).id).toBe(
      (k1.body as StaffEmergencyBody).id,
    );
  });

  it('from a zone: the zone as its post', async () => {
    const s = await x.setUp('SOS Zone Court');
    const zones = await x.places(s.alice);
    const zone = zones.phase_a;
    const raiser = await x.guardInZone(s.c, zone.id);
    await x.guardOnDuty(s.c);
    const e = await x.sos(raiser, 'fire');
    expect(e).toMatchObject({
      location: null,
      post: { gateId: null, gateName: null, zone: { id: zone.id } },
    });
  });

  it('nobody else on shift and no responder: the management gets it as an escalation, once', async () => {
    const s = await scene('SOS Alone Court');
    const e = await x.sos(s.raiser);
    expect(e).toMatchObject({
      respondersNotified: 0,
      escalationReason: 'no_responders',
    });
    expect(await kinds(s, s.manager, e.id)).toEqual(['emergency.escalated']);
  });

  it('the raiser never accepts their own; another guard does, and the raiser is told', async () => {
    const s = await scene('SOS Accept Court');
    const other = await x.guardOnDuty(s.c);
    const e = await x.sos(s.raiser);
    await x
      .http('post', `/gate/emergencies/${e.id}/accept`, s.raiser.token, {
        etaMinutes: 2,
      })
      .expect(403)
      .expect((r) => expect(r.body).toMatchObject({ code: 'EMERGENCY_OWN' }));
    await x
      .http('post', `/gate/emergencies/${e.id}/accept`, other.token, {
        etaMinutes: 5,
      })
      .expect(200);
    expect(await kinds(s, s.raiser, e.id)).toEqual([
      'emergency.responder_on_the_way',
    ]);
  });

  it('the raiser cancels it; nobody else may, and those told are told it is over', async () => {
    const s = await scene('SOS Cancel Court');
    const other = await x.guardOnDuty(s.c);
    const e = await x.sos(s.raiser);
    await x
      .http('post', `/gate/emergencies/${e.id}/cancel`, other.token, {})
      .expect(404)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'EMERGENCY_NOT_FOUND' }),
      );
    const res = await x
      .http('post', `/gate/emergencies/${e.id}/cancel`, s.raiser.token, {
        reasonCode: 'false_alarm',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'cancelled',
      closeReason: 'false_alarm',
    });
    expect(await kinds(s, other, e.id)).toEqual([
      'emergency.reported',
      'emergency.cancelled',
    ]);
    await x
      .http('post', `/gate/emergencies/${e.id}/cancel`, s.raiser.token, {})
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'EMERGENCY_CLOSED' }),
      );
    await x
      .http('post', `/gate/emergencies/${e.id}/cancel`, s.raiser.token, {
        reasonCode: 'nope',
      })
      .expect(400);
  });

  it('a guard off shift, and anyone without gate.operate, raises nothing', async () => {
    const s = await x.setUp('SOS Refused Court');
    const offShift = await x.guard(s.c);
    await x
      .sosRaw(offShift)
      .expect(403)
      .expect((r) => expect(r.body).toMatchObject({ code: 'NO_OPEN_SHIFT' }));
    const responder = await x.staff(s.c, ['emergencies.respond']);
    for (const who of [s.alice, s.manager, responder])
      await x
        .sosRaw(who)
        .expect(403)
        .expect((r) => expect(r.body).toMatchObject({ code: 'FORBIDDEN' }));
  });

  it('two SOS at once at one post make one emergency (×5)', async () => {
    const s = await scene('SOS Race Court');
    const colleague = await x.guardAt(s.c, s.gate.id);
    for (const type of [
      'medical',
      'fire',
      'security',
      'facilities',
      'medical',
    ]) {
      const [a, b] = await Promise.all([
        x.sosRaw(s.raiser, type),
        x.sosRaw(colleague, type),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect((a.body as StaffEmergencyBody).id).toBe(
        (b.body as StaffEmergencyBody).id,
      );
      await x
        .http(
          'post',
          `/gate/emergencies/${(a.body as StaffEmergencyBody).id}/cancel`,
          (a.status === 201 ? s.raiser : colleague).token,
          {},
        )
        .expect(200);
    }
  });
});
