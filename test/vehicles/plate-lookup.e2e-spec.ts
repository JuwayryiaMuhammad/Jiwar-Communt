import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { auditReaders } from '../setup/audit';
import { gateHelpers } from '../setup/gate';
import { sticker, vehicleHelpers, type Who } from '../setup/vehicles';

interface Match {
  kind: string;
  unitCode: string;
  plate: string;
  vehicle: Record<string, unknown> | null;
  pass: Record<string, unknown> | null;
}

/**
 * ADR 0045: the guard looks a plate up — a unit's vehicle with its permit,
 * a visitor's pass with whether it lets them in now and their parking —
 * by its key, inside a shift. Never a name; every lookup audited without
 * the plate.
 */
describe('Gate — plate lookup and visitor parking', () => {
  let h: HttpHarness;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof vehicleHelpers>['setUp']>>;
  let guard: Who & { shiftId: string };
  let areaId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    v = vehicleHelpers(h);
    s = await v.setUp();
    const duty = await gateHelpers(h).onDuty(s.c);
    guard = {
      ...(await v.who(s.c, duty.guardId, 'staff')),
      shiftId: duty.shiftId,
    };
    areaId = await v.area(s.c, s.manager, 20);
  }, 120_000);

  afterAll(() => h.close());

  const lookup = (plate: string, as: Who = guard) =>
    v.http('post', '/gate/plate-lookup', as.token, { plate });

  const fullName = async (id: string) =>
    (await v.inTx(s.c, (tx) => tx.account.findUniqueOrThrow({ where: { id } })))
      .fullName!;

  it('a unit’s pending and active vehicles, matched by the key; never a name', async () => {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const other = await v.unit(s.c);
    const neighbour = await v.owner(s.c, other.id);
    const active = await v.register(owner, home.id, { plate: 'ق ب ط ١٢٣٤' });
    const number = sticker();
    await v.approveRaw(s.manager, active.id, { stickerNumber: number });
    await v.register(neighbour, other.id, { plate: 'قبط1234' });
    const gone = await v.register(neighbour, other.id, { plate: 'قبط 1234' });
    await v.http('delete', `/vehicles/${gone.id}`, neighbour.token).expect(204);

    const res = await lookup(' قبط  1234 ').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as { plate: string; matches: Match[] };
    expect(body.plate).toBe('قبط 1234');
    expect(body.matches).toEqual([
      {
        kind: 'vehicle',
        unitCode: home.code,
        plate: 'ق ب ط ١٢٣٤',
        vehicle: {
          permitStatus: 'active',
          permitValidUntil: expect.any(String) as string,
          stickerNumber: number,
          type: 'car',
          color: 'Silver',
          makeAndModel: 'Hyundai Elantra',
        },
        pass: null,
        permit: null,
      },
      {
        kind: 'vehicle',
        unitCode: other.code,
        plate: 'قبط1234',
        vehicle: expect.objectContaining({
          permitStatus: 'pending',
          stickerNumber: null,
        }) as object,
        pass: null,
        permit: null,
      },
    ]);
    const text = JSON.stringify(res.body);
    for (const id of [owner.id, neighbour.id]) {
      expect(text).not.toContain(await fullName(id));
      expect(text).not.toContain(id);
    }
  });

  it('reads the Arabic letter variants as one letter (ADR 0047)', async () => {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const car = await v.register(owner, home.id, { plate: 'أ ى ة ٥٥٧' });
    for (const typed of ['ا ي ه 557', 'إي ه557', 'آ ى ة ٥٥٧']) {
      const body = (await lookup(typed).expect(200)).body as {
        matches: Match[];
      };
      expect(body.matches.map((m) => [m.kind, m.plate])).toEqual([
        ['vehicle', car.plate],
      ]);
    }
    // A letter that is not a variant is another plate.
    const none = (await lookup('ب ي ه 557').expect(200)).body as {
      matches: Match[];
    };
    expect(none.matches).toEqual([]);
  });

  it('a visitor pass carrying the plate: whether it lets them in now, and its parking', async () => {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const passId = await v.pass(owner, home.id, {
      vehiclePlate: 'zx 4401',
      visitorName: 'Hidden Visitor',
    });
    await v
      .parkRaw(owner, home.id, {
        areaId,
        visitorPassId: passId,
        startsAt: v.inMinutes(30),
        endsAt: v.inMinutes(90),
      })
      .then((r) => expect(r.status).toBe(201));
    const later = await v.pass(owner, home.id, {
      vehiclePlate: 'ZX4401',
      validFrom: new Date(Date.now() + 12 * 3_600_000).toISOString(),
      validUntil: new Date(Date.now() + 14 * 3_600_000).toISOString(),
    });
    const body = (await lookup('ZX 4401').expect(200)).body as {
      matches: Match[];
    };
    expect(body.matches).toEqual([
      {
        kind: 'visitor_pass',
        unitCode: home.code,
        plate: 'ZX 4401',
        vehicle: null,
        pass: {
          passKind: 'one_time',
          valid: true,
          refusal: null,
          validFrom: expect.any(String) as string,
          validUntil: expect.any(String) as string,
          parking: {
            areaName: expect.any(String) as string,
            startsAt: expect.any(String) as string,
            endsAt: expect.any(String) as string,
          },
        },
        permit: null,
      },
      expect.objectContaining({
        kind: 'visitor_pass',
        pass: expect.objectContaining({
          valid: false,
          refusal: 'not_yet_valid',
          parking: null,
        }) as object,
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain('Hidden Visitor');
    void later;
  });

  it('the visitor’s parking shows on the pass’s verify', async () => {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const created = await v
      .http('post', `/units/${home.id}/visitor-passes`, owner.token, {
        kind: 'one_time',
        partySize: 1,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 6 * 3_600_000).toISOString(),
      })
      .expect(201);
    const { id, code } = created.body as { id: string; code: string };
    const verify = async () =>
      (
        (
          await v
            .http('post', '/gate/verify', guard.token, { code })
            .expect(200)
        ).body as { display: { parking: unknown } }
      ).display.parking;
    expect(await verify()).toBeNull();
    await v
      .parkRaw(owner, home.id, {
        areaId,
        visitorPassId: id,
        startsAt: v.inMinutes(60),
        endsAt: v.inMinutes(120),
      })
      .then((r) => expect(r.status).toBe(201));
    expect(await verify()).toEqual({
      areaName: expect.any(String) as string,
      startsAt: v.inMinutes(60).toISOString(),
      endsAt: v.inMinutes(120).toISOString(),
    });
  });

  it('nothing found is an empty list; a plate that is not one is refused', async () => {
    expect((await lookup('QQ 0000').expect(200)).body).toEqual({
      plate: 'QQ 0000',
      matches: [],
    });
    expect((await lookup('AB-12').expect(400)).body).toMatchObject({
      fields: [
        { field: 'plate', code: 'INVALID_FORMAT', params: { maxLength: 12 } },
      ],
    });
  });

  it('off duty, a guard learns nothing', async () => {
    const off = await gateHelpers(h).guard(s.c);
    const token = await h.tokenFor({
      sub: off.id,
      tid: s.c.tenantId,
      typ: 'staff',
    });
    for (const res of [
      await v.http('post', '/gate/plate-lookup', token, { plate: 'QQ 0000' }),
      await v.http('get', '/gate/visitor-parking', token),
    ])
      expect({
        status: res.status,
        code: (res.body as { code: string }).code,
      }).toEqual({
        status: 403,
        code: 'NO_OPEN_SHIFT',
      });
  });

  it('every lookup is audited on the shift with the ids found, never the plate', async () => {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const car = await v.register(owner, home.id, { plate: 'AUDL 5150' });
    await lookup('audl 5150').expect(200);
    const rows = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate.plate_lookup',
      targetId: guard.shiftId,
    });
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({
      actorId: guard.id,
      targetType: 'guard_shift',
      metadata: {
        vehicleIds: [car.id],
        passIds: [],
        permitIds: [],
        guestIds: [],
        matches: 1,
      },
    });
    const text = JSON.stringify(rows);
    expect(text).not.toContain('AUDL');
    expect(text).not.toContain('5150');
  });

  it('the gate’s visitor parking: holding now or within two hours; a name only without a pass', async () => {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const passId = await v.pass(owner, home.id);
    const named = (
      await v.parkRaw(owner, home.id, {
        areaId,
        visitorName: 'Gate List Guest',
        startsAt: v.inMinutes(-5),
        endsAt: v.inMinutes(60),
      })
    ).body as { id: string };
    const withPass = (
      await v.parkRaw(owner, home.id, {
        areaId,
        visitorPassId: passId,
        startsAt: v.inMinutes(90),
        endsAt: v.inMinutes(150),
      })
    ).body as { id: string };
    const later = (
      await v.parkRaw(owner, home.id, {
        areaId,
        visitorName: 'Later Guest',
        startsAt: v.inMinutes(180),
        endsAt: v.inMinutes(240),
      })
    ).body as { id: string };
    const list = (
      (await v.http('get', '/gate/visitor-parking', guard.token).expect(200))
        .body as { data: Record<string, unknown>[] }
    ).data;
    const ids = list.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining([named.id, withPass.id]));
    expect(ids).not.toContain(later.id);
    expect(list.find((b) => b.id === named.id)).toMatchObject({
      unitCode: home.code,
      hasPass: false,
      visitorName: 'Gate List Guest',
    });
    expect(list.find((b) => b.id === withPass.id)).toMatchObject({
      hasPass: true,
      visitorName: null,
    });
  });
});
