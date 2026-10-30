import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { randomUUID } from 'node:crypto';
import {
  FAKE_ALARM_SIGNATURE_HEADER,
  signFakeAlarm,
} from '../../src/gate/alarms/fake-alarm-driver';
import {
  FAKE_CALL_SIGNATURE_HEADER,
  signFakeCallEvent,
} from '../../src/gate/calls/fake-call-driver';
import { GATE_CALL_TIMEOUT_SWEEP } from '../../src/gate/calls/gate-calls.service';
import { FACE_ENROLLMENT_SWEEP } from '../../src/gate/face/face-enrollments';
import { auditReaders } from '../setup/audit';
import { GUARD_VENDORS_COVERAGE } from '../setup/audit-coverage-split';
import { SAMPLE } from '../setup/files';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

const NAME = 'AUDIT-g8-name';

/**
 * One scenario per entry of the guard vendor adapters' catalog (ADR 0014,
 * 0068): actor, target and metadata — ids, codes and counts; never a
 * face, a template, a score, a document's number or a name.
 */
const covered = new Set<string>();

describe('Audit coverage — guard vendor adapters', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let guard: Who & { gateId: string; shiftId: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    read = auditReaders(h);
    s = await x.setUp('G8 Audit Court');
    guard = await x.guardOnDuty(s.c);
  }, 120_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }
  async function image(as: Who, purpose: string, n: number) {
    const id = await x.files.uploaded(
      as.token,
      purpose,
      'image/png',
      Buffer.concat([SAMPLE['image/png'].subarray(0, 8), Buffer.alloc(40, n)]),
    );
    await x.files.finalize(as.token, id).expect(200);
    return id;
  }

  describe('face checks', () => {
    it('face_enrollment.enrolled and .removed — the entry; face_check.made — the shift, the outcome, the entries', async () => {
      await x
        .http('patch', '/staff/gate/settings', s.manager.token, {
          faceChecks: true,
          faceChecksNoticePosted: true,
        })
        .expect(200);
      const entry = await x.block(s.manager, {
        subject: 'person',
        fullName: NAME,
        idNumber: '29001011288001',
        photoFileId: await image(s.manager, 'blocklist_photo', 1),
      });
      await x.sweep(FACE_ENROLLMENT_SWEEP);
      const [enrolment] = await x.inTx(s.c, (tx) =>
        tx.gateFaceEnrollment.findMany({ where: { entryId: entry.id } }),
      );
      const enrolled = await single('face_enrollment.enrolled', enrolment.id);
      expect(enrolled).toMatchObject({
        actorType: 'system',
        metadata: { entryId: entry.id },
      });

      const check = (
        await x
          .http('post', '/gate/face-checks', guard.token, {
            photoFileId: await image(guard, 'gate_face_probe', 1),
          })
          .expect(201)
      ).body as { id: string };
      const made = await single('face_check.made', check.id);
      expect(made).toMatchObject({
        actorId: guard.id,
        metadata: {
          shiftId: guard.shiftId,
          outcome: 'possible_match',
          entryIds: [entry.id],
        },
      });

      await x
        .http(
          'post',
          `/staff/security/blocklist/${entry.id}/lift`,
          s.manager.token,
          { reasonCode: 'resolved' },
        )
        .expect(200);
      await x.sweep(FACE_ENROLLMENT_SWEEP);
      const removed = await single('face_enrollment.removed', enrolment.id);
      expect(removed.metadata).toEqual({ entryId: entry.id, enrolled: true });
      for (const row of [enrolled, made, removed])
        expect(leakText(row)).not.toMatch(/AUDIT-g8|fake-tpl|score/);
    });
  });

  describe('ID scans', () => {
    it('gate.id_scanned — the outcome, the document’s type, whether it met an entry; never the number', async () => {
      const file = await x.files.ready(guard.token, 'gate_id_scan');
      await x
        .http('post', '/gate/id-scans', guard.token, { imageFileId: file })
        .expect(200);
      const row = await single('gate.id_scanned', guard.shiftId);
      expect(row).toMatchObject({
        actorId: guard.id,
        metadata: {
          outcome: 'read',
          documentType: 'national_id',
          matched: false,
        },
      });
      expect(leakText(row)).not.toMatch(/29001011234567|Sample Holder/);
    });
  });

  describe('the control room', () => {
    it('control_room_event.acknowledged — the event’s kind and severity', async () => {
      const watcher = await x.supervisor(s.c);
      const l = await x.lockdown(guard, {
        scope: 'gate',
        gateId: guard.gateId,
        reasonCode: 'intruder',
      });
      const e = await x.inTx(s.c, (tx) =>
        tx.controlRoomEvent.findFirstOrThrow({ where: { sourceId: l.id } }),
      );
      await x
        .http(
          'post',
          `/staff/control-room/events/${e.id}/acknowledge`,
          watcher.token,
        )
        .expect(200);
      expect(
        await single('control_room_event.acknowledged', e.id),
      ).toMatchObject({
        actorId: watcher.id,
        metadata: { kind: 'lockdown_started', severity: 'high' },
      });
      await x.endLockdownRaw(s.manager, l.id).expect(200);
    });
  });

  describe('guard-down alarms', () => {
    it('guard_alarm_device.registered, .renamed, .retired; guard_alarm.paired, .unpaired, .received; guard_alarm.webhook_rejected — ids, codes, never a label', async () => {
      const keeper = await x.supervisor(s.c);
      const device = (
        await x
          .http('post', '/staff/gate/alarm-devices', keeper.token, {
            deviceRef: `audit-${randomUUID()}`,
            label: NAME,
          })
          .expect(201)
      ).body as { id: string; deviceRef: string };
      expect(
        await single('guard_alarm_device.registered', device.id),
      ).toMatchObject({ actorId: keeper.id });
      await x
        .http('patch', `/staff/gate/alarm-devices/${device.id}`, keeper.token, {
          label: `${NAME} 2`,
        })
        .expect(200);
      await single('guard_alarm_device.renamed', device.id);

      await x
        .http('post', '/gate/alarm-devices/pair', guard.token, {
          deviceId: device.id,
        })
        .expect(200);
      const pairing = await x.inTx(s.c, (tx) =>
        tx.guardAlarmPairing.findFirstOrThrow({
          where: { deviceId: device.id, endedAt: null },
        }),
      );
      expect(await single('guard_alarm.paired', pairing.id)).toMatchObject({
        actorId: guard.id,
        metadata: { deviceId: device.id, shiftId: guard.shiftId },
      });
      const body = {
        eventId: randomUUID(),
        deviceRef: device.deviceRef,
        kind: 'fall',
        at: new Date().toISOString(),
      };
      await h
        .http()
        .post(`${API}/public/gate/alarms/${s.c.tenantId}`)
        .set(FAKE_ALARM_SIGNATURE_HEADER, signFakeAlarm(body))
        .send(body)
        .expect(200);
      const event = await x.inTx(s.c, (tx) =>
        tx.guardAlarmEvent.findFirstOrThrow({
          where: { vendorEventId: body.eventId },
        }),
      );
      expect(await single('guard_alarm.received', event.id)).toMatchObject({
        actorType: 'system',
        metadata: {
          kind: 'fall',
          outcome: 'raised',
          emergencyId: event.emergencyId,
        },
      });
      await x
        .http(
          'post',
          `/staff/gate/alarm-devices/${device.id}/retire`,
          keeper.token,
          {
            reasonCode: 'lost',
          },
        )
        .expect(200);
      expect(
        await single('guard_alarm_device.retired', device.id),
      ).toMatchObject({ metadata: { reasonCode: 'lost', wasPaired: true } });
      expect(
        (await single('guard_alarm.unpaired', pairing.id)).metadata,
      ).toEqual({ deviceId: device.id, reason: 'device_retired' });
      const rows = await read.tenant(s.c.tenantId, { targetId: device.id });
      expect(leakText(rows)).not.toContain(NAME);

      await h
        .http()
        .post(`${API}/public/gate/alarms/${s.c.tenantId}`)
        .set(FAKE_ALARM_SIGNATURE_HEADER, '0'.repeat(64))
        .send(body)
        .expect(401);
      const rejected = (
        await read.security({ event: 'guard_alarm.webhook_rejected' })
      ).filter((e) => e.tenantId === s.c.tenantId);
      expect(rejected).toHaveLength(1);
      covered.add('guard_alarm.webhook_rejected');
    });
  });

  describe('gate calls', () => {
    it('gate_call.started, .answered, .ended, .missed; gate_call.webhook_rejected — the unit, the reason, how it ended; never who answered', async () => {
      const call = async () =>
        (
          await x
            .http('post', '/gate/calls', guard.token, {
              unitId: s.home.id,
              reasonCode: 'visitor_at_gate',
            })
            .expect(201)
        ).body as { id: string };
      const one = await call();
      expect(await single('gate_call.started', one.id)).toMatchObject({
        actorId: guard.id,
        metadata: {
          unitId: s.home.id,
          reasonCode: 'visitor_at_gate',
          shiftId: guard.shiftId,
          rung: 1,
        },
      });
      await x
        .http('post', `/me/gate-calls/${one.id}/answer`, s.alice.token)
        .expect(200);
      const answered = await single('gate_call.answered', one.id);
      expect(answered).toMatchObject({
        actorId: s.alice.id,
        metadata: { unitId: s.home.id },
      });
      await x
        .http('post', `/gate/calls/${one.id}/end`, guard.token)
        .expect(200);
      expect((await single('gate_call.ended', one.id)).metadata).toEqual({
        unitId: s.home.id,
        reason: 'guard',
        answered: true,
      });
      const two = await call();
      await x.sweep(GATE_CALL_TIMEOUT_SWEEP, new Date(Date.now() + 120_000));
      expect(await single('gate_call.missed', two.id)).toMatchObject({
        actorType: 'system',
        metadata: { unitId: s.home.id, reason: 'missed', answered: false },
      });
      const body = {
        eventId: randomUUID(),
        roomRef: 'nowhere',
        kind: 'room_closed',
        at: new Date().toISOString(),
      };
      await h
        .http()
        .post(`${API}/public/gate/calls/${s.c.tenantId}/events`)
        .set(FAKE_CALL_SIGNATURE_HEADER, '0'.repeat(64))
        .send(body)
        .expect(401);
      expect(signFakeCallEvent(body)).toMatch(/^[0-9a-f]{64}$/);
      expect(
        (await read.security({ event: 'gate_call.webhook_rejected' })).filter(
          (e) => e.tenantId === s.c.tenantId,
        ),
      ).toHaveLength(1);
      covered.add('gate_call.webhook_rejected');
    });
  });

  describe('catalog completeness', () => {
    it('every guard vendor entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of GUARD_VENDORS_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...GUARD_VENDORS_COVERAGE].sort());
    });
  });
});
