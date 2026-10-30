import { queuedBehind } from '../setup/held-lock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers } from '../setup/security';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});

/**
 * ADR 0050: a guard works a post, a gate or a zone (one of the compound's
 * places). A zone shift is a shift: one open per guard, ended by a zone
 * retired as a gate deactivated ends its own. The gate's actions refuse it;
 * the responders' work takes it.
 *
 * A retirement takes the zone's shifts before the place (ADR 0056's lock
 * order), so a guard write that holds its shift and then reads the place
 * never deadlocks with it.
 */
describe('Zone shifts', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Zone Court');
  }, 120_000);

  afterAll(() => h.close());

  it('a shift in a zone: opened, current, refused at the gate, taken by the responders’ work, ended', async () => {
    const guard = await x.guard(s.c);
    const zones = await x.places(guard);
    const shift = await x.start(guard, { zoneId: zones.clubhouse.id });
    expect(shift).toMatchObject({
      gateId: null,
      gateName: null,
      zone: zones.clubhouse,
      endedAt: null,
    });
    const current = await x
      .http('get', '/gate/shifts/current', guard.token)
      .expect(200);
    expect(current.body).toEqual(shift);

    // The gate's actions need a gate.
    expect(code(await x.http('get', '/gate/inside', guard.token))).toEqual({
      status: 403,
      code: 'SHIFT_NOT_AT_GATE',
    });
    // Emergencies and gate services take a guard on shift anywhere.
    await x.http('get', '/gate/emergencies', guard.token).expect(200);
    await x.http('get', '/gate/gate-services', guard.token).expect(200);

    expect(
      code(await x.startRaw(guard, { gateId: (await x.g.gate(s.c)).id })),
    ).toEqual({ status: 409, code: 'SHIFT_ALREADY_OPEN' });
    const ended = await x.endRaw(guard).expect(200);
    expect(ended.body).toMatchObject({ id: shift.id, gateId: null });
    expect((await x.shiftRow(s.c, shift.id)).endReason).toBe('guard');
  });

  it('exactly one post: a gate or a zone', async () => {
    const guard = await x.guard(s.c);
    const gate = await x.g.gate(s.c);
    const zones = await x.places(guard);
    const neither = await x.startRaw(guard, {}).expect(400);
    expect((neither.body as { fields: unknown[] }).fields).toEqual([
      { field: 'gateId', code: 'FIELD_REQUIRED' },
    ]);
    const both = await x
      .startRaw(guard, { gateId: gate.id, zoneId: zones.parking.id })
      .expect(400);
    expect((both.body as { fields: unknown[] }).fields).toEqual([
      { field: 'zoneId', code: 'FIELD_NOT_ALLOWED' },
    ]);
    expect(
      code(
        await x.startRaw(guard, {
          zoneId: '019a0000-0000-7000-8000-000000000000',
        }),
      ),
    ).toEqual({ status: 404, code: 'PLACE_NOT_FOUND' });
  });

  it('a zone retired ends its shifts and starts no more; a gate shift elsewhere is untouched', async () => {
    const created = await x
      .http('post', '/places', s.manager.token, {
        nameEn: 'Back lane',
        nameAr: 'الممر الخلفي',
      })
      .expect(201);
    const zoneId = (created.body as { id: string }).id;
    const inZone = await x.guard(s.c);
    const atGate = await x.guard(s.c);
    const zoneShift = await x.start(inZone, { zoneId });
    const gateShift = await x.start(atGate, {
      gateId: (await x.g.gate(s.c)).id,
    });

    await x
      .http('patch', `/places/${zoneId}`, s.manager.token, { active: false })
      .expect(200);
    const row = await x.shiftRow(s.c, zoneShift.id);
    expect(row.endReason).toBe('place_retired');
    expect(row.endedAt).not.toBeNull();
    expect((await x.shiftRow(s.c, gateShift.id)).endedAt).toBeNull();
    expect(code(await x.startRaw(inZone, { zoneId }))).toEqual({
      status: 404,
      code: 'PLACE_NOT_FOUND',
    });
  });

  it('a start racing the zone’s retirement never leaves a shift open in a retired zone', async () => {
    for (let i = 0; i < 5; i++) {
      const created = await x
        .http('post', '/places', s.manager.token, {
          nameEn: `Race lane ${i}`,
          nameAr: `ممر ${i}`,
        })
        .expect(201);
      const zoneId = (created.body as { id: string }).id;
      const guard = await x.guard(s.c);
      const [started] = await Promise.all([
        x.startRaw(guard, { zoneId }),
        x.http('patch', `/places/${zoneId}`, s.manager.token, {
          active: false,
        }),
      ]);
      expect([201, 404]).toContain(started.status);
      const open = await x.inTx(s.c, (tx) =>
        tx.guardShift.count({ where: { placeId: zoneId, endedAt: null } }),
      );
      expect(open).toBe(0);
    }
  });

  it('a retirement queued before a write naming the zone: the shift first, never a deadlock', async () => {
    const created = await x
      .http('post', '/places', s.manager.token, {
        nameEn: 'Deadlock lane',
        nameAr: 'ممر الانتظار',
      })
      .expect(201);
    const zoneId = (created.body as { id: string }).id;
    const guard = await x.guard(s.c);
    await x.start(guard, { zoneId });
    // The place held: the retirement queues first, the guard's found item
    // (its shift, then this place) after it.
    const [retired, registered] = await queuedBehind(
      {
        sql: 'SELECT id FROM places WHERE id = $1 FOR UPDATE',
        params: [zoneId],
      },
      [
        () =>
          x.http('patch', `/places/${zoneId}`, s.manager.token, {
            active: false,
          }),
        () =>
          x.http('post', '/gate/found-items', guard.token, {
            description: 'Keys by the back lane',
            placeId: zoneId,
          }),
      ],
    );
    expect(retired.status).toBe(200);
    // The item took the shift: the retirement ended it first.
    expect(code(registered)).toEqual({ status: 403, code: 'NO_OPEN_SHIFT' });
    expect(
      await x.inTx(s.c, (tx) =>
        tx.foundItem.count({ where: { placeId: zoneId } }),
      ),
    ).toBe(0);
  });
});
