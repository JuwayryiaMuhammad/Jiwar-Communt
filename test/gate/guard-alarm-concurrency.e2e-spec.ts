import { randomUUID } from 'node:crypto';
import { EMERGENCY_ESCALATION_SWEEP } from '../../src/gate/emergencies/emergency-escalation';
import {
  FAKE_ALARM_SIGNATURE_HEADER,
  signFakeAlarm,
} from '../../src/gate/alarms/fake-alarm-driver';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { auditReaders } from '../setup/audit';
import { rewindEmergency } from '../setup/safety-rows';
import { securityOpsHelpers, type Who } from '../setup/security-ops';
import { whileShiftEnds } from '../setup/shift-end';

const MIN = 60_000;

/**
 * ADR 0068, the guard-down alarms' races. The same vendor event twice at
 * once is taken once: one row, one emergency. An alarm while its guard's
 * shift ends waits for the end and reaches the control room — never lost.
 * A pairing while the shift ends is refused. Two devices at one post raise
 * one emergency of a type: the SOS core's lock of the post decides. The
 * vendor's cancel against the escalation sweep: asked once, escalated at
 * most once, and the emergency stays open either way (the sweep skips a
 * row the cancel holds).
 */
describe('Gate — guard-down alarms (races)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let keeper: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Alarm Race Court');
    keeper = await x.supervisor(s.c);
  }, 120_000);

  afterAll(() => h.close());

  async function paired(guard: Who) {
    const d = (
      await x
        .http('post', '/staff/gate/alarm-devices', keeper.token, {
          deviceRef: `dev-${randomUUID()}`,
          label: 'Vest',
        })
        .expect(201)
    ).body as { id: string; deviceRef: string };
    await x
      .http('post', '/gate/alarm-devices/pair', guard.token, {
        deviceId: d.id,
      })
      .expect(200);
    return d;
  }
  const send = (body: Record<string, unknown>) =>
    h
      .http()
      .post(`${API}/public/gate/alarms/${s.c.tenantId}`)
      .set(FAKE_ALARM_SIGNATURE_HEADER, signFakeAlarm(body))
      .send(body);
  const alarm = (deviceRef: string, kind = 'panic') => ({
    eventId: randomUUID(),
    deviceRef,
    kind,
    at: new Date().toISOString(),
  });
  const rows = (deviceRef: string) =>
    x.inTx(s.c, (tx) => tx.guardAlarmEvent.findMany({ where: { deviceRef } }));

  it('the same event twice at once: one row, one emergency', async () => {
    const guard = await x.guardOnDuty(s.c);
    const d = await paired(guard);
    const body = alarm(d.deviceRef);
    const both = await Promise.all([send(body), send(body)]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    const [row, ...more] = await rows(d.deviceRef);
    expect(more).toEqual([]);
    expect(row.outcome).toBe('raised');
    expect(
      await x.inTx(s.c, (tx) =>
        tx.emergency.count({ where: { originShiftId: guard.shiftId } }),
      ),
    ).toBe(1);
  });

  it('an alarm while the shift ends waits, and reaches the control room', async () => {
    const guard = await x.guardOnDuty(s.c);
    const d = await paired(guard);
    const res = await whileShiftEnds(guard.shiftId, () =>
      send(alarm(d.deviceRef)),
    );
    expect(res.status).toBe(200);
    const [row] = await rows(d.deviceRef);
    expect(row).toMatchObject({ outcome: 'unpaired', emergencyId: null });
    expect(
      await x.inTx(s.c, (tx) =>
        tx.controlRoomEvent.count({
          where: { sourceId: row.id, kind: 'guard_alarm_unpaired' },
        }),
      ),
    ).toBe(1);
  });

  it('a pairing while the shift ends is refused', async () => {
    const guard = await x.guardOnDuty(s.c);
    const d = (
      await x
        .http('post', '/staff/gate/alarm-devices', keeper.token, {
          deviceRef: `dev-${randomUUID()}`,
          label: 'Vest',
        })
        .expect(201)
    ).body as { id: string };
    const res = await whileShiftEnds(guard.shiftId, () =>
      x.http('post', '/gate/alarm-devices/pair', guard.token, {
        deviceId: d.id,
      }),
    );
    expect(res.status).toBe(403);
    expect(
      await x.inTx(s.c, (tx) =>
        tx.guardAlarmPairing.count({ where: { deviceId: d.id } }),
      ),
    ).toBe(0);
  });

  it('the vendor’s cancel against the escalation: asked once, escalated at most once, still open', async () => {
    const guard = await x.guardOnDuty(s.c);
    // Someone else on shift: the alarm is not escalated as it is raised.
    await x.guardAt(s.c, guard.gateId);
    const d = await paired(guard);
    expect((await send(alarm(d.deviceRef))).status).toBe(200);
    const [raised] = await rows(d.deviceRef);
    const id = raised.emergencyId!;
    await rewindEmergency(id, 2.1 * MIN);
    const [cancel] = await Promise.all([
      send(alarm(d.deviceRef, 'cancelled')),
      x.sweep(EMERGENCY_ESCALATION_SWEEP),
    ]);
    expect(cancel.status).toBe(200);
    const e = await x.inTx(s.c, (tx) =>
      tx.emergency.findUniqueOrThrow({ where: { id } }),
    );
    expect(e.status).toBe('reported');
    expect(e.cancelRequestedAt).not.toBeNull();
    const audit = auditReaders(h);
    const asked = await audit.tenant(s.c.tenantId, {
      action: 'emergency.cancel_requested',
      targetId: id,
    });
    const escalated = await audit.tenant(s.c.tenantId, {
      action: 'emergency.escalated',
      targetId: id,
    });
    expect(asked).toHaveLength(1);
    expect(escalated.length).toBe(e.escalatedAt ? 1 : 0);
    expect((await rows(d.deviceRef)).map((r) => r.outcome).sort()).toEqual([
      'cancel_requested',
      'raised',
    ]);
  });

  it('two devices at one post at once raise one emergency of a type', async () => {
    const one = await x.guardOnDuty(s.c);
    const two = await x.guardAt(s.c, one.gateId);
    const [a, b] = [await paired(one), await paired(two)];
    await Promise.all([send(alarm(a.deviceRef)), send(alarm(b.deviceRef))]);
    const outcomes = [
      ...(await rows(a.deviceRef)),
      ...(await rows(b.deviceRef)),
    ];
    expect(outcomes.map((r) => r.outcome).sort()).toEqual(['joined', 'raised']);
    expect(new Set(outcomes.map((r) => r.emergencyId)).size).toBe(1);
  });
});
