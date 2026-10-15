import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { safetyHelpers, type EmergencyBody, type Who } from '../setup/safety';

interface StaffEmergency {
  id: string;
  status: string;
  location: { unitCode: string; building: string | null };
  reportedBy: { id: string; firstName?: string | null };
  responderAccount: { id: string; firstName?: string | null } | null;
  responder: { firstName: string | null; phone: string | null } | null;
  isMine: boolean;
  etaMinutes: number | null;
  minutesAway: number | null;
  escalatedAt: string | null;
  closeReason: string | null;
  closeNote: string | null;
  timeline: { step: string }[];
}

/**
 * ADR 0047: guards on an open shift, responders and the management see the
 * compound's emergencies — never a resident's phone; the first to accept
 * with their minutes is the responder; the household sees their first name
 * and the gate's phone, and the countdown; the responder arrives and
 * resolves, or the management does.
 */
describe('Emergencies — the responders', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof safetyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof safetyHelpers>['setUp']>>;
  let guard: Who & { gateId: string };
  let responder: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = safetyHelpers(h);
    s = await x.setUp('Responders Court');
    guard = await x.guardOnDuty(s.c);
    await x
      .http('patch', `/gates/${guard.gateId}`, s.manager.token, {
        phone: '+20225550170',
      })
      .expect(200);
    await x
      .http('patch', '/settings', s.manager.token, {
        dutyPhone: '+201000000171',
      })
      .expect(200);
    responder = await x.staff(s.c, ['emergencies.respond']);
  }, 120_000);

  afterAll(() => h.close());

  const accept = (who: Who, id: string, etaMinutes = 5) =>
    x.http('post', `/gate/emergencies/${id}/accept`, who.token, {
      etaMinutes,
    });

  async function household() {
    const home = await x.unit(s.c, 'B9');
    const owner = await x.owner(s.c, home.id);
    const member = await x.family(s.c, home.id, owner);
    return { home, owner, member };
  }
  const phoneOf = async (id: string) =>
    (await x.inTx(s.c, (tx) => tx.account.findUniqueOrThrow({ where: { id } })))
      .phone!;

  it('the queue: open ones oldest first, the unit and a first name, never a phone', async () => {
    const { home, owner } = await household();
    const e = await x.report(owner, home.id, 'medical');
    const res = await x
      .http('get', '/gate/emergencies?status=open', guard.token)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const list = (res.body as { data: StaffEmergency[] }).data;
    const mine = list.find((r) => r.id === e.id)!;
    expect(mine).toMatchObject({
      status: 'reported',
      location: { unitCode: home.code, building: 'B9' },
      reportedBy: { id: owner.id },
      responderAccount: null,
      isMine: false,
    });
    const text = JSON.stringify(list);
    expect(text).not.toContain(await phoneOf(owner.id));
    const name = (
      await x.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: owner.id } }),
      )
    ).fullName!;
    expect(text).not.toContain(name);
    // Oldest first.
    const at = list.map((r) => r.id);
    expect(at.indexOf(e.id)).toBe(at.length - 1);
  });

  it('a guard without an open shift is refused; residents have no route here', async () => {
    const idle = await x.who(s.c, (await x.g.guard(s.c)).id, 'staff');
    const res = await x
      .http('get', '/gate/emergencies', idle.token)
      .expect(403);
    expect(res.body).toMatchObject({ code: 'NO_OPEN_SHIFT' });
    await x.http('get', '/gate/emergencies', s.alice.token).expect(403);
    // A responder needs no shift; nor does the manager.
    await x.http('get', '/gate/emergencies', responder.token).expect(200);
    await x.http('get', '/gate/emergencies', s.manager.token).expect(200);
  });

  it('a guard accepts: the household is told, sees the first name, the gate’s phone and the countdown', async () => {
    const { home, owner, member } = await household();
    const e = await x.report(owner, home.id, 'fire');
    const res = await accept(guard, e.id, 10).expect(200);
    expect(res.body).toMatchObject({
      status: 'on_the_way',
      isMine: true,
      etaMinutes: 10,
      minutesAway: 10,
      responderAccount: { id: guard.id },
      responder: { phone: '+20225550170' },
    });
    for (const who of [owner, member])
      expect(await x.told(s.c, who.id, e.id)).toContainEqual({
        kind: 'emergency.responder_on_the_way',
        params: { etaMinutes: 10 },
      });
    const seen = await x.follow(owner, e.id);
    expect(seen).toMatchObject({
      status: 'on_the_way',
      minutesAway: 10,
      responder: { phone: '+20225550170' },
    });
    expect(seen.responder!.firstName).toMatch(/^Guard$/);
    expect(seen.timeline.map((t) => t.step)).toEqual([
      'reported',
      'security_notified',
      'on_the_way',
    ]);
    // The guard's own phone is nowhere.
    expect(JSON.stringify(seen)).not.toContain(await phoneOf(guard.id));
  });

  it('a responder not at a gate gives the duty phone', async () => {
    const { home, owner } = await household();
    const e = await x.report(owner, home.id, 'security');
    await accept(responder, e.id, 2).expect(200);
    expect((await x.follow(owner, e.id)).responder).toMatchObject({
      phone: '+201000000171',
    });
  });

  it('the first accept wins; the rest get 409; a closed one takes none', async () => {
    const { home, owner } = await household();
    const e = await x.report(owner, home.id, 'facilities');
    await accept(responder, e.id).expect(200);
    const second = await accept(guard, e.id).expect(409);
    expect(second.body).toMatchObject({ code: 'EMERGENCY_ALREADY_ACCEPTED' });
    await x
      .http('post', `/emergencies/${e.id}/cancel`, owner.token, {})
      .expect(200);
    expect((await x.told(s.c, responder.id, e.id)).map((n) => n.kind)).toEqual([
      'emergency.reported',
      'emergency.cancelled',
    ]);
    // The guard was told of the report only: the responder had it.
    expect((await x.told(s.c, guard.id, e.id)).map((n) => n.kind)).toEqual([
      'emergency.reported',
    ]);
    const late = await accept(guard, e.id).expect(409);
    expect(late.body).toMatchObject({
      code: 'EMERGENCY_CLOSED',
      params: { status: 'cancelled' },
    });
  });

  it('only the responder arrives; arriving again changes nothing; then they resolve with a note', async () => {
    const { home, owner } = await household();
    const e = await x.report(owner, home.id, 'medical');
    const early = await x
      .http('post', `/gate/emergencies/${e.id}/arrived`, guard.token)
      .expect(409);
    expect(early.body).toMatchObject({ code: 'EMERGENCY_NOT_ON_THE_WAY' });
    await accept(guard, e.id).expect(200);
    const other = await x
      .http('post', `/gate/emergencies/${e.id}/arrived`, responder.token)
      .expect(403);
    expect(other.body).toMatchObject({ code: 'EMERGENCY_NOT_RESPONDER' });
    const arrived = await x
      .http('post', `/gate/emergencies/${e.id}/arrived`, guard.token)
      .expect(200);
    expect(arrived.body).toMatchObject({ status: 'arrived', minutesAway: 0 });
    await x
      .http('post', `/gate/emergencies/${e.id}/arrived`, guard.token)
      .expect(200);
    await x
      .http('post', `/gate/emergencies/${e.id}/resolve`, responder.token, {
        reasonCode: 'handled',
      })
      .expect(403);
    const resolved = await x
      .http('post', `/gate/emergencies/${e.id}/resolve`, guard.token, {
        reasonCode: 'transferred_ambulance',
        note: '  Ambulance took him to the clinic  ',
      })
      .expect(200);
    expect(resolved.body).toMatchObject({
      status: 'resolved',
      closeReason: 'transferred_ambulance',
      closeNote: 'Ambulance took him to the clinic',
    });
    const seen: EmergencyBody = await x.follow(owner, e.id);
    expect(seen).toMatchObject({
      status: 'resolved',
      minutesAway: null,
      closeReason: 'transferred_ambulance',
      canCancel: false,
    });
    expect(seen.timeline.map((t) => t.step)).toEqual([
      'reported',
      'security_notified',
      'on_the_way',
      'arrived',
      'resolved',
    ]);
    // The staff's note is theirs, not the household's.
    expect(JSON.stringify(seen)).not.toContain('Ambulance took him');
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'emergency.resolved',
      targetId: e.id,
    });
    expect(row.metadata).toEqual({
      from: 'arrived',
      reasonCode: 'transferred_ambulance',
      side: 'responder',
      note: true,
    });
    expect(JSON.stringify(row)).not.toContain('Ambulance');
  });

  it('the management resolves one nobody answered', async () => {
    const { home, owner } = await household();
    const e = await x.report(owner, home.id, 'security');
    const res = await x
      .http('post', `/gate/emergencies/${e.id}/resolve`, s.manager.token, {
        reasonCode: 'false_alarm',
      })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'resolved', isMine: false });
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'emergency.resolved',
      targetId: e.id,
    });
    expect(row.metadata).toMatchObject({ from: 'reported', side: 'staff' });
  });
});
