import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { safetyHelpers, type PlaceBody, type Who } from '../setup/safety';

interface StaffService {
  id: string;
  kind: string;
  status: string;
  location: { unitCode: string };
  requestedBy: { id: string; firstName?: string | null };
  handledBy: { id: string } | null;
  isMine: boolean;
  etaMinutes: number | null;
  minutesAway: number | null;
  description: string | null;
  photoUrl: string | null;
  closeReason: string | null;
  closeNote: string | null;
}

/**
 * ADR 0047: security works the gate service requests — a guard inside an
 * open shift or a gate_services.handle holder. One accepts (with minutes
 * for help that comes to someone), starts and closes with a reason; the
 * requester is told of the acceptance and the close, and sees who comes.
 */
describe('Gate services — security', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof safetyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof safetyHelpers>['setUp']>>;
  let guard: Who & { gateId: string };
  let other: Who & { gateId: string };
  let handler: Who;
  let places: Record<string, PlaceBody>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = safetyHelpers(h);
    s = await x.setUp('Handling Court');
    guard = await x.guardOnDuty(s.c);
    other = await x.guardOnDuty(s.c);
    handler = await x.staff(s.c, ['gate_services.handle']);
    places = await x.places(s.alice);
    await x
      .http('patch', `/gates/${guard.gateId}`, s.manager.token, {
        phone: '+20225550180',
      })
      .expect(200);
  }, 120_000);

  afterAll(() => h.close());

  async function asked(kind: 'escort' | 'suspicious' = 'escort') {
    const unit = await x.unit(s.c);
    const owner = await x.owner(s.c, unit.id);
    const res =
      kind === 'escort'
        ? await x
            .http('post', '/escort-requests', owner.token, {
              unitId: unit.id,
              fromPlaceId: places.parking.id,
              toPlaceId: places.phase_b.id,
              when: 'now',
            })
            .expect(201)
        : await x
            .http('post', '/security-reports', owner.token, {
              unitId: unit.id,
              placeId: places.parking.id,
              description: 'A door left open',
              photoFileId: await x.files.ready(
                owner.token,
                'gate_service_photo',
              ),
            })
            .expect(201);
    return { unit, owner, id: (res.body as { id: string }).id };
  }
  const act = (who: Who, id: string, step: string, body: object = {}) =>
    x.http('post', `/gate/gate-services/${id}/${step}`, who.token, body);

  it('the queue: what was asked, the unit and a first name, the photo; never a phone', async () => {
    const { unit, owner, id } = await asked('suspicious');
    const list = (
      (
        await x
          .http('get', '/gate/gate-services?status=open', guard.token)
          .expect(200)
      ).body as { data: StaffService[] }
    ).data;
    const r = list.find((q) => q.id === id)!;
    expect(r).toMatchObject({
      kind: 'suspicious',
      location: { unitCode: unit.code },
      requestedBy: { id: owner.id },
      description: 'A door left open',
      handledBy: null,
    });
    expect(r.photoUrl).toMatch(/^https?:\/\//);
    const phone = (
      await x.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: owner.id } }),
      )
    ).phone!;
    expect(JSON.stringify(list)).not.toContain(phone);
    const idle = await x.who(s.c, (await x.g.guard(s.c)).id, 'staff');
    expect(
      (await x.http('get', '/gate/gate-services', idle.token).expect(403)).body,
    ).toMatchObject({ code: 'NO_OPEN_SHIFT' });
    await x.http('get', '/gate/gate-services', handler.token).expect(200);
  });

  it('an escort needs minutes; the first accept wins; the requester is told and sees who comes', async () => {
    const { owner, id } = await asked();
    const none = await act(guard, id, 'accept').expect(400);
    expect(none.body).toMatchObject({
      fields: [{ field: 'etaMinutes', code: 'FIELD_REQUIRED' }],
    });
    const ok = await act(guard, id, 'accept', { etaMinutes: 10 }).expect(200);
    expect(ok.body).toMatchObject({
      status: 'accepted',
      isMine: true,
      etaMinutes: 10,
      minutesAway: 10,
      handledBy: { id: guard.id },
    });
    const late = await act(other, id, 'accept', { etaMinutes: 2 }).expect(409);
    expect(late.body).toMatchObject({
      code: 'GATE_SERVICE_NOT_OPEN',
      params: { status: 'accepted' },
    });
    expect(await x.told(s.c, owner.id, id)).toEqual([
      {
        kind: 'gate_service.accepted',
        params: { serviceKind: 'escort', etaMinutes: 10 },
      },
    ]);
    const seen = (
      await x.http('get', `/gate-services/${id}`, owner.token).expect(200)
    ).body as {
      minutesAway: number;
      handler: { firstName: string; phone: string };
      canCancel: boolean;
    };
    expect(seen).toMatchObject({
      minutesAway: 10,
      handler: { firstName: 'Guard', phone: '+20225550180' },
      canCancel: false,
    });
    const refused = await x
      .http('post', `/gate-services/${id}/cancel`, owner.token)
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'GATE_SERVICE_NOT_OPEN' });
  });

  it('a report needs no minutes; only its handler starts it; started twice changes nothing', async () => {
    const { id } = await asked('suspicious');
    const early = await act(guard, id, 'start').expect(409);
    expect(early.body).toMatchObject({ code: 'GATE_SERVICE_NOT_ACCEPTED' });
    await act(guard, id, 'accept').expect(200);
    const notMine = await act(other, id, 'start').expect(403);
    expect(notMine.body).toMatchObject({ code: 'GATE_SERVICE_NOT_HANDLER' });
    await act(guard, id, 'start')
      .expect(200)
      .then((r) => expect(r.body).toMatchObject({ status: 'in_progress' }));
    await act(guard, id, 'start').expect(200);
  });

  it('closing: the handler, or a handle holder, with a reason and a note; anyone here for an open one; once', async () => {
    const a = await asked();
    await act(guard, a.id, 'accept', { etaMinutes: 5 }).expect(200);
    const notMine = await act(other, a.id, 'close', {
      reasonCode: 'done',
    }).expect(403);
    expect(notMine.body).toMatchObject({ code: 'GATE_SERVICE_NOT_HANDLER' });
    const closed = await act(guard, a.id, 'close', {
      reasonCode: 'done',
      note: '  Walked her to phase B  ',
    }).expect(200);
    expect(closed.body).toMatchObject({
      status: 'closed',
      closeReason: 'done',
      closeNote: 'Walked her to phase B',
      minutesAway: null,
    });
    expect((await x.told(s.c, a.owner.id, a.id)).map((n) => n.params)).toEqual([
      { serviceKind: 'escort', etaMinutes: 5 },
      { serviceKind: 'escort', reason: 'done' },
    ]);
    const mine = (
      await x.http('get', `/gate-services/${a.id}`, a.owner.token).expect(200)
    ).body as Record<string, unknown>;
    expect(mine).toMatchObject({ status: 'closed', closeReason: 'done' });
    expect(JSON.stringify(mine)).not.toContain('Walked her');
    const again = await act(guard, a.id, 'close', {
      reasonCode: 'done',
    }).expect(409);
    expect(again.body).toMatchObject({ code: 'GATE_SERVICE_CLOSED' });

    const b = await asked();
    await act(other, b.id, 'accept', { etaMinutes: 2 }).expect(200);
    await act(handler, b.id, 'close', { reasonCode: 'no_show' }).expect(200);

    const c = await asked();
    await act(other, c.id, 'close', { reasonCode: 'duplicate' }).expect(200);
    const bad = await act(guard, (await asked()).id, 'close', {
      reasonCode: 'vanished',
    }).expect(400);
    expect(bad.body).toMatchObject({
      fields: [{ field: 'reasonCode', code: 'INVALID_REASON_CODE' }],
    });
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate_service.closed',
      targetId: a.id,
    });
    expect(row.metadata).toEqual({
      from: 'accepted',
      reasonCode: 'done',
      note: true,
    });
    expect(JSON.stringify(row)).not.toContain('Walked');
  });
});
