import { newId } from '../../src/core/common/uuid';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { safetyHelpers, type PlaceBody, type Who } from '../setup/safety';

interface ServiceBody {
  id: string;
  reference: string;
  kind: string;
  status: string;
  createdAt: string;
  unitId: string;
  assistanceKind: string | null;
  member: { id: string; firstName: string | null } | null;
  fromPlace: PlaceBody | null;
  toPlace: PlaceBody | null;
  place: PlaceBody | null;
  when: string | null;
  wantedAt: string | null;
  description: string | null;
  photoUrl: string | null;
  laneReason: string | null;
  gate: { id: string; name: string } | null;
  notes: string | null;
  minutesAway: number | null;
  handler: { firstName: string | null; phone: string | null } | null;
  acceptedAt: string | null;
  startedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  cancelledAt: string | null;
  canCancel: boolean;
}

/**
 * ADR 0047, C7 and D1–D5: someone who lives in a unit asks security for
 * accessibility help, reports something suspicious, asks for an escort or
 * a lane at a gate. Security is told at once; the requester follows and
 * cancels while open. Three open per kind and twenty a day per unit.
 */
describe('Gate services — the requester', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof safetyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof safetyHelpers>['setUp']>>;
  let guardA: Who & { gateId: string };
  let guardB: Who & { gateId: string };
  let handler: Who;
  let places: Record<string, PlaceBody>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = safetyHelpers(h);
    s = await x.setUp('Services Court');
    guardA = await x.guardOnDuty(s.c);
    guardB = await x.guardOnDuty(s.c);
    handler = await x.staff(s.c, ['gate_services.handle']);
    places = await x.places(s.alice);
  }, 120_000);

  afterAll(() => h.close());

  async function home() {
    const unit = await x.unit(s.c);
    const owner = await x.owner(s.c, unit.id);
    return { unit, owner };
  }
  const post = (who: Who, path: string, body: object) =>
    x.http('post', path, who.token, body);
  const escort = (who: Who, unitId: string) =>
    post(who, '/escort-requests', {
      unitId,
      fromPlaceId: places.parking.id,
      toPlaceId: places.phase_b.id,
      when: 'in_15',
    });

  it('each kind: its own fields, A- or S- numbers, security told at once', async () => {
    const { unit, owner } = await home();
    const member = await x.family(s.c, unit.id, owner);
    const help = await post(owner, '/accessibility-requests', {
      unitId: unit.id,
      assistanceKind: 'wheelchair',
      memberId: member.memberId,
      fromPlaceId: places.main_gate.id,
      when: 'in_30',
    }).expect(201);
    expect(help.headers['cache-control']).toBe('no-store');
    const a = help.body as ServiceBody;
    expect(a).toMatchObject({
      kind: 'accessibility',
      status: 'open',
      assistanceKind: 'wheelchair',
      member: { id: member.memberId },
      fromPlace: { key: 'main_gate' },
      toPlace: null,
      when: 'in_30',
      minutesAway: null,
      handler: null,
      canCancel: true,
    });
    expect(a.reference).toMatch(/^A-\d{4,}$/);
    expect(
      new Date(a.wantedAt!).getTime() - new Date(a.createdAt).getTime(),
    ).toBeGreaterThanOrEqual(30 * 60_000 - 1_000);

    const report = (
      await post(owner, '/security-reports', {
        unitId: unit.id,
        placeId: places.clubhouse.id,
        description: '  Someone at the back fence  ',
      }).expect(201)
    ).body as ServiceBody;
    expect(report).toMatchObject({
      kind: 'suspicious',
      place: { key: 'clubhouse' },
      description: 'Someone at the back fence',
      photoUrl: null,
      when: null,
    });
    expect(report.reference).toMatch(/^S-\d{4,}$/);

    const walk = (await escort(owner, unit.id).expect(201)).body as ServiceBody;
    expect(walk).toMatchObject({
      kind: 'escort',
      fromPlace: { key: 'parking' },
      toPlace: { key: 'phase_b' },
      when: 'in_15',
    });
    expect(Number(walk.reference.slice(2))).toBe(
      Number(report.reference.slice(2)) + 1,
    );

    // The manager role handles gate services too.
    for (const r of [a, report, walk])
      for (const who of [guardA, guardB, handler, s.manager])
        expect(await x.told(s.c, who.id, r.id)).toEqual([
          { kind: 'gate_service.requested', params: { serviceKind: r.kind } },
        ]);
    expect(await x.told(s.c, owner.id, a.id)).toEqual([]);
    expect(await x.told(s.c, member.id, a.id)).toEqual([]);
    expect(await x.told(s.c, s.alice.id, a.id)).toEqual([]);
  });

  it('a lane: its gate’s guards first; with nobody there, every guard on shift', async () => {
    const { unit, owner } = await home();
    const lane = (
      await post(owner, '/lane-requests', {
        unitId: unit.id,
        reason: 'moving_truck',
        gateId: guardA.gateId,
        notes: 'Truck at 4 pm',
      }).expect(201)
    ).body as ServiceBody;
    expect(lane).toMatchObject({
      kind: 'lane',
      laneReason: 'moving_truck',
      gate: { id: guardA.gateId },
      notes: 'Truck at 4 pm',
    });
    expect(await x.told(s.c, guardA.id, lane.id)).toHaveLength(1);
    expect(await x.told(s.c, guardB.id, lane.id)).toEqual([]);
    expect(await x.told(s.c, handler.id, lane.id)).toHaveLength(1);
    const empty = await x.g.gate(s.c);
    const other = (
      await post(owner, '/lane-requests', {
        unitId: unit.id,
        reason: 'ambulance',
        gateId: empty.id,
      }).expect(201)
    ).body as ServiceBody;
    for (const g of [guardA, guardB])
      expect(await x.told(s.c, g.id, other.id)).toHaveLength(1);
  });

  it('what it names must be there: places in service, the household’s member, a gate in service, the caller’s photo', async () => {
    const { unit, owner } = await home();
    const retired = (
      await x
        .http('post', '/places', s.manager.token, {
          nameEn: 'Old pier',
          nameAr: 'الرصيف القديم',
        })
        .expect(201)
    ).body as { id: string };
    await x
      .http('patch', `/places/${retired.id}`, s.manager.token, {
        active: false,
      })
      .expect(200);
    const gone = await post(owner, '/escort-requests', {
      unitId: unit.id,
      fromPlaceId: retired.id,
      toPlaceId: places.phase_a.id,
      when: 'now',
    }).expect(404);
    expect(gone.body).toMatchObject({ code: 'PLACE_NOT_FOUND' });
    const other = await home();
    const stranger = await x.family(s.c, other.unit.id, other.owner);
    const notOurs = await post(owner, '/accessibility-requests', {
      unitId: unit.id,
      assistanceKind: 'walk_with',
      memberId: stranger.memberId,
      fromPlaceId: places.main_gate.id,
      when: 'now',
    }).expect(404);
    expect(notOurs.body).toMatchObject({ code: 'HOUSEHOLD_MEMBER_NOT_FOUND' });
    const closed = await x.g.gate(s.c);
    await x
      .http('patch', `/gates/${closed.id}`, s.manager.token, {
        status: 'inactive',
      })
      .expect(200);
    const noGate = await post(owner, '/lane-requests', {
      unitId: unit.id,
      reason: 'fire_truck',
      gateId: closed.id,
    }).expect(404);
    expect(noGate.body).toMatchObject({ code: 'GATE_NOT_FOUND' });
    const someoneElses = await x.files.ready(
      other.owner.token,
      'gate_service_photo',
    );
    const photo = await post(owner, '/security-reports', {
      unitId: unit.id,
      placeId: places.parking.id,
      description: 'Broken light',
      photoFileId: someoneElses,
    }).expect(400);
    expect(photo.body).toMatchObject({
      fields: [{ field: 'photoFileId', code: 'FILE_NOT_AVAILABLE' }],
    });
    const mine = await x.files.ready(owner.token, 'gate_service_photo');
    const withPhoto = (
      await post(owner, '/security-reports', {
        unitId: unit.id,
        placeId: places.parking.id,
        description: 'Broken light',
        photoFileId: mine,
      }).expect(201)
    ).body as ServiceBody;
    expect(withPhoto.photoUrl).toMatch(/^https?:\/\//);
    const blank = await post(owner, '/security-reports', {
      unitId: unit.id,
      placeId: places.parking.id,
      description: '   ',
    }).expect(400);
    expect(blank.body).toMatchObject({
      fields: [{ field: 'description', code: 'INVALID_LENGTH' }],
    });
  });

  it('someone who lives there asks; a landlord is refused; another unit is not found', async () => {
    const rented = await x.unit(s.c);
    const landlord = await x.landlord(s.c, rented.id);
    const tenant = await x.tenant(s.c, rented.id);
    const refused = await escort(landlord, rented.id).expect(403);
    expect(refused.body).toMatchObject({ code: 'GATE_SERVICE_NOT_ALLOWED' });
    await escort(tenant, rented.id).expect(201);
    const elsewhere = await escort(tenant, s.home.id).expect(404);
    expect(elsewhere.body).toMatchObject({ code: 'UNIT_NOT_FOUND' });
    await escort(guardA, s.home.id).expect(403);
  });

  it('three open of a kind per unit; a cancel frees one; another kind is apart', async () => {
    const { unit, owner } = await home();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        ((await escort(owner, unit.id).expect(201)).body as ServiceBody).id,
      );
    const fourth = await escort(owner, unit.id).expect(409);
    expect(fourth.body).toMatchObject({
      code: 'GATE_SERVICE_LIMIT_REACHED',
      params: { max: 3, scope: 'open' },
    });
    await post(owner, '/security-reports', {
      unitId: unit.id,
      placeId: places.other.id,
      description: 'Loud bang',
    }).expect(201);
    await x
      .http('post', `/gate-services/${ids[0]}/cancel`, owner.token)
      .expect(200);
    await escort(owner, unit.id).expect(201);
  });

  it('twenty a day per unit, all kinds together', async () => {
    const { unit, owner } = await home();
    await x.inTx(s.c, async (tx) => {
      for (let i = 0; i < 20; i++)
        await tx.gateServiceRequest.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            number: 800_000 + Math.floor(Math.random() * 99_999),
            kind: 'suspicious',
            status: 'cancelled',
            cancelledAt: new Date(),
            cancelSide: 'requester',
            unitId: unit.id,
            requestedById: owner.id,
            placeId: places.other.id,
            description: 'Filler',
          },
        });
    });
    const res = await escort(owner, unit.id).expect(409);
    expect(res.body).toMatchObject({
      code: 'GATE_SERVICE_LIMIT_REACHED',
      params: { max: 20, scope: 'day' },
    });
  });

  it('the requester follows, lists and cancels their own; nobody else sees them', async () => {
    const { unit, owner } = await home();
    const member = await x.family(s.c, unit.id, owner);
    const walk = (await escort(owner, unit.id).expect(201)).body as ServiceBody;
    const lane = (
      await post(owner, '/lane-requests', {
        unitId: unit.id,
        reason: 'large_delivery',
        gateId: guardB.gateId,
      }).expect(201)
    ).body as ServiceBody;
    expect(
      (
        await x
          .http('get', `/gate-services/${walk.id}`, owner.token)
          .expect(200)
      ).body,
    ).toMatchObject({ id: walk.id, status: 'open' });
    const res = await x
      .http('get', `/gate-services/${walk.id}`, member.token)
      .expect(404);
    expect(res.body).toMatchObject({ code: 'GATE_SERVICE_NOT_FOUND' });
    const list = async (q = '') =>
      (
        (await x.http('get', `/me/gate-services${q}`, owner.token).expect(200))
          .body as { data: ServiceBody[] }
      ).data.map((r) => r.id);
    expect(await list()).toEqual([lane.id, walk.id]);
    expect(await list('?kind=escort')).toEqual([walk.id]);
    await x
      .http('post', `/gate-services/${walk.id}/cancel`, member.token)
      .expect(404);
    const cancelled = await x
      .http('post', `/gate-services/${walk.id}/cancel`, owner.token)
      .expect(200);
    expect(cancelled.body).toMatchObject({
      status: 'cancelled',
      canCancel: false,
    });
    expect(await list('?status=open')).toEqual([lane.id]);
    const again = await x
      .http('post', `/gate-services/${walk.id}/cancel`, owner.token)
      .expect(409);
    expect(again.body).toMatchObject({
      code: 'GATE_SERVICE_NOT_OPEN',
      params: { status: 'cancelled' },
    });
  });

  it('is audited with ids, codes and booleans, never the words', async () => {
    const { unit, owner } = await home();
    const r = (
      await post(owner, '/security-reports', {
        unitId: unit.id,
        placeId: places.parking.id,
        description: 'Audit-hidden words',
      }).expect(201)
    ).body as ServiceBody;
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate_service.requested',
      targetId: r.id,
    });
    expect(row.metadata).toEqual({
      number: Number(r.reference.slice(2)),
      kind: 'suspicious',
      unitId: unit.id,
      placeId: places.parking.id,
      description: true,
      photo: false,
    });
    expect(JSON.stringify(row)).not.toContain('Audit-hidden');
  });
});
