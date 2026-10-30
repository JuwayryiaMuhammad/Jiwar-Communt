import { newId } from '../../src/core/common/uuid';
import { PATROL_WATCH_SWEEP } from '../../src/gate/patrols/patrol-sweeps';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { patrolHelpers, type RouteBody, type Who } from '../setup/patrols';
import { whileShiftEnds } from '../setup/shift-end';

const codeOf = (res: { body: unknown }) => (res.body as { code?: string }).code;

/**
 * ADR 0052, patrols decided one at a time: a run is started once whoever
 * asks together; a guard has one run under way; the watch and a start,
 * and a new version and a start, each see the other's commit; never a
 * deadlock. A start while the guard's shift ends takes the account, then
 * the shift, FOR SHARE (ADR 0056's lock order): it waits and is refused.
 */
describe('Patrols under concurrency', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;
  let route: RouteBody;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Patrol Race Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
    const point = await x.checkpoint(supervisor, { gateId });
    route = await x.route(supervisor, { gateId }, [point.id]);
  }, 180_000);

  afterAll(() => h.close());

  async function onShift() {
    const guard = await x.guard(s.c);
    await x.start(guard, { gateId });
    return guard;
  }

  it('two guards starting one run: one wins', async () => {
    for (let i = 0; i < 5; i++) {
      const a = await onShift();
      const b = await onShift();
      const run = await x.runRow(s.c, route, 0);
      const results = await Promise.all([
        x.startRunRaw(a, run.id),
        x.startRunRaw(b, run.id),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(codeOf(results.find((r) => r.status === 409)!)).toBe(
        'PATROL_ALREADY_STARTED',
      );
      const row = await x.runOf(s.c, run.id);
      const winner = results[0].status === 200 ? a : b;
      expect(row.guardAccountId).toBe(winner.id);
      await x.endRunRaw(winner, run.id).expect(200);
    }
  });

  it('one guard starting two runs at once: one is under way', async () => {
    for (let i = 0; i < 5; i++) {
      const guard = await onShift();
      const one = await x.runRow(s.c, route, 0);
      const two = await x.runRow(s.c, route, 1);
      const results = await Promise.all([
        x.startRunRaw(guard, one.id),
        x.adhocRaw(guard, route.id),
        x.startRunRaw(guard, two.id),
      ]);
      expect(results.filter((r) => r.status < 300)).toHaveLength(1);
      for (const r of results.filter((res) => res.status >= 300))
        expect([r.status, codeOf(r)]).toEqual([409, 'PATROL_RUN_ALREADY_LIVE']);
      const live = await x.inTx(s.c, (tx) =>
        tx.patrolRun.findMany({
          where: { guardAccountId: guard.id, status: 'in_progress' },
        }),
      );
      expect(live).toHaveLength(1);
      await x.endRunRaw(guard, live[0].id).expect(200);
    }
  });

  it('the watch racing a start at the window’s end: started, or missed; never both', async () => {
    for (let i = 0; i < 5; i++) {
      const guard = await onShift();
      // Its window ends within the next half second.
      const run = await x.runRow(s.c, route, 30 - (100 * i) / 60_000, 30);
      const [start] = await Promise.all([
        x.startRunRaw(guard, run.id),
        x.sweep(PATROL_WATCH_SWEEP, new Date(Date.now() + 500)),
      ]);
      // A look after the window: whatever the race left is judged.
      await new Promise((r) => setTimeout(r, 600));
      await x.sweep(PATROL_WATCH_SWEEP, new Date());
      const row = await x.runOf(s.c, run.id);
      if (start.status === 200) {
        expect(row.status).toBe('in_progress');
        await x.endRunRaw(guard, run.id).expect(200);
      } else {
        expect([start.status, codeOf(start)]).toEqual([
          409,
          'PATROL_RUN_NOT_STARTABLE',
        ]);
        expect(row.status).toBe('missed');
      }
    }
  });

  it('the watch racing a late start: late once, and under way', async () => {
    for (let i = 0; i < 5; i++) {
      const guard = await onShift();
      const run = await x.runRow(s.c, route, 16, 60);
      const [start] = await Promise.all([
        x.startRunRaw(guard, run.id),
        x.sweep(PATROL_WATCH_SWEEP, new Date()),
      ]);
      expect(start.status).toBe(200);
      const row = await x.runOf(s.c, run.id);
      expect(row.status).toBe('in_progress');
      expect(row.lateAt).not.toBeNull();
      await x.endRunRaw(guard, run.id).expect(200);
    }
  });

  it('a new version racing a start of its run: started on the old version, or cancelled; never both', async () => {
    for (let i = 0; i < 5; i++) {
      const point = await x.checkpoint(supervisor, { gateId });
      const r = await x.route(supervisor, { gateId }, [point.id]);
      const guard = await onShift();
      const run = await x.runRow(s.c, r, 0);
      const [start, version] = await Promise.all([
        x.startRunRaw(guard, run.id),
        x.versionRaw(supervisor, r.id, {
          checkpointIds: [point.id],
          ordered: true,
          expectedMinutes: 40,
        }),
      ]);
      expect(version.status).toBe(200);
      const row = await x.runOf(s.c, run.id);
      if (start.status === 200) {
        expect(row).toMatchObject({
          status: 'in_progress',
          versionId: r.version.id,
        });
        await x.endRunRaw(guard, run.id).expect(200);
      } else {
        expect([start.status, codeOf(start)]).toEqual([
          409,
          'PATROL_RUN_NOT_STARTABLE',
        ]);
        expect(row).toMatchObject({
          status: 'cancelled',
          cancelReason: 'route_changed',
        });
      }
    }
  });

  it('the same scan sent twice at once: recorded once, one answer', async () => {
    const one = await x.checkpoint(supervisor, { gateId });
    const two = await x.checkpoint(supervisor, { gateId });
    const pair = await x.route(supervisor, { gateId }, [one.id, two.id]);
    for (let i = 0; i < 5; i++) {
      const guard = await onShift();
      const run = await x.adhoc(guard, pair.id);
      const body = {
        id: newId(),
        method: 'qr',
        payload: one.qrPayload,
        scannedAt: new Date().toISOString(),
      };
      const results = await Promise.all([
        x.scanRaw(guard, run.id, body),
        x.scanRaw(guard, run.id, body),
      ]);
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      expect(results[1].body).toEqual(results[0].body);
      const scans = await x.inTx(s.c, (tx) =>
        tx.patrolScan.count({ where: { runId: run.id } }),
      );
      expect(scans).toBe(1);
      expect((await x.runOf(s.c, run.id)).scannedCount).toBe(1);
      await x.endRunRaw(guard, run.id).expect(200);
    }
  });

  it('a reissue racing a scan of the old printout: accepted before it, or refused after', async () => {
    for (let i = 0; i < 5; i++) {
      const point = await x.checkpoint(supervisor, { gateId });
      const r = await x.route(supervisor, { gateId }, [point.id]);
      const guard = await onShift();
      const run = await x.adhoc(guard, r.id);
      const [scan, reissue] = await Promise.all([
        x.scanRaw(guard, run.id, { method: 'qr', payload: point.qrPayload }),
        x.http(
          'post',
          `/staff/security/patrols/checkpoints/${point.id}/reissue`,
          supervisor.token,
        ),
      ]);
      expect(reissue.status).toBe(200);
      const issued = new Date(
        (reissue.body as { tokenIssuedAt: string }).tokenIssuedAt,
      );
      if (scan.status === 201) {
        const row = await x.inTx(s.c, (tx) =>
          tx.patrolScan.findUniqueOrThrow({
            where: { id: (scan.body as { id: string }).id },
          }),
        );
        expect(row.receivedAt.getTime()).toBeLessThanOrEqual(issued.getTime());
      } else {
        expect([scan.status, codeOf(scan)]).toEqual([
          422,
          'PATROL_CHECKPOINT_INVALID',
        ]);
        await x.endRunRaw(guard, run.id).expect(200);
      }
    }
  });

  it('a shift’s end racing a scan: the run ends with the scan counted, or the scan is kept after it', async () => {
    const one = await x.checkpoint(supervisor, { gateId });
    const two = await x.checkpoint(supervisor, { gateId });
    const pair = await x.route(supervisor, { gateId }, [one.id, two.id]);
    for (let i = 0; i < 5; i++) {
      const guard = await onShift();
      const run = await x.adhoc(guard, pair.id);
      const [scan, end] = await Promise.all([
        x.scanRaw(guard, run.id, { method: 'qr', payload: one.qrPayload }),
        x.endRaw(guard),
      ]);
      expect(end.status).toBe(200);
      expect(scan.status).toBe(201);
      const row = await x.runOf(s.c, run.id);
      expect(row).toMatchObject({
        status: 'incomplete',
        endReason: 'shift_ended',
        scannedCount: 1,
      });
    }
  });

  describe('a start while the guard’s shift ends: it waits for the end, then is refused', () => {
    const leavingGuard = async () => {
      const guard = await x.guard(s.c);
      const shift = await x.start(guard, { gateId });
      return { guard, shiftId: shift.id };
    };

    it('a scheduled run', async () => {
      const { guard, shiftId } = await leavingGuard();
      const run = await x.runRow(s.c, route, 0);
      const res = await whileShiftEnds(shiftId, () =>
        x.startRunRaw(guard, run.id),
      );
      expect(res.status).toBe(403);
      expect(codeOf(res)).toBe('NO_OPEN_SHIFT');
      expect((await x.runOf(s.c, run.id)).guardAccountId).toBeNull();
    });

    it('an ad-hoc run', async () => {
      const { guard, shiftId } = await leavingGuard();
      const res = await whileShiftEnds(shiftId, () =>
        x.adhocRaw(guard, route.id),
      );
      expect(res.status).toBe(403);
      expect(codeOf(res)).toBe('NO_OPEN_SHIFT');
      expect(
        await x.inTx(s.c, (tx) =>
          tx.patrolRun.count({ where: { guardAccountId: guard.id } }),
        ),
      ).toBe(0);
    });
  });
});
