import { CONTROL_ROOM_DELIVERY_SWEEP } from '../../src/gate/control-room/control-room';
import { CONTROL_ROOM_DRIVER } from '../../src/gate/control-room/control-room-driver';
import type { FakeControlRoomDriver } from '../../src/gate/control-room/fake-control-room-driver';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type Who } from '../setup/security-ops';
import { whileShiftEnds } from '../setup/shift-end';

/**
 * ADR 0068, the control room's races. An event is its source's: a source
 * that rolls back leaves none, and two guards' SOS at once from one post
 * are one emergency and one alert. Two watchers acknowledging at once: one
 * wins. Two delivery sweeps at once: delivered once (SKIP LOCKED and the
 * lease).
 */
describe('Gate — the control room (races)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let watcher: Who;
  let vendor: FakeControlRoomDriver;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Control Room Race Court');
    watcher = await x.supervisor(s.c);
    vendor = h.moduleRef.get<FakeControlRoomDriver>(CONTROL_ROOM_DRIVER);
  }, 120_000);

  afterAll(() => h.close());

  const events = () => x.inTx(s.c, (tx) => tx.controlRoomEvent.findMany({}));

  it('a lockdown refused by its shift’s end leaves no event', async () => {
    const leaving = await x.guardOnDuty(s.c);
    const before = (await events()).length;
    const res = await whileShiftEnds(leaving.shiftId, () =>
      x.lockdownRaw(leaving, {
        scope: 'gate',
        gateId: leaving.gateId,
        reasonCode: 'intruder',
      }),
    );
    expect(res.status).toBe(403);
    expect((await events()).length).toBe(before);
  });

  it('two guards’ SOS at once from one post: one emergency, one alert', async () => {
    const one = await x.guardOnDuty(s.c);
    const two = await x.guardAt(s.c, one.gateId);
    const both = await Promise.all([
      x.sosRaw(one, 'security'),
      x.sosRaw(two, 'security'),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    const ids = [...new Set(both.map((r) => (r.body as { id: string }).id))];
    expect(ids).toHaveLength(1);
    expect(
      (await events()).filter((e) => e.sourceId === ids[0]).map((e) => e.kind),
    ).toEqual(['guard_sos_raised']);
  });

  it('an SOS refused by its shift’s end leaves no alert', async () => {
    const leaving = await x.guardOnDuty(s.c);
    const before = (await events()).length;
    const res = await whileShiftEnds(leaving.shiftId, () =>
      x.sosRaw(leaving, 'medical'),
    );
    expect(res.status).toBe(403);
    expect((await events()).length).toBe(before);
  });

  it('two watchers acknowledge at once: one wins', async () => {
    const guard = await x.guardOnDuty(s.c);
    const l = await x.lockdown(guard, {
      scope: 'gate',
      gateId: guard.gateId,
      reasonCode: 'intruder',
    });
    const e = (await events()).find((r) => r.sourceId === l.id)!;
    const other = await x.supervisor(s.c);
    const both = await Promise.all(
      [watcher, other].map((w) =>
        x.http(
          'post',
          `/staff/control-room/events/${e.id}/acknowledge`,
          w.token,
        ),
      ),
    );
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    await x.endLockdownRaw(s.manager, l.id).expect(200);
  });

  it('two delivery sweeps at once deliver each event once', async () => {
    const pending = (await events()).filter((e) => e.delivery === 'pending');
    expect(pending.length).toBeGreaterThan(0);
    await Promise.all([
      x.sweep(CONTROL_ROOM_DELIVERY_SWEEP),
      x.sweep(CONTROL_ROOM_DELIVERY_SWEEP),
    ]);
    for (const e of pending)
      expect([e.id, vendor.received.get(e.id)?.times]).toEqual([e.id, 1]);
  });
});
