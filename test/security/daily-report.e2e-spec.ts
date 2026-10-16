import { newId } from '../../src/core/common/uuid';
import { ROSTER_ATTENDANCE_SWEEP } from '../../src/gate/roster/roster-attendance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitRow } from '../setup/permits-rows';
import { securityHelpers, type Who } from '../setup/security';
import { dbClock, localDay } from '../setup/compound-clock';

const day = (at: Date | string) => localDay(new Date(at));

interface PostRow {
  post: { gateId: string | null; zone: { id: string } | null };
  shifts: {
    guard: { id: string };
    late: boolean;
    unscheduledMinutes: number | null;
  }[];
  counts: Record<string, number | null>;
}

/**
 * ADR 0050: the daily report per gate and per zone — shifts, lateness and
 * absence, tasks, emergencies, gate services, visitors and the permits'
 * traffic (ADR 0049) — as JSON and as
 * CSV (R6b's writer, the BFF's download path). Each assertion reads the
 * compound's day its rows fall on, so the run never depends on the hour.
 */
describe('The daily report', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Daily Report Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
  }, 120_000);

  afterAll(() => h.close());

  const report = async (date: string, extra = '') =>
    (
      (
        await x
          .http(
            'get',
            `/staff/security/reports/daily?date=${date}${extra}`,
            supervisor.token,
          )
          .expect(200)
      ).body as { date: string; posts: PostRow[] }
    ).posts;
  const gateRow = (posts: PostRow[], id = gateId) =>
    posts.find((p) => p.post.gateId === id)!;

  it('the slots of the day: filled, late, absent', async () => {
    const late = await x.guard(s.c);
    const lateSlot = await x.pastSlot(s.c, late.id, { gateId }, 20);
    await x.start(late, { gateId });
    await x.endRaw(late).expect(200);
    const absentSlot = await x.pastSlot(
      s.c,
      (await x.guard(s.c)).id,
      { gateId },
      70,
    );
    await x.sweep(ROSTER_ATTENDANCE_SWEEP, new Date());
    const lateDay = gateRow(await report(day(lateSlot.startsAt)));
    expect(lateDay.counts).toMatchObject({ late: 1 });
    expect(lateDay.counts.filledSlots).toBeGreaterThanOrEqual(1);
    const absentDay = gateRow(await report(day(absentSlot.startsAt)));
    expect(absentDay.counts.absent).toBeGreaterThanOrEqual(1);
    expect(absentDay.counts.scheduledSlots).toBeGreaterThanOrEqual(1);
  });

  it('shifts, tasks, emergencies, gate services and visitors of today', async () => {
    const guard = await x.guard(s.c);
    const shift = await x.start(guard, { gateId });
    const today = day(shift.startedAt);
    // A task made and done, another left open.
    const done = (
      await x
        .http('post', '/staff/security/tasks', supervisor.token, {
          kind: 'custom',
          title: 'Done one',
          gateId,
        })
        .expect(201)
    ).body as { id: string };
    await x
      .http('post', `/gate/tasks/${done.id}/take`, guard.token)
      .expect(200);
    await x
      .http('post', `/gate/tasks/${done.id}/complete`, guard.token, {
        outcome: 'done',
      })
      .expect(200);
    await x
      .http('post', '/staff/security/tasks', supervisor.token, {
        kind: 'custom',
        title: 'Open one',
        gateId,
      })
      .expect(201);
    // An emergency answered from the gate; an escort accepted there.
    const emergency = await x.report(s.alice, s.home.id, 'medical');
    await x
      .http('post', `/gate/emergencies/${emergency.id}/accept`, guard.token, {
        etaMinutes: 5,
      })
      .expect(200);
    const places = await x.places(s.alice);
    const escort = (
      await x
        .http('post', '/escort-requests', s.alice.token, {
          unitId: s.home.id,
          fromPlaceId: places.main_gate.id,
          toPlaceId: places.clubhouse.id,
          when: 'now',
        })
        .expect(201)
    ).body as { id: string };
    await x
      .http('post', `/gate/gate-services/${escort.id}/accept`, guard.token, {
        etaMinutes: 5,
      })
      .expect(200);
    // Two visitors in, one out, one worker in: two visitors.
    await x.inTx(s.c, async (tx) => {
      for (const [subjectType, direction] of [
        ['visitor_pass', 'in'],
        ['gate_request', 'in'],
        ['visitor_pass', 'out'],
        ['worker_engagement', 'in'],
      ] as const)
        await tx.gateEntry.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            gateId,
            subjectType,
            subjectId: newId(),
            unitId: s.home.id,
            direction,
            method: direction === 'in' ? 'code' : 'guard',
            guardAccountId: guard.id,
            shiftId: shift.id,
            occurredAt: new Date(),
          },
        });
    });
    // An unscheduled shift that ended.
    const other = await x.guard(s.c);
    await x.start(other, { gateId });
    await x.endRaw(other).expect(200);

    const row = gateRow(await report(today));
    expect(row.shifts.map((sh) => sh.guard.id)).toEqual(
      expect.arrayContaining([guard.id, other.id]),
    );
    expect(row.counts).toMatchObject({
      tasksCreated: 2,
      tasksDone: 1,
      tasksOpen: 1,
      emergencies: 1,
      gateServices: 1,
      visitors: 2,
    });
    expect(row.counts.unscheduledShifts).toBeGreaterThanOrEqual(1);

    // One gate only; another gate with nothing is listed, with zeros.
    const empty = (await x.g.gate(s.c)).id;
    const all = await report(today);
    expect(gateRow(all, empty).counts).toMatchObject({
      visitors: 0,
      emergencies: 0,
    });
    const only = await report(today, `&gateId=${gateId}`);
    expect(only.map((p) => p.post.gateId)).toEqual([gateId]);
    await x.endRaw(guard).expect(200);
  });

  it('the permits’ traffic (ADR 0049), each its own count, never in visitors', async () => {
    // A gate of its own, so that every count is exact.
    const at = (await x.g.gate(s.c)).id;
    const guard = await x.guard(s.c);
    const shift = await x.start(guard, { gateId: at });
    await x.inTx(s.c, async (tx) => {
      const entry = (
        subjectType: 'permit_worker' | 'event_guest' | 'move_permit',
        direction: 'in' | 'out' = 'in',
      ) =>
        tx.gateEntry.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            gateId: at,
            subjectType,
            subjectId: newId(),
            unitId: s.home.id,
            direction,
            method: direction === 'in' ? 'permit' : 'guard',
            guardAccountId: guard.id,
            shiftId: shift.id,
            occurredAt: new Date(),
          },
        });
      // One of each in; a worker's way out counts for nothing.
      await entry('permit_worker');
      await entry('permit_worker', 'out');
      await entry('event_guest');
      await entry('move_permit');
      await tx.materialEntry.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          unitId: s.home.id,
          gateId: at,
          shiftId: shift.id,
          guardAccountId: guard.id,
          description: 'Two bags of cement',
          occurredAt: new Date(),
        },
      });
      // A material exit, approved then let out here.
      const exit = await permitRow(tx, {
        tenantId: s.c.tenantId,
        unitId: s.home.id,
        requestedById: s.alice.id,
        kind: 'material_exit',
        data: { startsAt: new Date(Date.now() - 3_600_000) },
      });
      await tx.unitPermit.update({
        where: { id: exit },
        data: {
          status: 'approved',
          decisionSource: 'manager',
          decidedById: s.manager.id,
          decidedAt: new Date(),
        },
      });
      await tx.unitPermit.update({
        where: { id: exit },
        data: {
          status: 'used',
          usedAt: new Date(),
          usedById: guard.id,
          usedGateId: at,
        },
      });
    });
    const today = day(shift.startedAt);
    expect(gateRow(await report(today), at).counts).toMatchObject({
      visitors: 0,
      contractorWorkers: 1,
      eventGuests: 1,
      moveTrucks: 1,
      materialEntries: 1,
      materialExits: 1,
    });
    // A zone has none of them: a gate's, null.
    const zoneId = (await x.places(s.alice)).clubhouse.id;
    const patrol = await x.guard(s.c);
    await x.start(patrol, { zoneId });
    const zone = (await report(today)).find((p) => p.post.zone?.id === zoneId);
    expect(zone).toBeDefined();
    expect(zone!.counts).toMatchObject({
      visitors: null,
      contractorWorkers: null,
      eventGuests: null,
      moveTrucks: null,
      materialEntries: null,
      materialExits: null,
    });
    // And the CSV carries them, each its own column.
    const csv = (
      await x
        .http(
          'get',
          `/staff/security/reports/daily/export?date=${today}&gateId=${at}`,
          supervisor.token,
        )
        .buffer(true)
        .parse((r, done) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200)
    ).body as Buffer;
    const [head, row] = csv.toString('utf8').slice(1).trimEnd().split('\r\n');
    const cells = Object.fromEntries(
      head.split(',').map((k, i) => [k, row.split(',')[i]]),
    );
    expect(cells).toMatchObject({
      visitors: '0',
      contractor_workers: '1',
      event_guests: '1',
      move_trucks: '1',
      material_entries: '1',
      material_exits: '1',
    });
    await x.endRaw(patrol).expect(200);
    await x.endRaw(guard).expect(200);
  });

  it('as CSV: a byte-order mark, a header row, one row per post, its name', async () => {
    const today = day(dbClock());
    const res = await x
      .http(
        'get',
        `/staff/security/reports/daily/export?date=${today}&gateId=${gateId}`,
        supervisor.token,
      )
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="security-daily-${today}.csv"`,
    );
    const text = (res.body as Buffer).toString('utf8');
    expect(text.startsWith('﻿')).toBe(true);
    const lines = text.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'date,post_type,post,shifts,scheduled_slots,filled_slots,late,absent,unscheduled_shifts,overtime_minutes,tasks_created,tasks_done,tasks_open,emergencies,gate_services,visitors,contractor_workers,event_guests,move_trucks,material_entries,material_exits,patrols_scheduled,patrols_done,patrols_late,patrols_missed,patrols_incomplete',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith(`${today},gate,`)).toBe(true);
  });

  it('a bad day is refused; only guard_reports.read reads it', async () => {
    const bad = await x.http(
      'get',
      '/staff/security/reports/daily?date=2026-02-30',
      supervisor.token,
    );
    expect((bad.body as { fields: unknown[] }).fields).toEqual([
      { field: 'date', code: 'INVALID_VALUE' },
    ]);
    const guard = await x.guard(s.c);
    expect(
      (await x.http('get', '/staff/security/reports/daily', guard.token))
        .status,
    ).toBe(403);
  });
});
