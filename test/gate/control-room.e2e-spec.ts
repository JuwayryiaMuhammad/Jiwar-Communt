import { EMERGENCY_ESCALATION_SWEEP } from '../../src/gate/emergencies/emergency-escalation';
import { CONTROL_ROOM_DELIVERY_SWEEP } from '../../src/gate/control-room/control-room';
import { CONTROL_ROOM_DRIVER } from '../../src/gate/control-room/control-room-driver';
import type { FakeControlRoomDriver } from '../../src/gate/control-room/fake-control-room-driver';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { rewindEmergency } from '../setup/safety-rows';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

const MIN = 60_000;

interface Event {
  id: string;
  kind: string;
  severity: string;
  sourceType: string;
  sourceId: string;
  gateId: string | null;
  shiftId: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: { id: string } | null;
}

/**
 * ADR 0068: the control room's channel. A source writes its event in its
 * own transaction and the `control_room.watch` holders are told there — an
 * alert critically, never its actor; the watchers read the feed, take an
 * event once, and read the posts at a glance; a sweep delivers each event
 * to the vendor once, keyed by its id. Ids and codes only. A guard's SOS
 * is an alert when raised (GuardSosService) and again when escalated.
 */
describe('Gate — the control room', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let guard: Who & { gateId: string; shiftId: string };
  let watcher: Who;
  let vendor: FakeControlRoomDriver;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Control Room Court');
    guard = await x.guardOnDuty(s.c);
    watcher = await x.supervisor(s.c);
    vendor = h.moduleRef.get<FakeControlRoomDriver>(CONTROL_ROOM_DRIVER);
  }, 120_000);

  afterAll(() => h.close());

  const feed = async (query = '') =>
    (
      await x
        .http('get', `/staff/control-room/events${query}`, watcher.token)
        .expect(200)
    ).body as { data: Event[] };
  const eventsOf = async (sourceId: string) =>
    (await feed()).data.filter((e) => e.sourceId === sourceId);
  const eventOf = async (sourceId: string, kind?: string) =>
    (await eventsOf(sourceId)).find((e) => !kind || e.kind === kind)!;
  const toldOf = (who: Who, targetId: string) =>
    x.inTx(s.c, (tx) =>
      tx.notification.findMany({ where: { accountId: who.id, targetId } }),
    );

  it('a lockdown: an alert to the watchers, never to who started it; its end an event', async () => {
    const l = await x.lockdown(guard);
    const started = await eventOf(l.id);
    expect(started).toMatchObject({
      kind: 'lockdown_started',
      severity: 'high',
      sourceType: 'lockdown',
      shiftId: guard.shiftId,
      acknowledgedAt: null,
    });
    expect(
      (await toldOf(watcher, started.id)).map((n) => [n.kind, n.params]),
    ).toEqual([['control_room.alert', { eventKind: 'lockdown_started' }]]);
    expect(await toldOf(guard, started.id)).toEqual([]);
    expect(await toldOf(s.manager, started.id)).toEqual([]);
    await x.endLockdownRaw(s.manager, l.id).expect(200);
    const ended = (await feed()).data.find(
      (e) => e.sourceId === l.id && e.kind === 'lockdown_ended',
    )!;
    expect(ended).toMatchObject({ severity: 'normal' });
    expect((await toldOf(watcher, ended.id)).map((n) => n.kind)).toEqual([
      'control_room.event',
    ]);
  });

  it('a guard’s SOS raised: an alert from its post, once — a repeat publishes nothing, the guard is never told', async () => {
    // A post of its own, with a colleague on shift: a responder, so the SOS
    // is not escalated as it is raised (that is the next case's).
    const raiser = await x.guardOnDuty(s.c);
    await x.guardAt(s.c, raiser.gateId);
    const sos = await x.sos(raiser, 'security');
    const raised = await eventOf(sos.id, 'guard_sos_raised');
    expect(raised).toMatchObject({
      kind: 'guard_sos_raised',
      severity: 'high',
      sourceType: 'emergency',
      gateId: raiser.gateId,
      shiftId: raiser.shiftId,
      acknowledgedAt: null,
    });
    expect(
      (await toldOf(watcher, raised.id)).map((n) => [n.kind, n.params]),
    ).toEqual([['control_room.alert', { eventKind: 'guard_sos_raised' }]]);
    expect(await toldOf(raiser, raised.id)).toEqual([]);

    // The same SOS again is the open one (200): no second event.
    const again = await x.sosRaw(raiser, 'security').expect(200);
    expect((again.body as { id: string }).id).toBe(sos.id);
    expect((await eventsOf(sos.id)).map((e) => e.kind)).toEqual([
      'guard_sos_raised',
    ]);
    await x
      .http('post', `/gate/emergencies/${sos.id}/cancel`, raiser.token, {})
      .expect(200);
  });

  it('a ban met at the gate is an alert, a watch an event; a guard’s SOS left unanswered is escalated there too', async () => {
    const id = '29001011266001';
    await x.block(s.manager, {
      subject: 'person',
      fullName: 'Watched Room Person',
      idNumber: id,
      kind: 'ban',
    });
    await x
      .http('post', '/gate/id-lookup', guard.token, { idNumber: id })
      .expect(200);
    const [match] = await x.inTx(s.c, (tx) =>
      tx.blocklistMatch.findMany({
        where: { shiftId: guard.shiftId, source: 'id_lookup' },
      }),
    );
    expect(await eventOf(match.id)).toMatchObject({
      kind: 'blocklist_match',
      severity: 'high',
      gateId: guard.gateId,
    });

    const sos = await x.sos(guard, 'medical');
    await rewindEmergency(sos.id, 2.1 * MIN);
    await x.sweep(EMERGENCY_ESCALATION_SWEEP);
    expect(await eventOf(sos.id, 'guard_sos_escalated')).toMatchObject({
      kind: 'guard_sos_escalated',
      severity: 'high',
      sourceType: 'emergency',
      gateId: guard.gateId,
    });
  });

  it('acknowledged once, by whoever watches; the second is told who came first; audited by codes', async () => {
    const l = await x.lockdown(guard, {
      scope: 'gate',
      gateId: guard.gateId,
      reasonCode: 'intruder',
    });
    const e = await eventOf(l.id);
    const other = await x.supervisor(s.c);
    const done = (
      await x
        .http(
          'post',
          `/staff/control-room/events/${e.id}/acknowledge`,
          watcher.token,
        )
        .expect(200)
    ).body as Event;
    expect(done).toMatchObject({ acknowledgedBy: { id: watcher.id } });
    const again = await x
      .http(
        'post',
        `/staff/control-room/events/${e.id}/acknowledge`,
        other.token,
      )
      .expect(409);
    expect(again.body).toMatchObject({
      code: 'CONTROL_ROOM_EVENT_ACKNOWLEDGED',
      params: { acknowledgedAt: done.acknowledgedAt },
    });
    expect((await feed('?status=open')).data.map((x) => x.id)).not.toContain(
      e.id,
    );
    expect(
      (await feed('?status=acknowledged')).data.map((x) => x.id),
    ).toContain(e.id);
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'control_room_event.acknowledged',
      targetId: e.id,
    });
    expect(row).toMatchObject({
      actorId: watcher.id,
      metadata: { kind: 'lockdown_started', severity: 'high' },
    });
    await x.endLockdownRaw(s.manager, l.id).expect(200);
  });

  it('the posts at a glance: each gate, its shift and guard, whether it is locked down, what is open there', async () => {
    const l = await x.lockdown(guard, {
      scope: 'gate',
      gateId: guard.gateId,
      reasonCode: 'intruder',
    });
    const posts = (
      await x
        .http('get', '/staff/control-room/posts', watcher.token)
        .expect(200)
    ).body as {
      data: {
        kind: string;
        id: string;
        shift: { id: string; guard: { id: string } } | null;
        lockedDown: boolean;
        openEmergencies: number;
      }[];
    };
    const mine = posts.data.find((p) => p.id === guard.gateId)!;
    expect(mine).toMatchObject({
      kind: 'gate',
      shift: { id: guard.shiftId, guard: { id: guard.id } },
      lockedDown: true,
    });
    expect(mine.openEmergencies).toBeGreaterThanOrEqual(1);
    await x.endLockdownRaw(s.manager, l.id).expect(200);
    // Only the watchers: a guard and the manager by default are refused.
    await x.http('get', '/staff/control-room/posts', guard.token).expect(403);
    await x
      .http('get', '/staff/control-room/posts', s.manager.token)
      .expect(403);
  });

  it('delivered to the vendor once, keyed by its id, ids and codes only; a failure waits and is tried again', async () => {
    // What came before is delivered first, so the failure below is this one's.
    await x.sweep(CONTROL_ROOM_DELIVERY_SWEEP);
    const l = await x.lockdown(guard, {
      scope: 'gate',
      gateId: guard.gateId,
      reasonCode: 'intruder',
    });
    const e = await eventOf(l.id);
    vendor.failNext('timeout');
    await x.sweep(CONTROL_ROOM_DELIVERY_SWEEP);
    const failed = await x.inTx(s.c, (tx) =>
      tx.controlRoomEvent.findUniqueOrThrow({ where: { id: e.id } }),
    );
    expect(failed).toMatchObject({
      delivery: 'pending',
      deliveryAttempts: 1,
      lastError: 'timeout',
    });
    await x.inTx(s.c, (tx) =>
      tx.controlRoomEvent.update({
        where: { id: e.id },
        data: { nextDeliveryAt: new Date(Date.now() - 1000) },
      }),
    );
    await x.sweep(CONTROL_ROOM_DELIVERY_SWEEP);
    await x.sweep(CONTROL_ROOM_DELIVERY_SWEEP);
    expect(vendor.received.get(e.id)).toMatchObject({
      tenantId: s.c.tenantId,
      times: 1,
      event: { eventId: e.id, kind: 'lockdown_started', severity: 'high' },
    });
    expect(
      await x.inTx(s.c, (tx) =>
        tx.controlRoomEvent.findUniqueOrThrow({ where: { id: e.id } }),
      ),
    ).toMatchObject({ delivery: 'delivered' });
    expect(leakText(vendor.received.get(e.id))).not.toMatch(
      /Guard \w+|Watched/,
    );
    await x.endLockdownRaw(s.manager, l.id).expect(200);
  });
});
