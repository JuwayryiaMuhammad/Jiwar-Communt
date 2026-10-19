import { newId } from '../../src/core/common/uuid';
import { REJECTION_ALERT_MS } from '../../src/gate/offline/offline-uploads.service';
import { auditReaders } from '../setup/audit';
import { dbClock } from '../setup/compound-clock';
import { superuserSql } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  entryAction,
  newDevice,
  offlineHelpers,
  type BundleBody,
  type TestDevice,
} from '../setup/offline';

const MINUTE = 60_000;

/**
 * ADR 0057, offline uploads: what a device recorded without network,
 * recorded at sync at its device time, never refused, flagged where the
 * server knows more, told once per batch. What cannot have happened is
 * rejected and flagged; a batch whose signature does not verify is refused
 * whole, audited and told.
 */
describe('Gate offline — uploads (ADR 0057)', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof offlineHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof offlineHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;
  let supervisor: Awaited<ReturnType<typeof o.supervisor>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = offlineHelpers(h);
    s = await o.setUp('Offline Uploads Court');
    supervisor = await o.supervisor(s.c);
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const pass = (over: Record<string, unknown> = {}) =>
    o.passFull(s.alice, s.home.id, over);
  const onPass = (id: string) => ({ type: 'visitor_pass', id });
  const entry = (id: string) =>
    o.inTx(s.c, (tx) => tx.gateEntry.findUnique({ where: { id } }));
  const passRow = (id: string) =>
    o.inTx(s.c, (tx) => tx.visitorPass.findUniqueOrThrow({ where: { id } }));
  const kinds = async (d: TestDevice) =>
    (await o.flagsOf(s.c, d.id)).map((f) => f.kind);
  /** A bundle's instant moved by `ms`, as the device would say it. */
  const at = (b: BundleBody, ms: number) =>
    new Date(new Date(b.issuedAt).getTime() + ms).toISOString();

  describe('recorded', () => {
    it('at its device time, the bundle’s guard, shift and gate, whoever uploads', async () => {
      const p = await pass({ partySize: 2 });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const a = entryAction(d, b, onPass(p.id));
      // Another guard, off duty, syncs the phone.
      const other = await o.guard(s.c);
      const res = await o.upload(other, s.c, d, [a]);
      expect(res).toMatchObject({
        ackedThroughSeq: 1,
        results: [
          {
            clientId: a.clientId,
            seq: 1,
            status: 'recorded',
            reason: null,
            flags: [],
            entryId: a.clientId,
          },
        ],
      });
      const e = await entry(a.clientId as string);
      expect(e).toMatchObject({
        subjectType: 'visitor_pass',
        subjectId: p.id,
        direction: 'in',
        method: 'code',
        gateId: s.guard.gateId,
        shiftId: s.guard.shiftId,
        guardAccountId: s.guard.id,
        occurredAt: new Date(b.issuedAt),
      });
      expect(e!.recordedAt.getTime()).toBeGreaterThanOrEqual(
        e!.occurredAt.getTime(),
      );
      expect((await passRow(p.id)).entriesUsed).toBe(1);
      const action = await o.inTx(s.c, (tx) =>
        tx.gateOfflineAction.findUniqueOrThrow({
          where: { id: a.clientId as string },
        }),
      );
      expect(action).toMatchObject({
        status: 'recorded',
        bundleId: b.bundleId,
        batchId: res.batchId,
        entryId: a.clientId,
        guardAccountId: s.guard.id,
      });
      const batch = await o.inTx(s.c, (tx) =>
        tx.gateOfflineBatch.findUniqueOrThrow({ where: { id: res.batchId } }),
      );
      expect(batch).toMatchObject({
        uploadedById: other.id,
        deviceId: d.id,
        actionCount: 1,
        status: 'accepted',
      });
    });

    it('a retry answers the same, once', async () => {
      const p = await pass();
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const a = entryAction(d, b, onPass(p.id));
      const batchId = newId();
      const first = await o.upload(s.guard, s.c, d, [a], { batchId });
      const again = await o.upload(s.guard, s.c, d, [a], { batchId });
      expect(again.results).toEqual([
        { ...first.results[0], status: 'duplicate' },
      ]);
      expect(
        await o.inTx(s.c, (tx) =>
          tx.gateEntry.count({ where: { subjectId: p.id } }),
        ),
      ).toBe(1);
      expect((await passRow(p.id)).entriesUsed).toBe(1);
    });

    it('an entry that reached the server online first is that entry, not another', async () => {
      const p = await pass({ partySize: 2 });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const a = entryAction(d, b, onPass(p.id));
      await o
        .entryRaw(s.guard, 'visitor_pass', p.id, { id: a.clientId })
        .expect(201);
      const res = await o.upload(s.guard, s.c, d, [a]);
      expect(res.results[0]).toMatchObject({
        status: 'recorded',
        entryId: a.clientId,
      });
      expect((await passRow(p.id)).entriesUsed).toBe(1);
    });

    it('a worker’s card: the household told, late as it is', async () => {
      const w = await o.workerWithCard(s.c, s.alice, s.home.id);
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const a = entryAction(
        d,
        b,
        {
          type: 'worker_engagement',
          id: w.engagementId,
        },
        { via: 'qr' },
      );
      await o.upload(s.guard, s.c, d, [a]);
      expect(await entry(a.clientId as string)).toMatchObject({
        method: 'qr',
        subjectType: 'worker_engagement',
      });
      expect(
        (await o.told(s.c, s.alice.id, w.engagementId)).map((n) => n.kind),
      ).toContain('worker.entered');
    });
  });

  describe('flagged at sync, never refused', () => {
    it('a once-only code used on two devices: counted once, flagged, the keepers told critically', async () => {
      const p = await pass({ partySize: 1 });
      const one = await o.deviceWithBundle(s.guard, s.c);
      const two = await o.deviceWithBundle(s.guard, s.c);
      await o.upload(s.guard, s.c, one.d, [
        entryAction(one.d, one.b, onPass(p.id)),
      ]);
      const res = await o.upload(s.guard, s.c, two.d, [
        entryAction(two.d, two.b, onPass(p.id)),
      ]);
      expect(res.results[0]).toMatchObject({
        status: 'recorded',
        flags: ['once_only_reused'],
      });
      const row = await passRow(p.id);
      expect([row.entriesUsed, row.status]).toEqual([1, 'used']);
      for (const keeper of [s.manager, supervisor])
        expect(await o.told(s.c, keeper.id, res.batchId)).toEqual([
          { kind: 'gate_offline.security_conflict', params: { flags: 1 } },
        ]);
    });

    it('a pass cancelled after the bundle and before the entry: credential_revoked; after the entry: nothing', async () => {
      const p = await pass();
      const later = await pass();
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      for (const id of [p.id, later.id])
        await o
          .http('post', `/visitor-passes/${id}/cancel`, s.alice.token, {
            reasonCode: 'plans_changed',
          })
          .expect(204);
      const cancelledAt = (await passRow(p.id)).cancelledAt!;
      const res = await o.upload(s.guard, s.c, d, [
        entryAction(d, b, onPass(p.id), {
          deviceTime: new Date(cancelledAt.getTime() + 1).toISOString(),
        }),
        entryAction(d, b, onPass(later.id)),
      ]);
      expect(res.results.map((r) => r.flags)).toEqual([
        ['credential_revoked'],
        [],
      ]);
      // Both recorded; a cancelled pass's counter stays closed (its CHECK).
      for (const id of [p.id, later.id])
        expect(await passRow(id)).toMatchObject({
          status: 'cancelled',
          entriesUsed: 0,
        });
      // Its one entry in is in the log: another for it is a reuse.
      const again = await o.upload(s.guard, s.c, d, [
        entryAction(d, b, onPass(later.id)),
      ]);
      expect(again.results[0].flags).toEqual(['once_only_reused']);
      const [flag] = await o.flagsOf(s.c, d.id);
      expect(flag).toMatchObject({
        class: 'manager',
        params: { reason: 'cancelled' },
        subjectType: 'visitor_pass',
        subjectId: p.id,
      });
      expect(await o.told(s.c, s.manager.id, res.batchId)).toEqual([
        { kind: 'gate_offline.conflicts', params: { flags: 1 } },
      ]);
    });

    it('a lockdown started while the device was offline: lockdown_entered, the gate’s guards told', async () => {
      const t = await o.setUp('Offline Uploads Lockdown');
      const p = await o.passFull(t.alice, t.home.id);
      const { d, b } = await o.deviceWithBundle(t.guard, t.c);
      const lock = await o.lockdown(t.guard, {
        scope: 'gate',
        gateId: t.guard.gateId,
      });
      const res = await o.upload(t.guard, t.c, d, [
        entryAction(d, b, onPass(p.id), {
          deviceTime: new Date(
            new Date(lock.startedAt).getTime() + 1,
          ).toISOString(),
        }),
      ]);
      expect(res.results[0].flags).toEqual(['lockdown_entered']);
      expect(await o.told(t.c, t.guard.id, t.guard.gateId)).toEqual([
        { kind: 'gate_offline.lockdown_entered', params: {} },
      ]);
      // Before the lockdown, nothing.
      const before = await o.upload(t.guard, t.c, d, [
        entryAction(d, b, onPass((await o.passFull(t.alice, t.home.id)).id)),
      ]);
      expect(before.results[0].flags).toEqual([]);
      await o.endLockdownRaw(t.manager, lock.id).expect(200);
    });

    it('a plate banned after the bundle: blocklist_ban_entered, matched as offline_sync, the keepers told', async () => {
      const plate = 'ه و ر 4401';
      const p = await pass({ vehiclePlate: plate });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const ban = await o.block(s.manager, { subject: 'plate', plate });
      const res = await o.upload(s.guard, s.c, d, [
        entryAction(d, b, onPass(p.id)),
      ]);
      expect(res.results[0].flags).toEqual(['blocklist_ban_entered']);
      const matches = await o.inTx(s.c, (tx) =>
        tx.blocklistMatch.findMany({ where: { entryId: ban.id } }),
      );
      expect(matches).toEqual([
        expect.objectContaining({
          source: 'offline_sync',
          outcome: 'flagged',
          subjectId: p.id,
        }),
      ]);
      expect(await o.told(s.c, s.manager.id, ban.id)).toEqual([
        { kind: 'blocklist.ban_matched', params: { source: 'offline_sync' } },
      ]);
    });

    it('an exit with nobody inside: exit_without_entry, cleared when its entry arrives', async () => {
      const p = await pass({ partySize: 2 });
      const one = await o.deviceWithBundle(s.guard, s.c);
      const two = await o.deviceWithBundle(s.guard, s.c);
      const out = entryAction(two.d, two.b, onPass(p.id), {
        direction: 'out',
        // Just after its bundle: never ahead of the receipt (a clock_skew).
        deviceTime: at(two.b, 1),
      });
      expect(
        (await o.upload(s.guard, s.c, two.d, [out])).results[0].flags,
      ).toEqual(['exit_without_entry']);
      const [flag] = await o.flagsOf(s.c, two.d.id);
      expect(flag.clearedAt).toBeNull();
      // The device that let them in syncs later: its entry was before.
      await o.upload(s.guard, s.c, one.d, [
        entryAction(one.d, one.b, onPass(p.id), { deviceTime: one.b.issuedAt }),
      ]);
      const [cleared] = await o.flagsOf(s.c, two.d.id);
      expect(cleared).toMatchObject({ clearedReason: 'reconciled' });
      expect(cleared.clearedAt).not.toBeNull();
    });

    it('a device’s clock: clamped to the bundle and the receipt, flagged; a batch far off its calibration too', async () => {
      const p = await pass({ partySize: 3 });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const early = entryAction(d, b, onPass(p.id), {
        deviceTime: at(b, -10 * MINUTE),
      });
      const ahead = entryAction(d, b, onPass(p.id), {
        deviceTime: new Date(dbClock().getTime() + 60 * MINUTE).toISOString(),
      });
      const res = await o.upload(s.guard, s.c, d, [early, ahead], {
        sentAt: new Date(dbClock().getTime() + 10 * MINUTE).toISOString(),
      });
      expect(res.results.map((r) => r.flags)).toEqual([
        ['clock_skew'],
        ['clock_skew'],
      ]);
      const first = await entry(early.clientId as string);
      expect(first!.occurredAt).toEqual(
        new Date(new Date(b.issuedAt).getTime() - 2 * MINUTE),
      );
      const second = await entry(ahead.clientId as string);
      expect(second!.occurredAt.getTime()).toBeLessThanOrEqual(
        new Date(res.receivedAt).getTime() + 1000,
      );
      const batchFlags = (await o.flagsOf(s.c, d.id)).filter(
        (f) => f.actionId === null,
      );
      expect(batchFlags).toEqual([
        expect.objectContaining({
          kind: 'clock_skew',
          params: { offsetSeconds: expect.any(Number) as number },
        }),
      ]);
    });

    it('past its bundle: bundle_expired; past its shift’s end: shift_ended', async () => {
      const t = await o.setUp('Offline Uploads Expired');
      const p = await o.passFull(t.alice, t.home.id, { partySize: 2 });
      const { d, b } = await o.deviceWithBundle(t.guard, t.c);
      // The bundle ended an hour ago (written as such).
      await superuserSql(
        `UPDATE gate_offline_bundles
            SET issued_at = $2::timestamptz - interval '3 hours', valid_until = $2::timestamptz - interval '1 hour'
          WHERE id = $1`,
        [b.bundleId, dbClock()],
      );
      // And its shift ended ten minutes ago (written as such).
      await superuserSql(
        `UPDATE guard_shifts
            SET started_at = $2::timestamptz - interval '4 hours',
                ended_at = $2::timestamptz - interval '10 minutes', end_reason = 'guard'
          WHERE id = $1`,
        [t.guard.shiftId, dbClock()],
      );
      const res = await o.upload(t.guard, t.c, d, [
        entryAction(d, b, onPass(p.id), {
          deviceTime: new Date(dbClock().getTime() - MINUTE).toISOString(),
        }),
      ]);
      expect(res.results[0].flags.sort()).toEqual([
        'bundle_expired',
        'shift_ended',
      ]);
    });
  });

  describe('what cannot have happened', () => {
    it('an unknown bundle, another device’s, an unknown subject: rejected, flagged, the keepers told', async () => {
      const p = await pass();
      const mine = await o.deviceWithBundle(s.guard, s.c);
      const theirs = await o.deviceWithBundle(s.guard, s.c);
      const res = await o.upload(s.guard, s.c, mine.d, [
        entryAction(mine.d, { ...mine.b, bundleId: newId() }, onPass(p.id)),
        entryAction(mine.d, theirs.b, onPass(p.id)),
        entryAction(mine.d, mine.b, onPass(newId())),
      ]);
      expect(res.results.map((r) => [r.status, r.reason])).toEqual([
        ['rejected', 'bundle_unknown'],
        ['rejected', 'bundle_unknown'],
        ['rejected', 'subject_unknown'],
      ]);
      expect(res.ackedThroughSeq).toBe(3);
      expect(await kinds(mine.d)).toEqual([
        'action_rejected',
        'action_rejected',
        'action_rejected',
      ]);
      expect(await o.told(s.c, s.manager.id, res.batchId)).toEqual([
        { kind: 'gate_offline.security_conflict', params: { flags: 3 } },
      ]);
      expect((await passRow(p.id)).entriesUsed).toBe(0);
    });

    it('an id or a sequence number another action holds: not recorded, flagged', async () => {
      const p = await pass({ partySize: 3 });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const a = entryAction(d, b, onPass(p.id));
      await o.upload(s.guard, s.c, d, [a]);
      // Its id again, saying something else.
      const reused = await o.upload(s.guard, s.c, d, [
        { ...a, direction: 'out', via: undefined },
      ]);
      // Its sequence number again, under another id.
      const renumbered = await o.upload(s.guard, s.c, d, [
        entryAction(d, b, onPass(p.id), { seq: a.seq }),
      ]);
      expect(
        [...reused.results, ...renumbered.results].map((r) => [
          r.status,
          r.reason,
        ]),
      ).toEqual([
        ['rejected', 'client_id_reused'],
        ['rejected', 'sequence_reused'],
      ]);
      expect(await kinds(d)).toEqual(['action_rejected', 'action_rejected']);
      expect((await passRow(p.id)).entriesUsed).toBe(1);
    });

    it('a gap in the sequence: acknowledged up to it, then past it once it arrives', async () => {
      const p = await pass({ partySize: 3 });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const first = entryAction(d, b, onPass(p.id));
      const second = entryAction(d, b, onPass(p.id));
      const third = entryAction(d, b, onPass(p.id));
      expect(
        (await o.upload(s.guard, s.c, d, [first, third])).ackedThroughSeq,
      ).toBe(1);
      expect((await o.upload(s.guard, s.c, d, [second])).ackedThroughSeq).toBe(
        3,
      );
      expect(await o.deviceRow(s.c, d.id)).toMatchObject({
        ackedSeq: 3,
        maxSeq: 3,
      });
    });
  });

  describe('refused whole', () => {
    it('signed by another key: refused, audited, the keepers told once in a while', async () => {
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const p = await pass();
      const send = () =>
        o.uploadRaw(
          s.guard,
          s.c,
          d,
          [entryAction(d, b, onPass(p.id))],
          {},
          newDevice(),
        );
      const res = await send();
      expect([res.status, code(res)]).toEqual([
        422,
        'GATE_DEVICE_SIGNATURE_INVALID',
      ]);
      await send();
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'gate_offline.upload_rejected',
          targetId: d.id,
        }),
      ).toHaveLength(2);
      expect(await o.told(s.c, s.manager.id, d.id)).toEqual(
        expect.arrayContaining([
          {
            kind: 'gate_device.upload_rejected',
            params: { reason: 'signature' },
          },
        ]),
      );
      expect(
        (await o.told(s.c, s.manager.id, d.id)).filter(
          (n) => n.kind === 'gate_device.upload_rejected',
        ),
      ).toHaveLength(1);
      expect(REJECTION_ALERT_MS).toBe(15 * MINUTE);
      expect(
        await o.inTx(s.c, (tx) =>
          tx.gateOfflineBatch.count({ where: { deviceId: d.id } }),
        ),
      ).toBe(0);
    });

    it('a payload that does not parse: every problem by field, audited', async () => {
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const res = await o.uploadRaw(s.guard, s.c, d, [
        { ...entryAction(d, b, onPass(newId())), seq: 0 },
      ]);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: [{ field: 'payload.actions.0.seq', code: 'INVALID_VALUE' }],
      });
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'gate_offline.upload_rejected',
          targetId: d.id,
        }),
      ).toEqual([expect.objectContaining({ metadata: { reason: 'payload' } })]);
    });

    it('from a revoked device: GATE_DEVICE_REVOKED, nothing recorded', async () => {
      const p = await pass();
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      await o.revokeRaw(s.manager, d.id).expect(200);
      const res = await o.uploadRaw(s.guard, s.c, d, [
        entryAction(d, b, onPass(p.id)),
      ]);
      expect([res.status, code(res)]).toEqual([403, 'GATE_DEVICE_REVOKED']);
      expect((await passRow(p.id)).entriesUsed).toBe(0);
    });
  });

  describe('the management’s flags', () => {
    it('listed by class and status, read, and reviewed once', async () => {
      const p = await pass({ partySize: 1 });
      const one = await o.deviceWithBundle(s.guard, s.c);
      const two = await o.deviceWithBundle(s.guard, s.c);
      await o.upload(s.guard, s.c, one.d, [
        entryAction(one.d, one.b, onPass(p.id)),
      ]);
      await o.upload(s.guard, s.c, two.d, [
        entryAction(two.d, two.b, onPass(p.id)),
      ]);
      const [flag] = await o.flagsOf(s.c, two.d.id);
      const list = (
        await o
          .http(
            'get',
            `/staff/gate/offline/flags?class=security&status=open&deviceId=${two.d.id}`,
            supervisor.token,
          )
          .expect(200)
      ).body as { data: { id: string; kind: string; occurredAt: string }[] };
      expect(list.data).toEqual([
        expect.objectContaining({
          id: flag.id,
          kind: 'once_only_reused',
          occurredAt: two.b.issuedAt,
        }),
      ]);
      const key = { 'Idempotency-Key': `review-${flag.id}` };
      const reviewed = await o
        .http(
          'post',
          `/staff/gate/offline/flags/${flag.id}/review`,
          s.manager.token,
          { reviewCode: 'followed_up' },
          key,
        )
        .expect(200);
      expect(reviewed.body).toMatchObject({
        status: 'reviewed',
        reviewCode: 'followed_up',
        reviewedBy: { id: s.manager.id },
      });
      const replay = await o.http(
        'post',
        `/staff/gate/offline/flags/${flag.id}/review`,
        s.manager.token,
        { reviewCode: 'followed_up' },
        key,
      );
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const again = await o.http(
        'post',
        `/staff/gate/offline/flags/${flag.id}/review`,
        s.manager.token,
        { reviewCode: 'other' },
      );
      expect([again.status, code(again)]).toEqual([
        409,
        'GATE_OFFLINE_FLAG_REVIEWED',
      ]);
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'gate_offline_flag.reviewed',
          targetId: flag.id,
        }),
      ).toEqual([
        expect.objectContaining({
          metadata: { kind: 'once_only_reused', reviewCode: 'followed_up' },
        }),
      ]);
    });
  });
});
