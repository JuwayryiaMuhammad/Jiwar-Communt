import { OFFLINE_SYNC_HEALTH_SWEEP } from '../../src/gate/offline/offline-health';
import { dbClock } from '../setup/compound-clock';
import { superuserSql } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { entryAction, envelope, offlineHelpers } from '../setup/offline';

const MINUTE = 60_000;

/**
 * ADR 0057, sync health: every call a device makes says it is alive; a
 * heartbeat says what it still holds and learns whether to refresh its
 * bundle; the sweep tells the management, once per outage, of a device on
 * shift not seen for `offlineSyncAlertMinutes`, once per gap of a sequence
 * still missing actions, and tells what an upload left untold.
 */
describe('Gate offline — sync health (ADR 0057)', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof offlineHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof offlineHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = offlineHelpers(h);
    s = await o.setUp('Offline Health Court');
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const sweep = () => o.sweep(OFFLINE_SYNC_HEALTH_SWEEP, dbClock());
  /** The device last seen (and uploading) `minutes` ago, written as such. */
  const unseen = (id: string, minutes: number) =>
    superuserSql(
      `UPDATE gate_devices
          SET last_seen_at = $2::timestamptz,
              last_upload_at = CASE WHEN last_upload_at IS NULL THEN NULL ELSE $2::timestamptz END
        WHERE id = $1`,
      [id, new Date(dbClock().getTime() - minutes * MINUTE)],
    );
  const toldKinds = async (targetId: string) =>
    (await o.told(s.c, s.manager.id, targetId)).map((n) => n.kind);

  describe('a heartbeat', () => {
    it('stamps the device, says what was acknowledged and whether to refresh', async () => {
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const p = await o.passFull(s.alice, s.home.id);
      await o.upload(s.guard, s.c, d, [
        entryAction(d, b, { type: 'visitor_pass', id: p.id }),
      ]);
      const res = await o.heartbeatRaw(s.guard, s.c, d, 3).expect(200);
      expect(res.body).toEqual({
        serverTime: expect.any(String) as string,
        ackedThroughSeq: 1,
        refreshBundle: false,
      });
      expect(await o.deviceRow(s.c, d.id)).toMatchObject({
        pendingCount: 3,
        lastSeenAt: new Date((res.body as { serverTime: string }).serverTime),
      });
      // A ban added since the bundle: refresh.
      await o.block(s.manager, { subject: 'plate', plate: 'ن ب ض 9001' });
      expect(
        (
          (await o.heartbeatRaw(s.guard, s.c, d, 0).expect(200)).body as {
            refreshBundle: boolean;
          }
        ).refreshBundle,
      ).toBe(true);
    });

    it('a lockdown since the bundle, or a bundle 15 minutes old: refresh', async () => {
      const t = await o.setUp('Offline Health Lockdown');
      const { d } = await o.deviceWithBundle(t.guard, t.c);
      const lock = await o.lockdown(t.guard, { scope: 'all' });
      expect(
        (
          (await o.heartbeatRaw(t.guard, t.c, d).expect(200)).body as {
            refreshBundle: boolean;
          }
        ).refreshBundle,
      ).toBe(true);
      await o.endLockdownRaw(t.manager, lock.id).expect(200);
      const fresh = await o.deviceWithBundle(t.guard, t.c);
      await superuserSql(
        `UPDATE gate_devices SET last_bundle_at = $2 WHERE id = $1`,
        [fresh.d.id, new Date(dbClock().getTime() - 16 * MINUTE)],
      );
      expect(
        (
          (await o.heartbeatRaw(t.guard, t.c, fresh.d).expect(200)).body as {
            refreshBundle: boolean;
          }
        ).refreshBundle,
      ).toBe(true);
    });

    it('once each, from a live device, saying how many it holds', async () => {
      const d = await o.enrol(s.guard, s.c);
      const once = envelope(d, s.c.tenantId, 'heartbeat', { pendingCount: 0 });
      await o
        .http('post', '/gate/offline/heartbeat', s.guard.token, once)
        .expect(200);
      const again = await o.http(
        'post',
        '/gate/offline/heartbeat',
        s.guard.token,
        once,
      );
      expect([again.status, code(again)]).toEqual([
        409,
        'GATE_DEVICE_ENVELOPE_REPLAYED',
      ]);
      const bad = await o.heartbeatRaw(s.guard, s.c, d, -1);
      expect([bad.status, code(bad)]).toEqual([
        422,
        'GATE_DEVICE_ENVELOPE_INVALID',
      ]);
      await o.revokeRaw(s.manager, d.id).expect(200);
      const gone = await o.heartbeatRaw(s.guard, s.c, d);
      expect([gone.status, code(gone)]).toEqual([403, 'GATE_DEVICE_REVOKED']);
    });
  });

  describe('the sweep', () => {
    it('a device on shift not seen: told once per outage', async () => {
      const { d } = await o.deviceWithBundle(s.guard, s.c);
      await unseen(d.id, 16);
      await sweep();
      await sweep();
      expect(
        (await toldKinds(d.id)).filter((k) => k === 'gate_device.sync_overdue'),
      ).toHaveLength(1);
      expect(await o.told(s.c, s.manager.id, d.id)).toEqual(
        expect.arrayContaining([
          { kind: 'gate_device.sync_overdue', params: { minutes: 15 } },
        ]),
      );
      // Seen again after it was told, then quiet again: a new outage, told
      // again. Written as such: told 40 minutes ago, seen 16 minutes ago.
      await o.heartbeatRaw(s.guard, s.c, d).expect(200);
      await superuserSql(
        `UPDATE gate_devices SET overdue_alerted_at = $2::timestamptz WHERE id = $1`,
        [d.id, new Date(dbClock().getTime() - 40 * MINUTE)],
      );
      await unseen(d.id, 16);
      await sweep();
      expect(
        (await toldKinds(d.id)).filter((k) => k === 'gate_device.sync_overdue'),
      ).toHaveLength(2);
    });

    it('not while it is seen within the setting, nor once its shift ended', async () => {
      const t = await o.setUp('Offline Health Settings');
      await o.settings(t.manager, { offlineSyncAlertMinutes: 30 });
      const { d } = await o.deviceWithBundle(t.guard, t.c);
      // Its enrolment told the management too: only the outage counts here.
      const overdue = async () =>
        (await o.told(t.c, t.manager.id, d.id)).filter(
          (n) => n.kind === 'gate_device.sync_overdue',
        );
      await superuserSql(
        `UPDATE gate_devices SET last_seen_at = $2 WHERE id = $1`,
        [d.id, new Date(dbClock().getTime() - 20 * MINUTE)],
      );
      await sweep();
      expect(await overdue()).toEqual([]);
      await o.http('post', '/gate/shifts/end', t.guard.token, {}).expect(200);
      await superuserSql(
        `UPDATE gate_devices SET last_seen_at = $2 WHERE id = $1`,
        [d.id, new Date(dbClock().getTime() - 40 * MINUTE)],
      );
      await sweep();
      expect(await overdue()).toEqual([]);
    });

    it('a gap in the sequence that stays open: told once', async () => {
      const p = await o.passFull(s.alice, s.home.id, { partySize: 3 });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const first = entryAction(d, b, { type: 'visitor_pass', id: p.id });
      entryAction(d, b, { type: 'visitor_pass', id: p.id }); // never sent
      const third = entryAction(d, b, { type: 'visitor_pass', id: p.id });
      await o.upload(s.guard, s.c, d, [first, third]);
      await unseen(d.id, 16);
      await sweep();
      await sweep();
      expect(
        (await o.told(s.c, s.manager.id, d.id)).filter(
          (n) => n.kind === 'gate_device.sequence_gap',
        ),
      ).toEqual([{ kind: 'gate_device.sequence_gap', params: { missing: 1 } }]);
      expect(await o.deviceView(s.manager, d.id)).toMatchObject({
        ackedSeq: 1,
        maxSeq: 3,
        missingActions: 1,
      });
    });

    it('what an upload left untold is told', async () => {
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const up = await o.upload(s.guard, s.c, d, [
        entryAction(d, b, { type: 'visitor_pass', id: d.id }),
      ]);
      // As if the upload crashed before its alert (written as such).
      await superuserSql(
        `UPDATE gate_offline_flags
            SET alerted_at = NULL, created_at = $2
          WHERE batch_id = $1`,
        [up.batchId, new Date(dbClock().getTime() - 2 * MINUTE)],
      );
      await sweep();
      expect(
        (await toldKinds(up.batchId)).filter(
          (k) => k === 'gate_offline.security_conflict',
        ),
      ).toHaveLength(2);
      const [flag] = await o.flagsOf(s.c, d.id);
      expect(flag.alertedAt).not.toBeNull();
    });
  });

  describe('the management’s view of a device', () => {
    it('its bundle, its shift, its sequence and its open flags', async () => {
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      await o.upload(s.guard, s.c, d, [
        entryAction(d, b, { type: 'visitor_pass', id: d.id }),
      ]);
      await o.heartbeatRaw(s.guard, s.c, d, 2).expect(200);
      expect(await o.deviceView(s.manager, d.id)).toMatchObject({
        bundleVersion: 1,
        bundleValidUntil: b.validUntil,
        onShift: true,
        pendingCount: 2,
        ackedSeq: 1,
        maxSeq: 1,
        missingActions: 0,
        openFlags: 1,
        lastUploadAt: expect.any(String) as string,
      });
    });
  });
});
