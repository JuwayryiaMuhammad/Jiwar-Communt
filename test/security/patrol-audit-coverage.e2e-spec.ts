import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { newId } from '../../src/core/common/uuid';
import { PATROL_WATCH_SWEEP } from '../../src/gate/patrols/patrol-sweeps';
import { PATROL_TRACK_PURGE_SWEEP } from '../../src/gate/patrols/patrol-track.service';
import { auditReaders } from '../setup/audit';
import { eraseNow } from '../setup/erasure';
import {
  COMMUNITY_COVERAGE,
  ENGAGEMENT_COVERAGE,
  FACILITIES_COVERAGE,
  FILES_COVERAGE,
  FINANCE_COVERAGE,
  GUARD_DUTY_COVERAGE,
  MAINTENANCE_COVERAGE,
  MANAGEMENT_COVERAGE,
  NEIGHBOURS_COVERAGE,
  PARCELS_COVERAGE,
  PATROL_COVERAGE,
  PERMITS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
  SAFETY_COVERAGE,
  VEHICLES_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { patrolHelpers, type Who } from '../setup/patrols';
import { leakText } from '../setup/leak-text';

/**
 * One scenario per patrols catalog entry (ADR 0014, 0052): actor, target
 * and metadata — ids, codes and counts by value; names and positions as
 * changed; never a token, a hash or what someone wrote.
 */
const covered = new Set<string>();

/** Words typed in every scenario: no audit row may hold them. */
const WORDS = 'Audit-visible patrol words 7741';

describe('Audit coverage — patrols', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;
  let supervisor: Who;
  let gateId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Patrol Audit Court');
    read = auditReaders(h);
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
  }, 180_000);

  afterAll(() => h.close());

  async function rows(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    for (const row of found) expect(JSON.stringify(row)).not.toContain(WORDS);
    return found;
  }
  async function single(action: string, targetId: string) {
    const found = await rows(action, targetId);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const by = (who: Who, targetType: string) => ({
    actorType: 'account',
    actorId: who.id,
    targetType,
  });
  const system = (targetType: string) => ({
    actorType: 'system',
    actorId: null,
    targetType,
  });

  describe('checkpoints', () => {
    it('created, updated, reissued and retired: the post by value, names and position as changed, never the token', async () => {
      const made = await x.checkpoint(
        supervisor,
        { gateId },
        { nameEn: `${WORDS} en`, position: { lat: 30.5, lng: 31.5 } },
      );
      const token = made.qrPayload.split('.')[2];
      const created = await single('patrol_checkpoint.created', made.id);
      expect(created).toMatchObject(by(supervisor, 'patrol_checkpoint'));
      expect(created.changes).toEqual({
        gateId: { from: null, to: gateId },
        nameEn: { changed: true },
        nameAr: { changed: true },
        lat: { changed: true },
        lng: { changed: true },
        radiusM: { from: null, to: 30 },
      });
      const path = `/staff/security/patrols/checkpoints/${made.id}`;
      await x
        .http('patch', path, supervisor.token, {
          nameAr: `${WORDS} ar`,
          position: null,
        })
        .expect(200);
      const updated = await single('patrol_checkpoint.updated', made.id);
      expect(updated.changes).toEqual({
        nameAr: { changed: true },
        lat: { changed: true },
        lng: { changed: true },
        radiusM: { from: 30, to: null },
      });
      const again = (
        await x.http('post', `${path}/reissue`, supervisor.token).expect(200)
      ).body as { qrPayload: string };
      const reissued = await single(
        'patrol_checkpoint.token_reissued',
        made.id,
      );
      expect(reissued).toMatchObject(by(supervisor, 'patrol_checkpoint'));
      await x.http('post', `${path}/retire`, supervisor.token).expect(200);
      const retired = await single('patrol_checkpoint.retired', made.id);
      expect(retired).toMatchObject(by(supervisor, 'patrol_checkpoint'));
      for (const row of await read.tenant(s.c.tenantId, { targetId: made.id }))
        for (const secret of [token, again.qrPayload.split('.')[2]])
          expect(JSON.stringify(row)).not.toContain(secret);
    });
  });

  describe('routes', () => {
    it('created, renamed, versioned and retired: the post and counts by value, names as changed', async () => {
      const one = await x.checkpoint(supervisor, { gateId });
      const two = await x.checkpoint(supervisor, { gateId });
      const route = (
        await x
          .http('post', '/staff/security/patrols/routes', supervisor.token, {
            gateId,
            nameEn: `${WORDS} route`,
            nameAr: 'جولة التدقيق',
            version: {
              checkpointIds: [one.id],
              ordered: true,
              expectedMinutes: 20,
            },
          })
          .expect(201)
      ).body as { id: string };
      const created = await single('patrol_route.created', route.id);
      expect(created).toMatchObject(by(supervisor, 'patrol_route'));
      expect(created.changes).toEqual({
        gateId: { from: null, to: gateId },
        nameEn: { changed: true },
        nameAr: { changed: true },
      });
      expect(created.metadata).toEqual({
        version: 1,
        checkpoints: 1,
        ordered: true,
        expectedMinutes: 20,
        scheduled: false,
        runs: 0,
      });
      const path = `/staff/security/patrols/routes/${route.id}`;
      await x
        .http('patch', path, supervisor.token, { nameAr: `${WORDS} ar` })
        .expect(200);
      const renamed = await single('patrol_route.renamed', route.id);
      expect(renamed.changes).toEqual({ nameAr: { changed: true } });
      await x
        .http('post', `${path}/versions`, supervisor.token, {
          checkpointIds: [two.id, one.id],
          ordered: false,
          expectedMinutes: 40,
          schedule: { days: [1], times: ['03:00'] },
        })
        .expect(200);
      const versioned = await single('patrol_route.versioned', route.id);
      expect(versioned).toMatchObject(by(supervisor, 'patrol_route'));
      expect(versioned.metadata).toEqual({
        version: 2,
        checkpoints: 2,
        ordered: false,
        expectedMinutes: 40,
        scheduled: true,
        cancelledRuns: 0,
        runs: expect.any(Number) as number,
      });
      const runs = (versioned.metadata as { runs: number }).runs;
      expect(runs).toBeGreaterThanOrEqual(1);
      await x.http('post', `${path}/retire`, supervisor.token).expect(200);
      const retired = await single('patrol_route.retired', route.id);
      expect(retired).toMatchObject(by(supervisor, 'patrol_route'));
      expect(retired.metadata).toEqual({ cancelledRuns: runs });
    });
  });

  describe('runs', () => {
    let runGate: string;
    let route: Awaited<ReturnType<typeof x.route>>;
    let guard: Who;

    beforeAll(async () => {
      runGate = (await x.g.gate(s.c)).id;
      const one = await x.checkpoint(supervisor, { gateId: runGate });
      const two = await x.checkpoint(supervisor, { gateId: runGate });
      route = await x.route(supervisor, { gateId: runGate }, [one.id, two.id]);
      guard = await x.guard(s.c);
      await x.start(guard, { gateId: runGate });
    });

    it('started late and ended short by the guard: codes and counts', async () => {
      const run = await x.runRow(s.c, route, 20);
      await x.startRunRaw(guard, run.id).expect(200);
      const shift = await x.inTx(s.c, (tx) =>
        tx.guardShift.findFirstOrThrow({
          where: { guardAccountId: guard.id, endedAt: null },
        }),
      );
      const started = await single('patrol_run.started', run.id);
      expect(started).toMatchObject(by(guard, 'patrol_run'));
      expect(started.metadata).toEqual({
        kind: 'scheduled',
        shiftId: shift.id,
        late: true,
      });
      await x.endRunRaw(guard, run.id).expect(200);
      const ended = await single('patrol_run.ended', run.id);
      expect(ended).toMatchObject(by(guard, 'patrol_run'));
      expect(ended.metadata).toEqual({
        status: 'incomplete',
        scanned: 0,
        total: 2,
        reason: 'guard',
        recipients: 2,
      });
    });

    it('cancelled by the management with its code, and by the watch at a post out of service', async () => {
      const run = await x.runRow(s.c, route, -120);
      await x
        .http(
          'post',
          `/staff/security/patrols/runs/${run.id}/cancel`,
          supervisor.token,
          { reasonCode: 'not_needed' },
        )
        .expect(200);
      const cancelled = await single('patrol_run.cancelled', run.id);
      expect(cancelled).toMatchObject(by(supervisor, 'patrol_run'));
      expect(cancelled.metadata).toEqual({ reason: 'not_needed' });

      const away = (await x.g.gate(s.c)).id;
      const point = await x.checkpoint(supervisor, { gateId: away });
      const there = await x.route(supervisor, { gateId: away }, [point.id]);
      const closed = await x.runRow(s.c, there, 31, 30);
      await x
        .http('patch', `/gates/${away}`, s.manager.token, {
          status: 'inactive',
        })
        .expect(200);
      await x.sweep(PATROL_WATCH_SWEEP, new Date());
      const system1 = await single('patrol_run.cancelled', closed.id);
      expect(system1).toMatchObject(system('patrol_run'));
      expect(system1.metadata).toEqual({ reason: 'post_out_of_service' });
    });

    it('late, missed and timed out by the watch: how many were told', async () => {
      const late = await x.runRow(s.c, route, 16, 60);
      const missed = await x.runRow(s.c, route, 31, 30);
      const other = await x.guard(s.c);
      await x.start(other, { gateId: runGate });
      const shift = await x.inTx(s.c, (tx) =>
        tx.guardShift.findFirstOrThrow({
          where: { guardAccountId: other.id, endedAt: null },
        }),
      );
      const startedAt = new Date(Date.now() - 61 * 60_000);
      const long = newId();
      await x.inTx(s.c, (tx) =>
        tx.patrolRun.create({
          data: {
            id: long,
            tenantId: s.c.tenantId,
            routeId: route.id,
            versionId: route.version.id,
            gateId: runGate,
            kind: 'adhoc',
            plannedAt: startedAt,
            status: 'in_progress',
            guardAccountId: other.id,
            shiftId: shift.id,
            startedAt,
            checkpointsTotal: 2,
          },
        }),
      );
      await x.sweep(PATROL_WATCH_SWEEP, new Date());
      const l = await single('patrol_run.late', late.id);
      expect(l).toMatchObject(system('patrol_run'));
      expect(l.metadata).toEqual({ recipients: 2 });
      const m = await single('patrol_run.missed', missed.id);
      expect(m).toMatchObject(system('patrol_run'));
      expect(m.metadata).toEqual({ recipients: 2 });
      const t = await single('patrol_run.timed_out', long);
      expect(t).toMatchObject(system('patrol_run'));
      expect(t.metadata).toEqual({
        status: 'timed_out',
        scanned: 0,
        total: 2,
        recipients: 2,
      });
    });
  });

  it('the track points’ purge: how many went, never where', async () => {
    const gate = (await x.g.gate(s.c)).id;
    const point = await x.checkpoint(supervisor, { gateId: gate });
    const r = await x.route(supervisor, { gateId: gate }, [point.id]);
    const walker = await x.guard(s.c);
    await x.start(walker, { gateId: gate });
    const run = await x.adhoc(walker, r.id);
    // Two points recorded 31 days ago: the purge's due ones.
    for (const lat of [30.1, 30.2])
      await x.inTx(s.c, (tx) =>
        tx.patrolTrackPoint.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            runId: run.id,
            guardAccountId: walker.id,
            recordedAt: new Date(Date.now() - 31 * 86_400_000 - lat * 1000),
            lat,
            lng: 31.1,
            receivedAt: new Date(),
          },
        }),
      );
    await x.sweep(PATROL_TRACK_PURGE_SWEEP, new Date());
    const purged = await read.tenant(s.c.tenantId, {
      action: 'patrol_track.purged',
    });
    covered.add('patrol_track.purged');
    expect(purged).toHaveLength(1);
    expect(purged[0]).toMatchObject({
      ...system('patrol_run'),
      targetId: null,
    });
    expect(purged[0].metadata).toEqual({ points: 2 });
    expect(leakText(purged[0])).not.toContain('30.1');
  });

  it('a guard’s erasure: their notes’ words go, by id; their track, how many', async () => {
    const gate = (await x.g.gate(s.c)).id;
    const point = await x.checkpoint(supervisor, { gateId: gate });
    const r = await x.route(supervisor, { gateId: gate }, [point.id]);
    const leaving = await x.guard(s.c);
    await x.start(leaving, { gateId: gate });
    const run = await x.adhoc(leaving, r.id);
    const scan = (
      await x
        .scanRaw(leaving, run.id, { method: 'qr', payload: point.qrPayload })
        .expect(201)
    ).body as { id: string };
    const note = (
      await x
        .noteRaw(leaving, run.id, { scanId: scan.id, text: WORDS })
        .expect(201)
    ).body as { id: string };
    await x
      .http('post', `/gate/patrols/runs/${run.id}/track`, leaving.token, {
        points: [{ recordedAt: new Date().toISOString(), lat: 30, lng: 31 }],
      })
      .expect(200);
    await x
      .http('patch', `/accounts/${leaving.id}/status`, s.manager.token, {
        status: 'inactive',
      })
      .expect(200);
    await eraseNow(h, s.c, leaving.id);
    const cleared = await single('patrol_note.text_cleared', note.id);
    expect(cleared.targetType).toBe('patrol_note');
    const erased = await single('patrol_track.erased', leaving.id);
    expect(erased.targetType).toBe('account');
    expect(erased.metadata).toEqual({ points: 1 });
  });

  describe('catalog completeness', () => {
    it('every patrols entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of PATROL_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
          ...FILES_COVERAGE,
          ...MAINTENANCE_COVERAGE,
          ...PARCELS_COVERAGE,
          ...R1_COVERAGE,
          ...RESIDENT_SCREENS_COVERAGE,
          ...MANAGEMENT_COVERAGE,
          ...ENGAGEMENT_COVERAGE,
          ...NEIGHBOURS_COVERAGE,
          ...FACILITIES_COVERAGE,
          ...VEHICLES_COVERAGE,
          ...FINANCE_COVERAGE,
          ...SAFETY_COVERAGE,
          ...PERMITS_COVERAGE,
          ...GUARD_DUTY_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...PATROL_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(all.filter((k) => /^patrol_[a-z_]+\./.test(k)).sort()).toEqual(
        [...PATROL_COVERAGE].sort(),
      );
    });
  });
});
