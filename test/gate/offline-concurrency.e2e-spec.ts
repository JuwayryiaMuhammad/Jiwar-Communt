import { newId } from '../../src/core/common/uuid';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { entryAction, envelope, offlineHelpers } from '../setup/offline';

const ROUNDS = 5;

/**
 * ADR 0057, the races of the gate offline. Lock order everywhere: the
 * account, the shift, the device, the lockdown row, the blocklist, the
 * subject. So:
 *
 * - an upload and an online entry of one once-only pass serialize on the
 *   pass: one is counted, the other refused online or flagged offline, the
 *   counter never past the party;
 * - two devices uploading one once-only pass: counted once, flagged once;
 * - one batch sent twice at once: each action recorded once;
 * - an upload and a lockdown's start: the entry is judged by its own time
 *   against the lockdown's, whichever commits first, and nothing waits on
 *   a cycle;
 * - a bundle and a lockdown's start: the bundle says the lockdown or was
 *   issued before it began;
 * - an upload and a ban of its plate: met, or the ban came after the sync
 *   and the entry stays as it was;
 * - an offline and an online entry of one service vehicle's plate share
 *   the plate's lock: one visit is left inside, the other closed;
 * - an upload and the device's revocation serialize on the device: every
 *   action received before the revocation is recorded, every one after is
 *   quarantined, none both.
 */
describe('Gate offline — concurrently (ADR 0057)', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof offlineHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof offlineHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = offlineHelpers(h);
    s = await o.setUp('Offline Race Court');
  }, 180_000);

  afterAll(() => h.close());

  const onPass = (id: string) => ({ type: 'visitor_pass', id });
  const passRow = (id: string) =>
    o.inTx(s.c, (tx) => tx.visitorPass.findUniqueOrThrow({ where: { id } }));
  const entries = (id: string) =>
    o.inTx(s.c, (tx) => tx.gateEntry.count({ where: { subjectId: id } }));

  it('an upload and an online entry of one once-only pass: one counted', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const p = await o.passFull(s.alice, s.home.id);
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const [online, offline] = await Promise.all([
        o.entryRaw(s.guard, 'visitor_pass', p.id),
        o.uploadRaw(s.guard, s.c, d, [entryAction(d, b, onPass(p.id))]),
      ]);
      expect(offline.status).toBe(200);
      const flags = (offline.body as { results: { flags: string[] }[] })
        .results[0].flags;
      // Online first: the offline one is flagged. Offline first: online is refused.
      if (online.status === 201) expect(flags).toEqual(['once_only_reused']);
      else {
        expect(online.status).toBe(409);
        expect(flags).toEqual([]);
      }
      expect((await passRow(p.id)).entriesUsed).toBe(1);
    }
  });

  it('two devices, one once-only pass: counted once, flagged once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const p = await o.passFull(s.alice, s.home.id);
      const one = await o.deviceWithBundle(s.guard, s.c);
      const two = await o.deviceWithBundle(s.guard, s.c);
      const [a, b] = await Promise.all([
        o.upload(s.guard, s.c, one.d, [
          entryAction(one.d, one.b, onPass(p.id)),
        ]),
        o.upload(s.guard, s.c, two.d, [
          entryAction(two.d, two.b, onPass(p.id)),
        ]),
      ]);
      expect(
        [...a.results, ...b.results].map((r) => r.flags.join()).sort(),
      ).toEqual(['', 'once_only_reused']);
      expect((await passRow(p.id)).entriesUsed).toBe(1);
      expect(await entries(p.id)).toBe(2);
    }
  });

  it('one batch sent twice at once: each action recorded once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const p = await o.passFull(s.alice, s.home.id, { partySize: 3 });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const actions = [
        entryAction(d, b, onPass(p.id)),
        entryAction(d, b, onPass(p.id)),
      ];
      const batch = envelope(d, s.c.tenantId, 'upload', {
        batchId: newId(),
        actions,
      });
      const send = () =>
        o.http('post', '/gate/offline/uploads', s.guard.token, batch);
      const [x, y] = await Promise.all([send(), send()]);
      expect([x.status, y.status]).toEqual([200, 200]);
      expect(await entries(p.id)).toBe(2);
      expect((await passRow(p.id)).entriesUsed).toBe(2);
      expect(await o.deviceRow(s.c, d.id)).toMatchObject({
        ackedSeq: 2,
        maxSeq: 2,
      });
    }
  });

  it('an upload and a lockdown’s start: judged by its own time, never a deadlock', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const t = await o.setUp(`Offline Race Lockdown ${round}`);
      const p = await o.passFull(t.alice, t.home.id);
      const { d, b } = await o.deviceWithBundle(t.guard, t.c);
      const [up, lock] = await Promise.all([
        o.upload(t.guard, t.c, d, [entryAction(d, b, onPass(p.id))]),
        o.lockdown(t.guard, { scope: 'gate', gateId: t.guard.gateId }),
      ]);
      // It came in at its bundle's issue: before the lockdown began.
      expect(new Date(lock.startedAt).getTime()).toBeGreaterThan(
        new Date(b.issuedAt).getTime(),
      );
      expect(up.results[0].flags).toEqual([]);
      await o.endLockdownRaw(t.manager, lock.id).expect(200);
    }
  });

  it('a bundle and a lockdown’s start: it says the lockdown, or was issued before it', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const t = await o.setUp(`Offline Race Bundle ${round}`);
      const d = await o.enrol(t.guard, t.c);
      const [issued, lock] = await Promise.all([
        o.bundle(t.guard, t.c, d),
        o.lockdown(t.guard, { scope: 'all' }),
      ]);
      if (issued.body.lockdown)
        expect(issued.body.lockdown).toEqual({
          scope: 'all',
          since: lock.startedAt,
        });
      else
        expect(new Date(issued.body.issuedAt).getTime()).toBeLessThanOrEqual(
          new Date(lock.startedAt).getTime(),
        );
      await o.endLockdownRaw(t.manager, lock.id).expect(200);
    }
  });

  it('an upload and a ban of its plate: met at sync, or banned after it', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const plate = `ق ز ${5100 + round}`;
      const p = await o.passFull(s.alice, s.home.id, { vehiclePlate: plate });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const [up, ban] = await Promise.all([
        o.upload(s.guard, s.c, d, [entryAction(d, b, onPass(p.id))]),
        o.block(s.manager, { subject: 'plate', plate }),
      ]);
      const matched = await o.inTx(s.c, (tx) =>
        tx.blocklistMatch.count({
          where: { entryId: ban.id, source: 'offline_sync' },
        }),
      );
      // Ban committed first: the sync met it. After: the entry stands as it was.
      expect(up.results[0].flags).toEqual(
        matched ? ['blocklist_ban_entered'] : [],
      );
      expect(await entries(p.id)).toBe(1);
    }
  });

  it('an upload and the device’s revocation: recorded before it, quarantined after, never both', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const p = await o.passFull(s.alice, s.home.id, { partySize: 3 });
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const [up] = await Promise.all([
        o.upload(s.guard, s.c, d, [
          entryAction(d, b, onPass(p.id)),
          entryAction(d, b, onPass(p.id)),
          entryAction(d, b, onPass(p.id)),
        ]),
        o.revokeRaw(s.manager, d.id).expect(200),
      ]);
      const revokedAt = (await o.deviceRow(s.c, d.id))!.revokedAt!;
      const rows = await o.inTx(s.c, (tx) =>
        tx.gateOfflineAction.findMany({
          where: { batchId: up.batchId },
          orderBy: { seq: 'asc' },
        }),
      );
      for (const r of rows)
        if (r.status === 'recorded')
          expect(r.receivedAt.getTime()).toBeLessThanOrEqual(
            revokedAt.getTime(),
          );
        else {
          expect(r.status).toBe('quarantined');
          expect(r.receivedAt.getTime()).toBeGreaterThanOrEqual(
            revokedAt.getTime(),
          );
        }
      // Once quarantined, the rest of the batch is too.
      const statuses = rows.map((r) => r.status);
      const first = statuses.indexOf('quarantined');
      if (first >= 0)
        expect(statuses.slice(first).every((x) => x === 'quarantined')).toBe(
          true,
        );
      expect((await passRow(p.id)).entriesUsed).toBe(
        statuses.filter((x) => x === 'recorded').length,
      );
    }
  });

  it('an offline and an online entry of one service vehicle: one left inside', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const plate = `ط ر ${6100 + round}`;
      const key = plate.replace(/\s/g, '');
      const { d, b } = await o.deviceWithBundle(s.guard, s.c);
      const [online, offline] = await Promise.all([
        o.serviceInRaw(s.guard, { plate }),
        o.upload(s.guard, s.c, d, [
          {
            clientId: newId(),
            seq: d.seq++,
            deviceTime: b.issuedAt,
            bundleId: b.bundleId,
            type: 'service_vehicle_in',
            plate,
            kind: 'waste',
            company: 'Race Waste',
          },
        ]),
      ]);
      expect(offline.results[0].status).toBe('recorded');
      // Online after the offline one: refused, it is inside. Before: closed.
      if (online.status === 201)
        expect(offline.results[0].flags).toEqual(['duplicate_inside']);
      else expect(online.status).toBe(409);
      expect(
        await o.inTx(s.c, (tx) =>
          tx.serviceVehicleVisit.count({
            where: { plateKey: key, exitedAt: null },
          }),
        ),
      ).toBe(1);
    }
  });
});
