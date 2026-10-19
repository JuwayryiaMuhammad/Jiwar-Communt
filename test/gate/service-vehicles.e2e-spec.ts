import { facilityRow } from '../setup/facilities-rows';
import { auditReaders } from '../setup/audit';
import { day, today } from '../setup/compound-clock';
import { gateCompletionHelpers } from '../setup/gate-completion';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';

/**
 * ADR 0056, service vehicles: a guard on shift records a tanker, a waste
 * truck, a delivery or another coming in and going out, with its plate,
 * kind, company and the unit or facility served. The plate is matched as
 * every plate: a lockdown or a ban keeps it out, a watch flags it. A plate
 * is inside once at a time; the system closes a visit left open. The gate
 * sees who is inside; the daily report counts them.
 */
describe('Gate — service vehicles (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Service Vehicles Court');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  let n = 0;
  /** A plate no other test uses. */
  const plate = () => `ص ح ${4000 + ++n}`;

  it('in at the guard’s gate: seen inside, counted, audited without the plate or company', async () => {
    const p = plate();
    const v = await g.serviceIn(s.guard, p, { unitCode: s.unitCode });
    expect(v).toMatchObject({
      plate: p,
      kind: 'tanker',
      company: 'Nile Water Co',
      unitCode: s.unitCode,
      facility: null,
      enteredGate: { id: s.guard.gateId },
      exitedAt: null,
      exitUnconfirmed: false,
    });
    const inside = (
      await g.http('get', '/gate/service-vehicles', s.guard.token).expect(200)
    ).body as { data: { id: string }[] };
    expect(inside.data.map((x) => x.id)).toContain(v.id);
    const [entered] = await read.tenant(s.c.tenantId, {
      action: 'service_vehicle.entered',
      targetId: v.id,
    });
    expect(entered.metadata).toEqual({
      kind: 'tanker',
      unitId: s.home.id,
      facilityId: null,
      gateId: s.guard.gateId,
      shiftId: s.guard.shiftId,
    });
    expect(leakText(entered)).not.toContain('Nile Water');
    expect(leakText(entered)).not.toContain(p);
    const daily = (
      await g
        .http(
          'get',
          `/staff/security/reports/daily?date=${today()}&gateId=${s.guard.gateId}`,
          s.manager.token,
        )
        .expect(200)
    ).body as { posts: { counts: { serviceVehicles: number | null } }[] };
    expect(daily.posts[0].counts.serviceVehicles).toBeGreaterThanOrEqual(1);
    // The plate lookup shows it inside, to record its exit.
    const lookup = (
      await g
        .http('post', '/gate/plate-lookup', s.guard.token, { plate: p })
        .expect(200)
    ).body as { serviceVehicles: { id: string }[] };
    expect(lookup.serviceVehicles.map((x) => x.id)).toEqual([v.id]);
  });

  it('a plate is inside once at a time, however it is typed; out once', async () => {
    const v = await g.serviceIn(s.guard, 'ص ح ١٢٣٤');
    const again = await g.serviceInRaw(s.guard, { plate: 'صح 1234' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'SERVICE_VEHICLE_INSIDE',
      params: { id: v.id },
    });
    const out = (await g.serviceOutRaw(s.guard, v.id).expect(200)).body as {
      exitedAt: string;
      exitedGate: { id: string };
    };
    expect(out.exitedGate.id).toBe(s.guard.gateId);
    expect(code(await g.serviceOutRaw(s.guard, v.id).expect(409))).toBe(
      'SERVICE_VEHICLE_NOT_INSIDE',
    );
    // Gone, it may come again.
    await g.serviceIn(s.guard, 'صح 1234');
  });

  it('a unit or a facility served, never both; never another compound’s', async () => {
    const facilityId = await g.inTx(s.c, (tx) => facilityRow(tx, s.c.tenantId));
    const v = await g.serviceIn(s.guard, plate(), { facilityId });
    expect(v).toMatchObject({
      unitCode: null,
      facility: { id: facilityId, nameEn: 'Court' },
    });
    const both = await g
      .serviceInRaw(s.guard, {
        plate: plate(),
        unitCode: s.unitCode,
        facilityId,
      })
      .expect(400);
    expect((both.body as { fields: unknown[] }).fields).toEqual([
      { field: 'facilityId', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const other = await g.setUp('Service Vehicles Elsewhere');
    const theirs = await g.inTx(other.c, (tx) =>
      facilityRow(tx, other.c.tenantId),
    );
    expect(
      code(
        await g
          .serviceInRaw(s.guard, { plate: plate(), facilityId: theirs })
          .expect(404),
      ),
    ).toBe('FACILITY_NOT_FOUND');
    expect(
      code(
        await g
          .serviceInRaw(s.guard, { plate: plate(), unitCode: 'NO-SUCH' })
          .expect(404),
      ),
    ).toBe('UNIT_NOT_FOUND');
  });

  it('a lockdown keeps it out, never in; its exit is always recorded', async () => {
    const v = await g.serviceIn(s.guard, plate());
    const locked = await g.lockdown(s.guard, {
      scope: 'gate',
      gateId: s.guard.gateId,
      reasonCode: 'drill',
    });
    try {
      expect(
        code(await g.serviceInRaw(s.guard, { plate: plate() }).expect(409)),
      ).toBe('LOCKDOWN_ACTIVE');
      await g.serviceOutRaw(s.guard, v.id).expect(200);
    } finally {
      await g.endLockdownRaw(s.manager, locked.id, {
        reasonCode: 'drill_over',
      });
    }
  });

  it('a banned plate is refused, nothing written; a watched one comes in, flagged', async () => {
    const banned = plate();
    await g.block(s.manager, { subject: 'plate', plate: banned });
    const before = await g.inTx(s.c, (tx) => tx.serviceVehicleVisit.count());
    expect(
      code(await g.serviceInRaw(s.guard, { plate: banned }).expect(409)),
    ).toBe('ENTRY_BLOCKED');
    expect(await g.inTx(s.c, (tx) => tx.serviceVehicleVisit.count())).toBe(
      before,
    );
    const watched = plate();
    await g.block(s.manager, {
      kind: 'watch',
      subject: 'plate',
      plate: watched,
    });
    const v = await g.serviceIn(s.guard, watched);
    const matches = await g.inTx(s.c, (tx) =>
      tx.blocklistMatch.findMany({ where: { source: 'service_vehicle' } }),
    );
    expect(matches.map((m) => [m.outcome, m.subjectId])).toEqual(
      expect.arrayContaining([
        ['refused', null],
        ['flagged', v.id],
      ]),
    );
  });

  it('left open past the hours: closed by the system, unconfirmed, and it may come again', async () => {
    const p = plate();
    const v = await g.serviceIn(s.guard, p);
    await g.backdateService(v.id, 13 * 60);
    await g.sweepServiceExits();
    const row = await g.inTx(s.c, (tx) =>
      tx.serviceVehicleVisit.findUniqueOrThrow({ where: { id: v.id } }),
    );
    expect(row).toMatchObject({
      exitUnconfirmed: true,
      exitedById: null,
      exitedGateId: s.guard.gateId,
    });
    const [closed] = await read.tenant(s.c.tenantId, {
      action: 'service_vehicle.exit_unconfirmed',
      targetId: v.id,
    });
    expect(closed).toMatchObject({ actorType: 'system', actorId: null });
    await g.serviceIn(s.guard, p);
  });

  it('the management’s log by days; never a guard’s; 31 days at most', async () => {
    const v = await g.serviceIn(s.guard, plate());
    const log = (
      await g
        .http('get', '/staff/gate/service-vehicles', s.manager.token)
        .expect(200)
    ).body as { data: { id: string }[] };
    expect(log.data.map((x) => x.id)).toContain(v.id);
    await g
      .http('get', '/staff/gate/service-vehicles', s.guard.token)
      .expect(403);
    const long = await g
      .http(
        'get',
        `/staff/gate/service-vehicles?from=${day(-40)}&to=${today()}`,
        s.manager.token,
      )
      .expect(400);
    expect((long.body as { fields: unknown[] }).fields).toEqual([
      { field: 'to', code: 'PERIOD_TOO_LONG', params: { maxDays: 31 } },
    ]);
  });

  it('only a guard on shift at a gate', async () => {
    const offDuty = await g.guard(s.c);
    expect(
      code(await g.serviceInRaw(offDuty, { plate: plate() }).expect(403)),
    ).toBe('NO_OPEN_SHIFT');
  });
});
