import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { safetyHelpers, type PlaceBody, type Who } from '../setup/safety';

/**
 * ADR 0047: what happens at once. A unit's limits hold however many
 * requests arrive together (its lock); a handler's accept and the
 * requester's cancel leave one consistent outcome.
 */
describe('Gate services — concurrency', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof safetyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof safetyHelpers>['setUp']>>;
  let places: Record<string, PlaceBody>;
  let guards: Who[];

  beforeAll(async () => {
    h = await createHttpHarness();
    x = safetyHelpers(h);
    s = await x.setUp('Services Race Court');
    places = await x.places(s.alice);
    guards = [];
    for (let i = 0; i < 3; i++) guards.push(await x.guardOnDuty(s.c));
  }, 120_000);

  afterAll(() => h.close());

  const escort = (who: Who, unitId: string) =>
    x.http('post', '/escort-requests', who.token, {
      unitId,
      fromPlaceId: places.parking.id,
      toPlaceId: places.phase_a.id,
      when: 'now',
    });

  it('six escorts at once from one home: three made, three refused', async () => {
    const unit = await x.unit(s.c);
    const owner = await x.owner(s.c, unit.id);
    const members = [owner];
    for (let i = 0; i < 2; i++)
      members.push(await x.family(s.c, unit.id, owner));
    const res = await Promise.all(
      [...members, ...members].map((m) => escort(m, unit.id)),
    );
    expect(res.map((r) => r.status).sort()).toEqual([
      201, 201, 201, 409, 409, 409,
    ]);
    expect(
      await x.inTx(s.c, (tx) =>
        tx.gateServiceRequest.count({
          where: { unitId: unit.id, kind: 'escort' },
        }),
      ),
    ).toBe(3);
  });

  it('three guards accept at once: one handler', async () => {
    const unit = await x.unit(s.c);
    const owner = await x.owner(s.c, unit.id);
    const { id } = (await escort(owner, unit.id).expect(201)).body as {
      id: string;
    };
    const res = await Promise.all(
      guards.map((g) =>
        x.http('post', `/gate/gate-services/${id}/accept`, g.token, {
          etaMinutes: 5,
        }),
      ),
    );
    expect(res.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(
      (await x.told(s.c, owner.id, id)).filter(
        (n) => n.kind === 'gate_service.accepted',
      ),
    ).toHaveLength(1);
  });

  it('a cancel racing an accept: one of them, never both', async () => {
    for (let round = 0; round < 3; round++) {
      const unit = await x.unit(s.c);
      const owner = await x.owner(s.c, unit.id);
      const { id } = (await escort(owner, unit.id).expect(201)).body as {
        id: string;
      };
      const [cancel, accept] = await Promise.all([
        x.http('post', `/gate-services/${id}/cancel`, owner.token),
        x.http('post', `/gate/gate-services/${id}/accept`, guards[0].token, {
          etaMinutes: 2,
        }),
      ]);
      expect([cancel.status, accept.status].sort()).toEqual([200, 409]);
      const row = await x.inTx(s.c, (tx) =>
        tx.gateServiceRequest.findUniqueOrThrow({ where: { id } }),
      );
      expect(row.status).toBe(cancel.status === 200 ? 'cancelled' : 'accepted');
    }
  });
});
