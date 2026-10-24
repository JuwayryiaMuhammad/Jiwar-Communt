import { newId } from '../../src/core/common/uuid';
import { nameKey } from '../../src/core/common/visitor-name';
import { shortTag } from '../../src/gate/offline/offline-tags';
import { dbClock } from '../setup/compound-clock';
import { superuserSql } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  entryAction,
  offlineHelpers,
  type BundleBody,
  type TestDevice,
} from '../setup/offline';
import { patrolHelpers } from '../setup/patrols';
import { permitHelpers } from '../setup/permits';

/**
 * ADR 0057, the rest of the gate offline: event guests by plate or list,
 * move trucks by plate, contractors by their permit and the last four of
 * their ID (matched at sync, never kept), service vehicles in and out by
 * plate, material entries, the scans of a patrol started online. And the
 * bundle's sections they decide with, never a name or a plate in clear.
 */
describe('Gate offline — permits, vehicles, materials and patrols (ADR 0057)', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof offlineHelpers>;
  let pm: ReturnType<typeof permitHelpers>;
  let pt: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof offlineHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = offlineHelpers(h);
    pm = permitHelpers(h);
    pt = patrolHelpers(h);
    s = await o.setUp('Offline More Court');
    // No rule of the compound refuses a contractor at any hour.
    await pm.anyTime(s.manager);
  }, 180_000);

  afterAll(() => h.close());

  const salt = (b: BundleBody) => Buffer.from(b.salt, 'base64url');
  const section = <T>(b: BundleBody, name: string) => b[name] as T[];
  /** A permit in force from an hour ago for eight hours, all day long. */
  const inForce = (id: string, data: Record<string, unknown> = {}) =>
    superuserSql(
      `UPDATE unit_permits
          SET starts_at = $2::timestamptz - interval '1 hour',
              ends_at = $2::timestamptz + interval '8 hours'
              ${data.daily ? `, daily_from = 0, daily_to = 1439` : ''}
        WHERE id = $1`,
      [id, dbClock()],
    );
  const one = async (d: TestDevice, action: Record<string, unknown>) =>
    (await o.upload(s.guard, s.c, d, [action])).results[0];

  describe('a works permit’s contractors', () => {
    it('carried by reference, never a name; matched at sync by the last four', async () => {
      const permit = await pm.works(s.alice, s.home.id);
      const { worker } = await pm.addWorker(s.alice, permit.id, {
        idLast4: '7731',
      });
      await pm.approve(s.manager, permit.id);
      await inForce(permit.id, { daily: true });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const works = section<{
        ref: string;
        reference: string;
        workers: number;
      }>(b, 'works').find((w) => w.ref === permit.id)!;
      expect(works).toMatchObject({
        reference: permit.reference,
        unitCode: s.unitCode,
        workers: 1,
        stopped: false,
      });
      expect(JSON.stringify(b)).not.toContain(worker.fullName!);
      const base = {
        clientId: newId(),
        deviceTime: b.issuedAt,
        bundleId: b.bundleId,
        type: 'contractor',
        permitId: permit.id,
        direction: 'in',
      };
      const res = await one(d, { ...base, seq: d.seq++, idLast4: '7731' });
      expect(res).toMatchObject({ status: 'recorded', flags: [] });
      expect(
        await o.inTx(s.c, (tx) =>
          tx.gateEntry.findUnique({ where: { id: res.entryId! } }),
        ),
      ).toMatchObject({
        subjectType: 'permit_worker',
        subjectId: worker.id,
        method: 'permit',
      });
      // A last four no worker of it has: not attributed, a security flag.
      const wrong = await one(d, {
        ...base,
        clientId: newId(),
        seq: d.seq++,
        idLast4: '0000',
      });
      expect([wrong.status, wrong.reason, wrong.flags]).toEqual([
        'rejected',
        'contractor_unresolved',
        ['contractor_unresolved'],
      ]);
      // The last four are kept nowhere.
      const actions = await o.inTx(s.c, (tx) =>
        tx.gateOfflineAction.findMany({ where: { deviceId: d.id } }),
      );
      expect(JSON.stringify(actions)).not.toContain('7731');
    });

    it('two workers with the same last four: not attributed', async () => {
      const permit = await pm.works(s.alice, s.home.id);
      await pm.addWorker(s.alice, permit.id, { idLast4: '5151' });
      await pm.addWorker(s.alice, permit.id, { idLast4: '5151' });
      await pm.approve(s.manager, permit.id);
      await inForce(permit.id, { daily: true });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const res = await one(d, {
        clientId: newId(),
        seq: d.seq++,
        deviceTime: b.issuedAt,
        bundleId: b.bundleId,
        type: 'contractor',
        permitId: permit.id,
        direction: 'in',
        idLast4: '5151',
      });
      expect([res.reason]).toEqual(['contractor_unresolved']);
      const [flag] = await o.flagsOf(s.c, d.id);
      expect(flag.params).toEqual({
        reason: 'contractor_unresolved',
        matches: 2,
      });
    });
  });

  describe('event guests and move trucks', () => {
    it('a guest by their exact name, a truck by its plate: tags, recorded on the permit', async () => {
      const event = await pm.event(s.alice, s.home.id, 0, {
        guests: [{ fullName: 'Guest Of Honour', vehiclePlate: 'ح ف ل 12' }],
      });
      // One guest: approved at once (ADR 0049).
      expect(event.status).toBe('approved');
      await superuserSql(
        `UPDATE unit_permits
            SET starts_at = $2::timestamptz - interval '10 minutes',
                ends_at = $2::timestamptz + interval '3 hours'
          WHERE id = $1`,
        [event.id, dbClock()],
      );
      const move = await pm.move(s.alice, s.home.id);
      await pm.approve(s.manager, move.id);
      await inForce(move.id);
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const ev = section<{
        ref: string;
        guests: { ref: string; name: string; plate: string }[];
      }>(b, 'events').find((e) => e.ref === event.id)!;
      expect(ev.guests).toEqual([
        {
          ref: expect.any(String) as string,
          name: shortTag(salt(b), 'guest-name', nameKey('Guest Of Honour')!),
          plate: shortTag(salt(b), 'plate', 'حفل12'),
        },
      ]);
      const mv = section<{ ref: string; plate: string }>(b, 'moves').find(
        (m) => m.ref === move.id,
      )!;
      expect(mv.plate).toBe(shortTag(salt(b), 'plate', 'نقل456'));
      const text = Buffer.from(JSON.stringify(b)).toString('utf8');
      for (const secret of ['Guest Of Honour', 'ح ف ل 12', 'حفل12', 'نقل'])
        expect(text).not.toContain(secret);
      const guest = await one(
        d,
        entryAction(
          d,
          b,
          { type: 'event_guest', id: ev.guests[0].ref },
          { via: 'list' },
        ),
      );
      const truck = await one(
        d,
        entryAction(
          d,
          b,
          { type: 'move_permit', id: move.id },
          { via: 'plate' },
        ),
      );
      for (const r of [guest, truck])
        expect(r).toMatchObject({ status: 'recorded', flags: [] });
      expect(
        await o.inTx(s.c, (tx) =>
          tx.gateEntry.findUnique({ where: { id: guest.entryId! } }),
        ),
      ).toMatchObject({ method: 'permit', subjectType: 'event_guest' });
    });
  });

  describe('service vehicles', () => {
    const vin = (
      d: TestDevice,
      b: BundleBody,
      over: Record<string, unknown> = {},
    ) => ({
      clientId: newId(),
      seq: d.seq++,
      deviceTime: b.issuedAt,
      bundleId: b.bundleId,
      type: 'service_vehicle_in',
      plate: 'ص ه ر 77',
      kind: 'tanker',
      company: 'Offline Water',
      ...over,
    });

    it('in at its device time, by the bundle’s guard; out by its plate', async () => {
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const other = await o.guard(s.c);
      const plate = 'ص ه ر 701';
      const up = await o.upload(other, s.c, d, [
        vin(d, b, { plate, unitCode: s.unitCode }),
      ]);
      const visitId = up.results[0].clientId;
      const visit = await o.inTx(s.c, (tx) =>
        tx.serviceVehicleVisit.findUniqueOrThrow({ where: { id: visitId } }),
      );
      expect(visit).toMatchObject({
        plate: 'ص ه ر 701',
        enteredAt: new Date(b.issuedAt),
        enteredGateId: s.guard.gateId,
        enteredById: s.guard.id,
        exitedAt: null,
      });
      const out = await one(d, {
        clientId: newId(),
        seq: d.seq++,
        deviceTime: b.issuedAt,
        bundleId: b.bundleId,
        type: 'service_vehicle_out',
        plate: 'صهر701',
      });
      expect(out.status).toBe('recorded');
      expect(
        (
          await o.inTx(s.c, (tx) =>
            tx.serviceVehicleVisit.findUniqueOrThrow({
              where: { id: visitId },
            }),
          )
        ).exitedAt,
      ).not.toBeNull();
      // Out again, nobody inside: recorded, flagged.
      const again = await one(d, {
        clientId: newId(),
        seq: d.seq++,
        deviceTime: b.issuedAt,
        bundleId: b.bundleId,
        type: 'service_vehicle_out',
        plate,
      });
      expect(again.flags).toEqual(['exit_without_entry']);
    });

    it('its plate inside already: the older visit closed unconfirmed, flagged; a ban met', async () => {
      const plate = 'ص ه ر 702';
      const online = await o.serviceIn(s.guard, plate);
      await o.block(s.manager, { subject: 'plate', plate });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const res = await one(d, vin(d, b, { plate }));
      expect(res.flags.sort()).toEqual([
        'blocklist_ban_entered',
        'duplicate_inside',
      ]);
      expect(
        await o.inTx(s.c, (tx) =>
          tx.serviceVehicleVisit.findUniqueOrThrow({
            where: { id: online.id },
          }),
        ),
      ).toMatchObject({ exitUnconfirmed: true, exitedById: null });
      expect(
        await o.inTx(s.c, (tx) =>
          tx.serviceVehicleVisit.count({
            where: { plateKey: 'صهر702', exitedAt: null },
          }),
        ),
      ).toBe(1);
    });

    it('carried while inside, by plate tag', async () => {
      const inside = await o.serviceIn(s.guard, 'ص ه ر 703');
      const { b } = await o.deviceWithBundle(s.guard, s.c);
      expect(
        section<{ ref: string; plate: string }>(b, 'serviceVehicles').find(
          (v) => v.ref === inside.id,
        ),
      ).toEqual({
        ref: inside.id,
        plate: shortTag(salt(b), 'plate', 'صهر703'),
        kind: 'tanker',
      });
    });
  });

  describe('material entries', () => {
    it('at its device time; an unknown unit cannot have been served', async () => {
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const base = {
        deviceTime: b.issuedAt,
        bundleId: b.bundleId,
        type: 'material_entry',
        description: 'Ten bags of cement',
      };
      const ok = await one(d, {
        ...base,
        clientId: newId(),
        seq: d.seq++,
        unitCode: s.unitCode,
      });
      expect(ok.status).toBe('recorded');
      expect(
        await o.inTx(s.c, (tx) =>
          tx.materialEntry.findUniqueOrThrow({ where: { id: ok.clientId } }),
        ),
      ).toMatchObject({
        occurredAt: new Date(b.issuedAt),
        guardAccountId: s.guard.id,
        description: 'Ten bags of cement',
      });
      const unknown = await one(d, {
        ...base,
        clientId: newId(),
        seq: d.seq++,
        unitCode: 'NO-SUCH-UNIT',
      });
      expect([unknown.status, unknown.reason]).toEqual([
        'rejected',
        'subject_unknown',
      ]);
    });
  });

  describe('a patrol started online', () => {
    it('its scans synced by any guard are the run’s guard’s, at their device time; a refusal is flagged', async () => {
      const cp = await pt.checkpoint(s.manager, { gateId: s.guard.gateId });
      const other = await pt.checkpoint(s.manager, { gateId: s.guard.gateId });
      const route = await pt.route(s.manager, { gateId: s.guard.gateId }, [
        cp.id,
        other.id,
      ]);
      const run = await pt.adhoc(s.guard, route.id);
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      // At the bundle's issue: never past the receipt, which clamps it.
      const scanAt = b.issuedAt;
      const syncer = await o.guard(s.c);
      const up = await o.upload(syncer, s.c, d, [
        {
          clientId: newId(),
          seq: d.seq++,
          deviceTime: scanAt,
          bundleId: b.bundleId,
          type: 'patrol_scan',
          runId: run.id,
          method: 'qr',
          payload: cp.qrPayload,
        },
        {
          clientId: newId(),
          seq: d.seq++,
          deviceTime: scanAt,
          bundleId: b.bundleId,
          type: 'patrol_scan',
          runId: run.id,
          method: 'qr',
          payload: 'JWK1.not-a-checkpoint',
        },
      ]);
      expect(up.results.map((r) => [r.status, r.reason])).toEqual([
        ['recorded', null],
        ['rejected', 'patrol_refused'],
      ]);
      const scan = await o.inTx(s.c, (tx) =>
        tx.patrolScan.findUniqueOrThrow({
          where: { id: up.results[0].clientId },
        }),
      );
      expect(scan).toMatchObject({
        guardAccountId: s.guard.id,
        scannedAt: new Date(scanAt),
      });
      const flags = await o.flagsOf(s.c, d.id);
      expect(flags).toEqual([
        expect.objectContaining({
          kind: 'patrol_scan_refused',
          class: 'manager',
          params: {
            reason: 'patrol_refused',
            code: 'PATROL_CHECKPOINT_INVALID',
          },
        }),
      ]);
    });
  });

  describe('a quarantined contractor', () => {
    it('kept no last four: accepted later, it is not attributed', async () => {
      const permit = await pm.works(s.alice, s.home.id);
      await pm.addWorker(s.alice, permit.id, { idLast4: '8282' });
      await pm.approve(s.manager, permit.id);
      await inForce(permit.id, { daily: true });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      await o.revokeRaw(s.manager, d.id).expect(200);
      const up = await o.upload(s.guard, s.c, d, [
        {
          clientId: newId(),
          seq: d.seq++,
          deviceTime: b.issuedAt,
          bundleId: b.bundleId,
          type: 'contractor',
          permitId: permit.id,
          direction: 'in',
          idLast4: '8282',
        },
      ]);
      const [row] = await o.inTx(s.c, (tx) =>
        tx.gateOfflineAction.findMany({ where: { batchId: up.batchId } }),
      );
      expect(row.body).not.toHaveProperty('idLast4');
      const view = (
        await o
          .http(
            'post',
            `/staff/gate/offline/batches/${up.batchId}/review`,
            s.manager.token,
            { decision: 'accept' },
          )
          .expect(200)
      ).body as { actions: { status: string; reason: string | null }[] };
      expect(view.actions).toEqual([
        expect.objectContaining({
          status: 'rejected',
          reason: 'contractor_unresolved',
        }),
      ]);
    });
  });
});
