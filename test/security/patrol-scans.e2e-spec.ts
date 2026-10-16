import { newId } from '../../src/core/common/uuid';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  patrolHelpers,
  type CheckpointBody,
  type RouteBody,
  type RunBody,
  type Who,
} from '../setup/patrols';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const MINUTE = 60_000;

interface ScanBody {
  id: string;
  checkpointId: string;
  position: number;
  method: string;
  positionSuspect: boolean | null;
  run: { status: string; scannedCount: number; checkpointsTotal: number };
}

interface StaffStop {
  checkpointId: string;
  scan: {
    method: string;
    manualReason: string | null;
    late: boolean;
    lat: number | null;
    distanceM: number | null;
    positionSuspect: boolean | null;
  } | null;
  note: {
    outcome: string;
    text: string | null;
    textCleared: boolean;
    photos: { url: string }[];
  } | null;
}

/**
 * ADR 0052: what a guard records on a run. A checkpoint's QR, its NFC tag
 * or a hand entry with a reason; the app's own id records once; the
 * device's time must fall in the run's lifetime; an ordered route in
 * order; each checkpoint once; a position far from the checkpoint kept
 * and flagged; the last scan completes the run. A note at a scan: an
 * outcome, words, photos.
 */
describe('Patrol scans and notes', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;
  let a: CheckpointBody & { qrPayload: string };
  let b: CheckpointBody & { qrPayload: string };
  let route: RouteBody;
  let ordered: RouteBody;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Scan Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
    a = await x.checkpoint(
      supervisor,
      { gateId },
      { position: { lat: 30.0444, lng: 31.2357, radiusM: 50 } },
    );
    b = await x.checkpoint(supervisor, { gateId });
    route = await x.route(supervisor, { gateId }, [a.id, b.id]);
    ordered = await x.route(supervisor, { gateId }, [a.id, b.id], {
      ordered: true,
    });
  }, 180_000);

  afterAll(() => h.close());

  async function walking(r: RouteBody = route) {
    const guard = await x.guard(s.c);
    await x.start(guard, { gateId });
    return { guard, run: await x.adhoc(guard, r.id) };
  }
  const staffRun = async (id: string) =>
    (
      await x
        .http('get', `/staff/security/patrols/runs/${id}`, s.manager.token)
        .expect(200)
    ).body as RunBody & {
      stops: StaffStop[];
      manualScans: number;
      suspectScans: number;
      lateScans: number;
    };

  it('by QR, then by NFC: the last checkpoint completes the run; nobody is told', async () => {
    const { guard, run } = await walking();
    const first = (
      await x
        .scanRaw(guard, run.id, {
          method: 'qr',
          payload: a.qrPayload,
          lat: 30.0445,
          lng: 31.2357,
          accuracyM: 8,
        })
        .expect(201)
    ).body as ScanBody;
    expect(first).toMatchObject({
      checkpointId: a.id,
      position: 1,
      method: 'qr',
      positionSuspect: false,
      run: { status: 'in_progress', scannedCount: 1, checkpointsTotal: 2 },
    });
    const last = (
      await x
        .scanRaw(guard, run.id, { method: 'nfc', payload: b.qrPayload })
        .expect(201)
    ).body as ScanBody;
    expect(last).toMatchObject({
      position: 2,
      method: 'nfc',
      positionSuspect: null,
      run: { status: 'completed', scannedCount: 2 },
    });
    expect(await x.told(s.c, supervisor.id, run.id)).toEqual([]);
    const detail = await staffRun(run.id);
    expect(detail.stops[0].scan).toMatchObject({
      lat: 30.0445,
      distanceM: 11,
      positionSuspect: false,
      late: false,
    });
  });

  it('the same id again answers the same; another content under it is 409', async () => {
    const { guard, run } = await walking();
    const body = {
      id: newId(),
      method: 'qr',
      payload: a.qrPayload,
      scannedAt: new Date().toISOString(),
    };
    const once = await x.scanRaw(guard, run.id, body).expect(201);
    const again = await x.scanRaw(guard, run.id, body).expect(201);
    expect(again.body).toEqual(once.body);
    expect((await x.runOf(s.c, run.id)).scannedCount).toBe(1);
    expect(
      code(
        await x.scanRaw(guard, run.id, {
          ...body,
          scannedAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
    ).toEqual({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      code(
        await x.scanRaw(guard, run.id, { method: 'qr', payload: a.qrPayload }),
      ),
    ).toEqual({ status: 409, code: 'PATROL_CHECKPOINT_ALREADY_SCANNED' });
  });

  it('an old printout, a malformed payload, another compound’s: one answer', async () => {
    const { guard, run } = await walking();
    const old = a.qrPayload;
    const fresh = (
      await x
        .http(
          'post',
          `/staff/security/patrols/checkpoints/${a.id}/reissue`,
          supervisor.token,
        )
        .expect(200)
    ).body as { qrPayload: string };
    const other = await x.setUp('Scan Other Court');
    const theirs = await x.checkpoint(other.manager, {
      gateId: (await x.g.gate(other.c)).id,
    });
    for (const payload of [
      old,
      'JWK1.nothing',
      theirs.qrPayload,
      `JWR1.${old.split('.')[2]}`,
    ])
      expect(
        code(await x.scanRaw(guard, run.id, { method: 'qr', payload })),
      ).toEqual({ status: 422, code: 'PATROL_CHECKPOINT_INVALID' });
    await x
      .scanRaw(guard, run.id, { method: 'qr', payload: fresh.qrPayload })
      .expect(201);
    a = { ...a, qrPayload: fresh.qrPayload };
  });

  it('by hand with a reason’s code; a checkpoint off the route is refused', async () => {
    const { guard, run } = await walking();
    expect(
      code(
        await x.scanRaw(guard, run.id, {
          method: 'manual',
          checkpointId: b.id,
        }),
      ),
    ).toEqual({ status: 400, code: 'REASON_REQUIRED' });
    const manual = (
      await x
        .scanRaw(guard, run.id, {
          method: 'manual',
          checkpointId: b.id,
          reasonCode: 'qr_damaged',
        })
        .expect(201)
    ).body as ScanBody;
    expect(manual).toMatchObject({ method: 'manual', position: 2 });
    const stray = await x.checkpoint(supervisor, { gateId });
    expect(
      code(
        await x.scanRaw(guard, run.id, {
          method: 'manual',
          checkpointId: stray.id,
          reasonCode: 'other',
        }),
      ),
    ).toEqual({ status: 422, code: 'PATROL_CHECKPOINT_NOT_ON_ROUTE' });
    const detail = await staffRun(run.id);
    expect(detail.manualScans).toBe(1);
    expect(detail.stops[1].scan).toMatchObject({
      method: 'manual',
      manualReason: 'qr_damaged',
    });
  });

  it('an ordered route takes its checkpoints in order, by the device’s time', async () => {
    const { guard, run } = await walking(ordered);
    const second = await x.scanRaw(guard, run.id, {
      method: 'qr',
      payload: b.qrPayload,
    });
    expect(code(second)).toEqual({ status: 422, code: 'PATROL_OUT_OF_ORDER' });
    expect((second.body as { params?: unknown }).params).toEqual({
      expected: 1,
    });
    const t = Date.now();
    await x
      .scanRaw(guard, run.id, {
        method: 'qr',
        payload: a.qrPayload,
        scannedAt: new Date(t).toISOString(),
      })
      .expect(201);
    expect(
      code(
        await x.scanRaw(guard, run.id, {
          method: 'qr',
          payload: b.qrPayload,
          scannedAt: new Date(t - 30_000).toISOString(),
        }),
      ),
    ).toEqual({ status: 422, code: 'PATROL_OUT_OF_ORDER' });
  });

  it('far from the checkpoint: kept and flagged; the guards never see where', async () => {
    const { guard, run } = await walking();
    const far = (
      await x
        .scanRaw(guard, run.id, {
          method: 'qr',
          payload: a.qrPayload,
          lat: 30.0554,
          lng: 31.2357,
        })
        .expect(201)
    ).body as ScanBody;
    expect(far.positionSuspect).toBe(true);
    const staff = await staffRun(run.id);
    expect(staff.suspectScans).toBe(1);
    expect(staff.stops[0].scan?.distanceM).toBeGreaterThan(1000);
    const own = (
      await x
        .http('get', `/gate/patrols/runs/${run.id}`, guard.token)
        .expect(200)
    ).body as { stops: { scan: Record<string, unknown> | null }[] };
    expect(own.stops[0].scan).toMatchObject({ positionSuspect: true });
    expect(own.stops[0].scan).not.toHaveProperty('lat');
    expect(own.stops[0].scan).not.toHaveProperty('distanceM');
  });

  it('a device time outside the run is refused; one received after the run ended is kept, the status as it was', async () => {
    const { guard, run } = await walking();
    expect(
      code(
        await x.scanRaw(guard, run.id, {
          method: 'qr',
          payload: a.qrPayload,
          scannedAt: new Date(Date.now() - 10 * MINUTE).toISOString(),
        }),
      ),
    ).toEqual({ status: 422, code: 'PATROL_SCAN_OUT_OF_WINDOW' });
    const scannedAt = new Date().toISOString();
    await x.endRunRaw(guard, run.id).expect(200);
    const late = (
      await x
        .scanRaw(guard, run.id, {
          method: 'qr',
          payload: a.qrPayload,
          scannedAt,
        })
        .expect(201)
    ).body as ScanBody;
    expect(late.run).toMatchObject({ status: 'incomplete', scannedCount: 1 });
    const staff = await staffRun(run.id);
    expect(staff.lateScans).toBe(1);
    expect(staff.stops[0].scan?.late).toBe(true);
  });

  it('a note at a scan: words and photos to its author and the management; a colleague sees its outcome', async () => {
    const { guard, run } = await walking();
    const colleague = await x.guard(s.c);
    await x.start(colleague, { gateId });
    const scan = (
      await x
        .scanRaw(guard, run.id, { method: 'qr', payload: a.qrPayload })
        .expect(201)
    ).body as ScanBody;
    const photo = await x.files.ready(guard.token, 'patrol_photo');
    const note = await x
      .noteRaw(guard, run.id, {
        scanId: scan.id,
        outcome: 'issue_found',
        text: 'The fence is cut by the pool',
        photoFileIds: [photo],
      })
      .expect(201);
    expect(note.body).toMatchObject({
      scanId: scan.id,
      outcome: 'issue_found',
      text: 'The fence is cut by the pool',
      photos: 1,
    });
    expect(code(await x.noteRaw(guard, run.id, { scanId: scan.id }))).toEqual({
      status: 409,
      code: 'PATROL_NOTE_EXISTS',
    });
    const staff = await staffRun(run.id);
    expect(staff.stops[0].note).toMatchObject({
      outcome: 'issue_found',
      text: 'The fence is cut by the pool',
      textCleared: false,
    });
    expect(staff.stops[0].note!.photos).toHaveLength(1);
    const mine = (
      await x
        .http('get', `/gate/patrols/runs/${run.id}`, guard.token)
        .expect(200)
    ).body as { stops: { note: Record<string, unknown> | null }[] };
    expect(mine.stops[0].note).toMatchObject({
      text: 'The fence is cut by the pool',
    });
    const theirs = (
      await x
        .http('get', `/gate/patrols/runs/${run.id}`, colleague.token)
        .expect(200)
    ).body as { stops: { note: Record<string, unknown> | null }[] };
    expect(theirs.stops[0].note).toEqual({
      id: expect.any(String) as string,
      outcome: 'issue_found',
    });
    expect(code(await x.noteRaw(guard, run.id, { scanId: newId() }))).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('only the run’s guard records on it', async () => {
    const { run } = await walking();
    const other = await x.guard(s.c);
    await x.start(other, { gateId });
    expect(
      code(
        await x.scanRaw(other, run.id, { method: 'qr', payload: a.qrPayload }),
      ),
    ).toEqual({ status: 404, code: 'PATROL_RUN_NOT_FOUND' });
  });
});
