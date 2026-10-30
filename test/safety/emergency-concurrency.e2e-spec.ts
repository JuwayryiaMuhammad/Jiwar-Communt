import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { safetyHelpers, type EmergencyBody, type Who } from '../setup/safety';
import { whileShiftEnds } from '../setup/shift-end';

/**
 * ADR 0047: what two people do at once. Reports of one type from one unit
 * make one emergency; responders racing to accept make one responder; a
 * cancel racing an accept leaves one consistent outcome.
 *
 * A guard's write while their shift ends (ADR 0056's lock order): their
 * SOS, and a responder's accept, arrival and resolution, take the account,
 * then the shift, FOR SHARE, so each waits for the end and is refused.
 */
describe('Emergencies — concurrency', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof safetyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof safetyHelpers>['setUp']>>;
  let guards: Who[];

  beforeAll(async () => {
    h = await createHttpHarness();
    x = safetyHelpers(h);
    s = await x.setUp('Race Court');
    guards = [];
    for (let i = 0; i < 4; i++) guards.push(await x.guardOnDuty(s.c));
  }, 120_000);

  afterAll(() => h.close());

  it('five reports at once from one home make one emergency, told once', async () => {
    const home = await x.unit(s.c);
    const owner = await x.owner(s.c, home.id);
    const members = [owner];
    for (let i = 0; i < 4; i++)
      members.push(await x.family(s.c, home.id, owner));
    const all = await Promise.all(
      members.map((m) => x.reportRaw(m, home.id, 'fire')),
    );
    const ids = new Set(all.map((r) => (r.body as EmergencyBody).id));
    expect(ids.size).toBe(1);
    expect(all.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    const [id] = [...ids];
    expect(
      await x.inTx(s.c, (tx) =>
        tx.emergency.count({ where: { unitId: home.id, type: 'fire' } }),
      ),
    ).toBe(1);
    for (const g of guards) expect(await x.told(s.c, g.id, id)).toHaveLength(1);
  });

  it('four guards accept at once: one responder, three 409s', async () => {
    const home = await x.unit(s.c);
    const owner = await x.owner(s.c, home.id);
    const e = await x.report(owner, home.id, 'medical');
    const res = await Promise.all(
      guards.map((g) =>
        x.http('post', `/gate/emergencies/${e.id}/accept`, g.token, {
          etaMinutes: 5,
        }),
      ),
    );
    expect(res.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    const winner = guards[res.findIndex((r) => r.status === 200)];
    const row = await x.inTx(s.c, (tx) =>
      tx.emergency.findUniqueOrThrow({ where: { id: e.id } }),
    );
    expect(row.responderId).toBe(winner.id);
    expect(
      (await x.told(s.c, owner.id, e.id)).filter(
        (n) => n.kind === 'emergency.responder_on_the_way',
      ),
    ).toHaveLength(1);
  });

  it('a cancel racing an accept: either cancelled with nobody on the way, or accepted then cancelled', async () => {
    for (let round = 0; round < 3; round++) {
      const home = await x.unit(s.c);
      const owner = await x.owner(s.c, home.id);
      const e = await x.report(owner, home.id, 'security');
      const [cancel, acc] = await Promise.all([
        x.http('post', `/emergencies/${e.id}/cancel`, owner.token, {}),
        x.http('post', `/gate/emergencies/${e.id}/accept`, guards[0].token, {
          etaMinutes: 2,
        }),
      ]);
      expect(cancel.status).toBe(200);
      const row = await x.inTx(s.c, (tx) =>
        tx.emergency.findUniqueOrThrow({ where: { id: e.id } }),
      );
      expect(row.status).toBe('cancelled');
      if (acc.status === 200) expect(row.responderId).toBe(guards[0].id);
      else {
        expect(acc.status).toBe(409);
        expect(row.responderId).toBeNull();
      }
    }
  });

  describe('a guard’s write while their shift ends: it waits for the end, then is refused', () => {
    const refused = (res: { status: number; body: unknown }) =>
      expect(res).toMatchObject({
        status: 403,
        body: { code: 'NO_OPEN_SHIFT' },
      });
    const emergency = (id: string) =>
      x.inTx(s.c, (tx) => tx.emergency.findUniqueOrThrow({ where: { id } }));
    /** A medical emergency at a fresh home, accepted by `leaving` if asked. */
    const reported = async (accepted?: Who) => {
      const home = await x.unit(s.c);
      const e = await x.report(await x.owner(s.c, home.id), home.id, 'medical');
      if (accepted)
        await x
          .http('post', `/gate/emergencies/${e.id}/accept`, accepted.token, {
            etaMinutes: 5,
          })
          .expect(200);
      return e.id;
    };

    it('a guard’s SOS', async () => {
      const leaving = await x.guardOnDuty(s.c);
      refused(
        await whileShiftEnds(leaving.shiftId, () =>
          x.http('post', '/gate/emergencies', leaving.token, {
            type: 'security',
          }),
        ),
      );
      expect(
        await x.inTx(s.c, (tx) =>
          tx.emergency.count({ where: { originShiftId: leaving.shiftId } }),
        ),
      ).toBe(0);
    });

    it('an accept', async () => {
      const leaving = await x.guardOnDuty(s.c);
      const id = await reported();
      refused(
        await whileShiftEnds(leaving.shiftId, () =>
          x.http('post', `/gate/emergencies/${id}/accept`, leaving.token, {
            etaMinutes: 5,
          }),
        ),
      );
      expect(await emergency(id)).toMatchObject({
        status: 'reported',
        responderId: null,
      });
    });

    it('an arrival', async () => {
      const leaving = await x.guardOnDuty(s.c);
      const id = await reported(leaving);
      refused(
        await whileShiftEnds(leaving.shiftId, () =>
          x.http('post', `/gate/emergencies/${id}/arrived`, leaving.token),
        ),
      );
      expect((await emergency(id)).status).toBe('on_the_way');
    });

    it('a resolution', async () => {
      const leaving = await x.guardOnDuty(s.c);
      const id = await reported(leaving);
      refused(
        await whileShiftEnds(leaving.shiftId, () =>
          x.http('post', `/gate/emergencies/${id}/resolve`, leaving.token, {
            reasonCode: 'handled',
          }),
        ),
      );
      expect((await emergency(id)).status).toBe('on_the_way');
    });
  });
});
