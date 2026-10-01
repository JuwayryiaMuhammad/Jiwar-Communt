import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { UNCONFIRMED_EXITS_SWEEP } from '../../src/gate/entries/entries.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths } from './keys';
import { call, err } from './request';
import { workerBody } from './routes/workers';
import { buildWorld, type World } from './world';

const ALWAYS = {
  days: [0, 1, 2, 3, 4, 5, 6],
  windows: [{ from: '05:00', to: '04:59' }],
};
/** The compound's local date (Africa/Cairo, the default). */
const localDate = (at = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
const today = () => localDate();

describe('API v0 — workers at the gate: notifications and attendance (ADR 0028)', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const guard = () => w.a.tokens.guard;

  /** A unit with a primary, a family member, and an approved worker. */
  async function household() {
    const unit = await w.helpers.unit(w.a);
    const primary = await w.helpers.resident(w.a, [unit.id]);
    const member = await w.helpers.joinFamily(w.a, unit.id, primary);
    const landlordUnit = unit.id;
    const token = await w.tokenFor(w.a, primary.id, 'resident');
    const registered = await call(w, 'POST', `/units/${unit.id}/workers`, {
      token,
      body: { ...workerBody(), schedule: ALWAYS },
    }).expect(201);
    const engagementId = (registered.body as { engagementId: string })
      .engagementId;
    await call(w, 'POST', `/worker-engagements/${engagementId}/review`, {
      token: w.a.tokens.manager,
      body: { decision: 'approve' },
    }).expect(200);
    return {
      unitId: landlordUnit,
      primaryId: primary.id,
      memberId: member.id,
      token,
      engagementId,
    };
  }
  const move = (
    engagementId: string,
    direction: 'in' | 'out',
    occurredAt?: Date,
  ) =>
    call(w, 'POST', '/gate/entries', {
      token: guard(),
      body: {
        subjectType: 'worker_engagement',
        subjectId: engagementId,
        direction,
        ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}),
      },
    }).expect(201);
  const notifications = (engagementId: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.notification.findMany({
        where: { targetId: engagementId },
        orderBy: [{ createdAt: 'asc' }, { accountId: 'asc' }],
      }),
    );

  it('the people who live there are told when the worker comes and goes', async () => {
    const x = await household();
    await move(x.engagementId, 'in');
    await move(x.engagementId, 'out');
    const rows = await notifications(x.engagementId);
    const byKind = (kind: string) =>
      rows
        .filter((n) => n.kind === kind)
        .map((n) => n.accountId)
        .sort();
    const residents = [x.primaryId, x.memberId].sort();
    expect(byKind('worker.entered')).toEqual(residents);
    expect(byKind('worker.exited')).toEqual(residents);
    expect(rows[0]).toMatchObject({
      priority: 'normal',
      targetType: 'worker_engagement',
      params: {
        unitCode: expect.any(String) as string,
        gateName: w.a.gateName,
        workerName: 'Api Worker',
      },
    });
  });

  it('attendance: days from the gate log, dates and times only', async () => {
    const x = await household();
    const now = Date.now();
    await move(x.engagementId, 'in', new Date(now - 3 * 3_600_000));
    await move(x.engagementId, 'out', new Date(now - 2 * 3_600_000));
    await move(x.engagementId, 'in', new Date(now - 60 * 60_000));
    const path = `/worker-engagements/${x.engagementId}/attendance`;
    const res = await call(w, 'GET', path, { token: x.token }).expect(200);
    expect(keyPaths(res.body)).toEqual([
      'days',
      'days[].date',
      'days[].firstIn',
      'days[].fullDay',
      'days[].lastOut',
      'days[].unconfirmedExit',
      'engagementId',
      'from',
      'to',
      'totalDays',
    ]);
    const body = res.body as {
      to: string;
      totalDays: number;
      days: { firstIn: string; lastOut: string; fullDay: boolean }[];
    };
    expect(body.to).toBe(today());
    expect(body.totalDays).toBeGreaterThanOrEqual(1);
    const last = body.days[body.days.length - 1];
    // Still inside after the second visit: not a full day yet.
    expect(last.fullDay).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(w.a.gateName);
    expect(JSON.stringify(res.body)).not.toContain(w.a.ids.guard);

    // The system closes the visit: an unconfirmed exit, still not a full day.
    await h.moduleRef
      .get(SweepRunner)
      .run(UNCONFIRMED_EXITS_SWEEP, new Date(now + 13 * 3_600_000));
    // The day of the open visit (it may be yesterday just after midnight).
    const day = localDate(new Date(now - 60 * 60_000));
    const after = await call(w, 'GET', path, {
      token: w.a.tokens.manager,
      query: { from: day, to: day },
    }).expect(200);
    expect(
      (after.body as { days: { unconfirmedExit: boolean; fullDay: boolean }[] })
        .days,
    ).toEqual([
      expect.objectContaining({ unconfirmedExit: true, fullDay: false }),
    ]);
  });

  it('a full day, the range limits, and who may look', async () => {
    const x = await household();
    const now = Date.now();
    await move(x.engagementId, 'in', new Date(now - 2 * 3_600_000));
    await move(x.engagementId, 'out', new Date(now - 60 * 60_000));
    const path = `/worker-engagements/${x.engagementId}/attendance`;
    const res = await call(w, 'GET', path, { token: x.token }).expect(200);
    // Days are keyed by the entry's local date.
    const day = localDate(new Date(now - 2 * 3_600_000));
    expect(
      (
        res.body as {
          days: { date: string; fullDay: boolean; unconfirmedExit: boolean }[];
        }
      ).days.find((d) => d.date === day),
    ).toEqual(
      expect.objectContaining({ fullDay: true, unconfirmedExit: false }),
    );
    const tooLong = await call(w, 'GET', path, {
      token: x.token,
      query: { from: '2026-01-01', to: '2026-06-01' },
    });
    expect(err(tooLong).fields).toEqual([
      { field: 'to', code: 'INVALID_VALUE', params: { maxDays: 93 } },
    ]);
    const backwards = await call(w, 'GET', path, {
      token: x.token,
      query: { from: '2026-06-02', to: '2026-06-01' },
    });
    expect(err(backwards).fields).toEqual([
      { field: 'to', code: 'INVALID_VALUE', params: { maxDays: 93 } },
    ]);
    // Someone with no say over this worker.
    const stranger = await call(w, 'GET', path, { token: w.a.tokens.owner });
    expect([403, 404]).toContain(stranger.status);
  });
});
