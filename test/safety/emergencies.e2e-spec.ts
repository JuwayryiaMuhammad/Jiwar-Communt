import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { safetyHelpers, type EmergencyBody, type Who } from '../setup/safety';

/**
 * ADR 0047, C1–C3: a household reports an emergency; every guard on an open
 * shift and every responder is told at once (critical), the others who live
 * in the unit too (a generic push); one open per unit and type; the reporter
 * or the primary cancels; a member answers "on my way". With nobody to tell,
 * the management is told at once.
 */
describe('Emergencies — the household', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof safetyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof safetyHelpers>['setUp']>>;
  let guard: Who & { gateId: string };
  let responder: Who;
  let offDuty: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = safetyHelpers(h);
    s = await x.setUp('Emergency Court');
    guard = await x.guardOnDuty(s.c);
    responder = await x.staff(s.c, ['emergencies.respond']);
    offDuty = await x.who(s.c, (await x.g.guard(s.c)).id, 'staff');
  }, 120_000);

  afterAll(() => h.close());

  async function household() {
    const home = await x.unit(s.c, 'B7');
    const owner = await x.owner(s.c, home.id);
    const member = await x.family(s.c, home.id, owner);
    return { home, owner, member };
  }

  it('reports: security and responders told at once, the family with a generic push, nobody else', async () => {
    const { home, owner, member } = await household();
    const neighbourHome = await x.unit(s.c);
    const neighbour = await x.owner(s.c, neighbourHome.id);
    const res = await x.reportRaw(owner, home.id, 'medical').expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const e = res.body as EmergencyBody;
    expect(Object.keys(e).sort()).toEqual(
      [
        'canCancel',
        'closeReason',
        'familyNotified',
        'familyOnTheWay',
        'id',
        'location',
        'minutesAway',
        'onMyWay',
        'reference',
        'reportedAt',
        'reportedBy',
        'responder',
        'status',
        'timeline',
        'type',
      ].sort(),
    );
    expect(e).toMatchObject({
      type: 'medical',
      status: 'reported',
      location: { unitId: home.id, unitCode: home.code, building: 'B7' },
      reportedBy: { id: owner.id },
      responder: null,
      minutesAway: null,
      familyNotified: 1,
      familyOnTheWay: 0,
      closeReason: null,
      onMyWay: null,
      canCancel: true,
    });
    expect(e.reference).toMatch(/^E-\d{4,}$/);
    expect(e.timeline.map((t) => t.step)).toEqual([
      'reported',
      'security_notified',
    ]);
    for (const who of [guard, responder])
      expect(await x.told(s.c, who.id, e.id)).toEqual([
        { kind: 'emergency.reported', params: { emergencyType: 'medical' } },
      ]);
    expect(await x.told(s.c, member.id, e.id)).toEqual([
      { kind: 'emergency.family_alert', params: {} },
    ]);
    for (const who of [owner, offDuty, neighbour, s.manager])
      expect(await x.told(s.c, who.id, e.id)).toEqual([]);
    // The member follows it, and has not answered yet.
    expect(await x.follow(member, e.id)).toMatchObject({
      id: e.id,
      onMyWay: false,
      canCancel: false,
    });
  });

  it('one open per unit and type: a repeat answers 200 with it; another type is another', async () => {
    const { home, owner, member } = await household();
    const first = await x.report(owner, home.id, 'fire');
    const again = await x.reportRaw(member, home.id, 'fire').expect(200);
    expect((again.body as EmergencyBody).id).toBe(first.id);
    // The repeat told nobody again.
    expect(await x.told(s.c, guard.id, first.id)).toHaveLength(1);
    const other = await x.report(member, home.id, 'security');
    expect(other.id).not.toBe(first.id);
    // Cancelled, it frees the type.
    await x
      .http('post', `/emergencies/${first.id}/cancel`, owner.token, {})
      .expect(200);
    expect((await x.report(owner, home.id, 'fire')).id).not.toBe(first.id);
  });

  it('an Idempotency-Key replays the same answer', async () => {
    const { home, owner } = await household();
    const key = '0192f9c0-7c1e-7a55-9d0f-2c4b1a1e0e01';
    const a = await x
      .reportRaw(owner, home.id, 'facilities', { 'Idempotency-Key': key })
      .expect(201);
    const b = await x
      .reportRaw(owner, home.id, 'facilities', { 'Idempotency-Key': key })
      .expect(201);
    expect((b.body as EmergencyBody).id).toBe((a.body as EmergencyBody).id);
  });

  it('with nobody to tell, the management is told at once', async () => {
    const c = await x.x.compound('Unguarded Court');
    const home = await x.unit(c);
    const owner = await x.owner(c, home.id);
    const manager = await x.who(c, c.managerId, 'manager');
    const e = await x.report(owner, home.id, 'security');
    expect(e.timeline.map((t) => t.step)).toEqual([
      'reported',
      'management_notified',
    ]);
    expect(await x.told(c, manager.id, e.id)).toEqual([
      { kind: 'emergency.escalated', params: { emergencyType: 'security' } },
    ]);
    const [row] = await auditReaders(h).tenant(c.tenantId, {
      action: 'emergency.escalated',
      targetId: e.id,
    });
    expect(row).toMatchObject({ actorId: owner.id });
    expect(row.metadata).toEqual({ reason: 'no_responders', recipients: 1 });
  });

  it('only the reporter and those alerted see it', async () => {
    const { home, owner, member } = await household();
    const e = await x.report(member, home.id, 'facilities');
    await x.follow(owner, e.id);
    const elsewhere = await x.unit(s.c);
    const stranger = await x.owner(s.c, elsewhere.id);
    const res = await x
      .http('get', `/emergencies/${e.id}`, stranger.token)
      .expect(404);
    expect(res.body).toMatchObject({ code: 'EMERGENCY_NOT_FOUND' });
    await x.http('get', `/emergencies/${e.id}`, guard.token).expect(403);
  });

  it('the reporter or the primary cancels, with a reason or none; the others may not; once', async () => {
    const { home, owner, member } = await household();
    // A member's report: the primary cancels it.
    const a = await x.report(member, home.id, 'medical');
    const byPrimary = await x
      .http('post', `/emergencies/${a.id}/cancel`, owner.token, {
        reasonCode: 'false_alarm',
      })
      .expect(200);
    expect(byPrimary.body).toMatchObject({
      status: 'cancelled',
      closeReason: 'false_alarm',
      canCancel: false,
    });
    expect(
      (byPrimary.body as EmergencyBody).timeline.map((t) => t.step),
    ).toEqual(['reported', 'security_notified', 'cancelled']);
    for (const who of [guard, responder])
      expect((await x.told(s.c, who.id, a.id)).map((n) => n.kind)).toEqual([
        'emergency.reported',
        'emergency.cancelled',
      ]);
    const again = await x
      .http('post', `/emergencies/${a.id}/cancel`, owner.token, {})
      .expect(409);
    expect(again.body).toMatchObject({
      code: 'EMERGENCY_CLOSED',
      params: { status: 'cancelled' },
    });
    // The primary's report: the member sees it but may not cancel it.
    const b = await x.report(owner, home.id, 'medical');
    const refused = await x
      .http('post', `/emergencies/${b.id}/cancel`, member.token, {})
      .expect(403);
    expect(refused.body).toMatchObject({
      code: 'EMERGENCY_ACTION_NOT_ALLOWED',
    });
    const bad = await x
      .http('post', `/emergencies/${b.id}/cancel`, owner.token, {
        reasonCode: 'handled',
      })
      .expect(400);
    expect(bad.body).toMatchObject({
      fields: [{ field: 'reasonCode', code: 'INVALID_REASON_CODE' }],
    });
    await x
      .http('post', `/emergencies/${b.id}/cancel`, owner.token, {})
      .expect(200)
      .then((r) =>
        expect(r.body).toMatchObject({
          status: 'cancelled',
          closeReason: null,
        }),
      );
  });

  it('a member answers "on my way" once; it shows in the timeline with their first name', async () => {
    const { home, owner, member } = await household();
    const e = await x.report(owner, home.id, 'fire');
    const first = await x
      .http('post', `/emergencies/${e.id}/on-my-way`, member.token)
      .expect(200);
    const body = first.body as EmergencyBody;
    expect(body).toMatchObject({ onMyWay: true, familyOnTheWay: 1 });
    const step = body.timeline.find((t) => t.step === 'family_on_the_way')!;
    const name = (
      await x.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: member.id } }),
      )
    ).fullName!;
    expect(step.firstName).toBe(name.split(' ')[0]);
    const second = await x
      .http('post', `/emergencies/${e.id}/on-my-way`, member.token)
      .expect(200);
    expect((second.body as EmergencyBody).timeline).toEqual(body.timeline);
    expect(
      await auditReaders(h).tenant(s.c.tenantId, {
        action: 'emergency.family_on_my_way',
        targetId: e.id,
      }),
    ).toHaveLength(1);
    // The reporter is there already.
    await x
      .http('post', `/emergencies/${e.id}/on-my-way`, owner.token)
      .expect(403);
    await x
      .http('post', `/emergencies/${e.id}/cancel`, owner.token, {})
      .expect(200);
    const late = await x
      .http('post', `/emergencies/${e.id}/on-my-way`, member.token)
      .expect(409);
    expect(late.body).toMatchObject({ code: 'EMERGENCY_CLOSED' });
  });

  it('my emergencies: those I reported or was alerted to, open or closed', async () => {
    const { home, owner, member } = await household();
    const open = await x.report(owner, home.id, 'security');
    const closed = await x.report(member, home.id, 'facilities');
    await x
      .http('post', `/emergencies/${closed.id}/cancel`, member.token, {})
      .expect(200);
    const list = async (who: Who, q = '') =>
      (
        (await x.http('get', `/me/emergencies${q}`, who.token).expect(200))
          .body as { data: EmergencyBody[] }
      ).data.map((e) => e.id);
    expect(await list(owner)).toEqual([closed.id, open.id]);
    expect(await list(member, '?status=open')).toEqual([open.id]);
    expect(await list(member, '?status=closed')).toEqual([closed.id]);
    const elsewhere = await x.unit(s.c);
    expect(await list(await x.owner(s.c, elsewhere.id))).toEqual([]);
  });

  it('a landlord has the button too; the tenant’s household is alerted; another unit is not found', async () => {
    const rented = await x.unit(s.c);
    const landlord = await x.landlord(s.c, rented.id);
    const tenant = await x.tenant(s.c, rented.id);
    const e = await x.report(landlord, rented.id, 'facilities');
    expect(e.familyNotified).toBe(1);
    expect(await x.told(s.c, tenant.id, e.id)).toEqual([
      { kind: 'emergency.family_alert', params: {} },
    ]);
    const res = await x.reportRaw(landlord, s.home.id).expect(404);
    expect(res.body).toMatchObject({ code: 'UNIT_NOT_FOUND' });
    await x.reportRaw(guard, s.home.id).expect(403);
  });

  it('is audited with ids and codes only', async () => {
    const { home, owner } = await household();
    const e = await x.report(owner, home.id, 'medical');
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'emergency.reported',
      targetId: e.id,
    });
    expect(row).toMatchObject({ actorId: owner.id, targetType: 'emergency' });
    expect(row.metadata).toEqual({
      number: Number(e.reference.slice(2)),
      type: 'medical',
      unitId: home.id,
      respondersNotified: 2,
      familyNotified: 1,
    });
  });
});
