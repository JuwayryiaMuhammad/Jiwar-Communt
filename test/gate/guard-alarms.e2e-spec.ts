import { randomUUID } from 'node:crypto';
import {
  FAKE_ALARM_SIGNATURE_HEADER,
  signFakeAlarm,
} from '../../src/gate/alarms/fake-alarm-driver';
import { auditReaders } from '../setup/audit';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

interface Device {
  id: string;
  deviceRef: string;
  label: string;
  status: string;
  pairing: { guard: { id: string }; shiftId: string } | null;
}

/**
 * ADR 0068: a guard-down alarm. The management registers the vendor's
 * wearables; a guard on shift pairs one; its fall, stillness or panic
 * raises the guard's SOS for them from the post — through the staff's SOS
 * core, told and escalated as theirs — and the control room hears of it.
 * A replay is a no-op; an unpaired device reaches the control room only;
 * the vendor's cancel asks, and the emergency stays open. Every refusal is
 * the same 401.
 */
const codeOf = (res: { body: unknown }) => (res.body as { code?: string }).code;
const fieldsOf = (res: { body: unknown }) =>
  (res.body as { fields?: unknown }).fields;

describe('Gate — guard-down alarms', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let keeper: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Alarm Court');
    keeper = await x.supervisor(s.c);
  }, 120_000);

  afterAll(() => h.close());

  async function device(label = 'Vest'): Promise<Device> {
    return (
      await x
        .http('post', '/staff/gate/alarm-devices', keeper.token, {
          deviceRef: `dev-${randomUUID()}`,
          label,
        })
        .expect(201)
    ).body as Device;
  }
  const pair = (guard: Who, deviceId: string) =>
    x.http('post', '/gate/alarm-devices/pair', guard.token, { deviceId });
  function send(
    body: Record<string, unknown>,
    compoundId = s.c.tenantId,
    signature = signFakeAlarm(body),
  ) {
    return h
      .http()
      .post(`${API}/public/gate/alarms/${compoundId}`)
      .set(FAKE_ALARM_SIGNATURE_HEADER, signature)
      .send(body);
  }
  const alarm = (deviceRef: string, kind: string, eventId = randomUUID()) => ({
    eventId,
    deviceRef,
    kind,
    at: new Date().toISOString(),
  });
  const eventRow = (deviceRef: string, vendorEventId: string) =>
    x.inTx(s.c, (tx) =>
      tx.guardAlarmEvent.findFirstOrThrow({
        where: { deviceRef, vendorEventId },
      }),
    );

  it('registered by the management, one live device a reference; renamed; paired by a guard on shift for the shift', async () => {
    const d = await device();
    expect(d).toMatchObject({ status: 'active', pairing: null });
    expect(
      fieldsOf(
        await x
          .http('post', '/staff/gate/alarm-devices', keeper.token, {
            deviceRef: d.deviceRef,
            label: 'Again',
          })
          .expect(409),
      ),
    ).toEqual([{ field: 'deviceRef', code: 'DUPLICATE_VALUE' }]);
    await x
      .http('patch', `/staff/gate/alarm-devices/${d.id}`, keeper.token, {
        label: 'North vest',
      })
      .expect(200);
    const guard = await x.guardOnDuty(s.c);
    expect((await pair(guard, d.id).expect(200)).body).toMatchObject({
      id: d.id,
      label: 'North vest',
      shiftId: guard.shiftId,
    });
    const listed = (
      await x.http('get', '/staff/gate/alarm-devices', keeper.token).expect(200)
    ).body as { data: Device[] };
    expect(listed.data.find((r) => r.id === d.id)).toMatchObject({
      pairing: { guard: { id: guard.id }, shiftId: guard.shiftId },
    });
    // Off shift: no pairing.
    const off = await x.guard(s.c);
    expect(codeOf(await pair(off, d.id).expect(403))).toBe('NO_OPEN_SHIFT');
  });

  it('a panic raises the guard’s SOS from the post, told as theirs; the control room hears; a replay is a no-op', async () => {
    const guard = await x.guardOnDuty(s.c);
    const d = await device();
    await pair(guard, d.id).expect(200);
    const body = alarm(d.deviceRef, 'panic');
    expect((await send(body).expect(200)).body).toEqual({ ok: true });
    const ev = await eventRow(d.deviceRef, body.eventId);
    expect(ev).toMatchObject({
      outcome: 'raised',
      kind: 'panic',
      guardAccountId: guard.id,
    });
    const e = await x.inTx(s.c, (tx) =>
      tx.emergency.findUniqueOrThrow({ where: { id: ev.emergencyId! } }),
    );
    expect(e).toMatchObject({
      type: 'security',
      originGateId: guard.gateId,
      originShiftId: guard.shiftId,
      reportedById: guard.id,
      unitId: null,
    });
    // The guard is never told of their own; the management is.
    expect(await x.told(s.c, guard.id, e.id)).toEqual([]);
    expect(
      (await x.told(s.c, s.manager.id, e.id)).map((n) => n.kind),
    ).toContain('emergency.reported');
    const [room] = await x.inTx(s.c, (tx) =>
      tx.controlRoomEvent.findMany({ where: { sourceId: ev.id } }),
    );
    expect(room).toMatchObject({
      kind: 'guard_alarm',
      severity: 'high',
      gateId: guard.gateId,
    });
    const [audit] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'guard_alarm.received',
      targetId: ev.id,
    });
    expect(audit).toMatchObject({
      actorType: 'system',
      metadata: { kind: 'panic', outcome: 'raised', emergencyId: e.id },
    });
    // The same event again: handled once.
    await send(body).expect(200);
    expect(
      await x.inTx(s.c, (tx) =>
        tx.guardAlarmEvent.count({ where: { vendorEventId: body.eventId } }),
      ),
    ).toBe(1);
    // A fall at the same post is medical: an emergency of its own.
    const fall = alarm(d.deviceRef, 'fall');
    await send(fall).expect(200);
    const fallRow = await eventRow(d.deviceRef, fall.eventId);
    expect(fallRow.outcome).toBe('raised');
    expect(fallRow.emergencyId).not.toBe(e.id);

    // The vendor's cancel asks: recorded and told; the emergency stays open.
    const cancel = alarm(d.deviceRef, 'cancelled');
    await send(cancel).expect(200);
    const asked = await eventRow(d.deviceRef, cancel.eventId);
    expect(asked).toMatchObject({
      outcome: 'cancel_requested',
      emergencyId: fallRow.emergencyId,
    });
    expect(
      await x.inTx(s.c, (tx) =>
        tx.emergency.findUniqueOrThrow({
          where: { id: fallRow.emergencyId! },
        }),
      ),
    ).toMatchObject({
      status: 'reported',
      cancelRequestedAt: expect.any(Date) as Date,
    });
  });

  it('unpaired, unknown, retired or its shift ended: the control room only, never dropped', async () => {
    const d = await device();
    const unpaired = alarm(d.deviceRef, 'no_motion');
    await send(unpaired).expect(200);
    expect(await eventRow(d.deviceRef, unpaired.eventId)).toMatchObject({
      outcome: 'unpaired',
      emergencyId: null,
    });
    const unknown = alarm('never-registered', 'panic');
    await send(unknown).expect(200);
    const row = await eventRow('never-registered', unknown.eventId);
    expect(row).toMatchObject({ outcome: 'unpaired', deviceId: null });
    expect(
      await x.inTx(s.c, (tx) =>
        tx.controlRoomEvent.findFirstOrThrow({ where: { sourceId: row.id } }),
      ),
    ).toMatchObject({ kind: 'guard_alarm_unpaired', severity: 'high' });

    // The shift's end ends the pairing; a retirement does too.
    const guard = await x.guardOnDuty(s.c);
    await pair(guard, d.id).expect(200);
    await x.endRaw(guard).expect(200);
    const after = alarm(d.deviceRef, 'panic');
    await send(after).expect(200);
    expect((await eventRow(d.deviceRef, after.eventId)).outcome).toBe(
      'unpaired',
    );
    const other = await x.guardOnDuty(s.c);
    await pair(other, d.id).expect(200);
    const retired = (
      await x
        .http(
          'post',
          `/staff/gate/alarm-devices/${d.id}/retire`,
          keeper.token,
          {
            reasonCode: 'broken',
          },
        )
        .expect(200)
    ).body as Device;
    expect(retired).toMatchObject({ status: 'retired', pairing: null });
    expect(codeOf(await pair(other, d.id).expect(409))).toBe(
      'ALARM_DEVICE_RETIRED',
    );
    const last = alarm(d.deviceRef, 'panic');
    await send(last).expect(200);
    expect(await eventRow(d.deviceRef, last.eventId)).toMatchObject({
      outcome: 'unpaired',
      deviceId: null,
    });
  });

  it('every refusal is the same 401: an unknown compound, a signature that does not hold; a stale event is not taken', async () => {
    const d = await device();
    const body = alarm(d.deviceRef, 'panic');
    expect((await send(body, randomUUID()).expect(401)).body).toEqual({
      ok: false,
    });
    await send(body, 'not-a-compound').expect(401);
    await send(body, s.c.tenantId, 'f'.repeat(64)).expect(401);
    const events = await auditReaders(h).security({
      event: 'guard_alarm.webhook_rejected',
    });
    expect(events.filter((e) => e.tenantId === s.c.tenantId)).toHaveLength(1);
    const old = {
      ...alarm(d.deviceRef, 'panic'),
      at: new Date(Date.now() - 2 * 24 * 3_600_000).toISOString(),
    };
    await send(old).expect(200);
    expect(
      await x.inTx(s.c, (tx) =>
        tx.guardAlarmEvent.count({ where: { vendorEventId: old.eventId } }),
      ),
    ).toBe(0);
  });
});
