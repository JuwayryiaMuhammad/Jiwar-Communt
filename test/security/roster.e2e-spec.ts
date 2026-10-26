import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { addDays } from '../../src/core/common/slots/day-slots';
import { newId } from '../../src/core/common/uuid';
import { TenantSettingsService } from '../../src/core/tenant-settings/tenant-settings.service';
import {
  ROSTER_ATTENDANCE_SWEEP,
  ROSTER_MATERIALIZE_SWEEP,
} from '../../src/gate/roster/roster-attendance';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  securityHelpers,
  type SlotBody,
  type TemplateBody,
  type Who,
} from '../setup/security';
import {
  at,
  clock,
  day,
  dbDate,
  middayZone,
  today,
  ZONE,
} from '../setup/compound-clock';
import { required } from '../setup/test-env';

const HOUR = 3_600_000;
const WALL_CLOCK_MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20261114090000_guard_roster_slot_wall_clock_ends/migration.sql',
);

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const fields = (res: { body: unknown }) =>
  (res.body as { fields?: unknown[] }).fields;

/**
 * ADR 0050: the management schedules guards at a post — weekly templates
 * made into slots 28 days ahead, and single slots — and a guard's slots
 * never overlap. Ending a template cancels its slots to come. Each guard
 * reads their own schedule.
 */
describe('The roster', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Roster Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
  }, 120_000);

  afterAll(() => h.close());

  const everyDay = (from: string, to: string) => ({
    days: [0, 1, 2, 3, 4, 5, 6],
    windows: [{ from, to }],
  });

  async function template(
    as: Who,
    guardId: string,
    schedule = everyDay('06:00', '14:00'),
    extra: Record<string, unknown> = {},
  ): Promise<TemplateBody> {
    const res = await x.templateRaw(as, {
      guardId,
      gateId,
      schedule,
      effectiveFrom: addDays(today(), 1),
      ...extra,
    });
    if (res.status !== 201)
      throw new Error(`template: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as TemplateBody;
  }

  const slotsOf = async (as: Who, query: Record<string, string>) =>
    (
      (
        await x
          .http(
            'get',
            `/staff/security/roster/slots?${new URLSearchParams(query)}`,
            as.token,
          )
          .expect(200)
      ).body as { data: SlotBody[] }
    ).data;

  it('a template makes its slots 28 days ahead at once, each once; the sweep keeps them', async () => {
    const guard = await x.guard(s.c);
    const t = await template(supervisor, guard.id);
    expect(t).toMatchObject({
      guard: { id: guard.id },
      post: { gateId, zone: null },
      schedule: everyDay('06:00', '14:00'),
      effectiveFrom: addDays(today(), 1),
      effectiveUntil: null,
      endedAt: null,
    });
    const slots = await slotsOf(supervisor, {
      guardId: guard.id,
      from: today(),
      to: addDays(today(), 30),
    });
    // Tomorrow … today + 28.
    expect(slots).toHaveLength(28);
    expect(slots.every((sl) => sl.templateId === t.id)).toBe(true);
    expect(
      new Date(slots[0].endsAt).getTime() -
        new Date(slots[0].startsAt).getTime(),
    ).toBe(8 * 3_600_000);

    // The sweep a week later adds the next seven, and nothing twice: seven
    // of the compound's days, never 7 × 24 h (on 2026-10-22 21:xx UTC, that
    // was 6 days and 23 hours across the end of daylight saving).
    const later = at(addDays(today(), 7), 12);
    expect(
      await x.sweep(ROSTER_MATERIALIZE_SWEEP, later),
    ).toBeGreaterThanOrEqual(7);
    await x.sweep(ROSTER_MATERIALIZE_SWEEP, later);
    const made = await x.inTx(s.c, (tx) =>
      tx.guardRosterSlot.count({ where: { templateId: t.id } }),
    );
    expect(made).toBe(35);

    const [entry] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'guard_roster.template_created',
      targetId: t.id,
    });
    expect(entry.metadata).toEqual({
      guardId: guard.id,
      gateId,
      effectiveFrom: addDays(today(), 1),
      effectiveUntil: null,
      slots: 28,
    });
  });

  it('a guard’s templates and slots never overlap', async () => {
    const guard = await x.guard(s.c);
    await template(supervisor, guard.id, everyDay('06:00', '14:00'));
    // Overlapping hours, another template: refused.
    const clash = await x.templateRaw(supervisor, {
      guardId: guard.id,
      gateId,
      schedule: everyDay('13:00', '20:00'),
      effectiveFrom: addDays(today(), 1),
    });
    expect(code(clash)).toEqual({ status: 409, code: 'ROSTER_OVERLAP' });
    // Touching hours are fine.
    await template(supervisor, guard.id, everyDay('14:00', '22:00'));
    // A single slot on a template's day to come, beyond the 28 made: refused.
    const far = at(addDays(today(), 40), 10);
    const late = await x.slotRaw(supervisor, {
      guardId: guard.id,
      gateId,
      startsAt: far.toISOString(),
      endsAt: new Date(far.getTime() + 3_600_000).toISOString(),
    });
    expect(code(late)).toEqual({ status: 409, code: 'ROSTER_OVERLAP' });
    // A night slot between the two templates' days is free.
    const night = at(addDays(today(), 3), 23);
    await x
      .slotRaw(supervisor, {
        guardId: guard.id,
        gateId,
        startsAt: night.toISOString(),
        endsAt: new Date(night.getTime() + 6 * 3_600_000).toISOString(),
      })
      .expect(201);

    // A template over an existing single slot: refused.
    const other = await x.guard(s.c);
    const single = await x.slot(supervisor, other.id, { gateId }, 2 * 24 * 60);
    const over = await x.templateRaw(supervisor, {
      guardId: other.id,
      gateId,
      schedule: everyDay('00:00', '23:59'),
      effectiveFrom: today(),
    });
    expect(code(over)).toEqual({ status: 409, code: 'ROSTER_OVERLAP' });
    expect((over.body as { params: unknown }).params).toEqual({
      startsAt: single.startsAt,
      endsAt: single.endsAt,
    });
  });

  it('only an active gate.operate holder at a post in service, from today on', async () => {
    const technician = await x.staff(s.c, ['tickets.work']);
    const r1 = await x.templateRaw(supervisor, {
      guardId: technician.id,
      gateId,
      schedule: everyDay('06:00', '14:00'),
      effectiveFrom: today(),
    });
    expect(fields(r1)).toEqual([
      { field: 'guardId', code: 'GUARD_NOT_ELIGIBLE' },
    ]);
    const guard = await x.guard(s.c);
    const closed = await x.g.gate(s.c);
    await x
      .http('patch', `/gates/${closed.id}`, s.manager.token, {
        status: 'inactive',
      })
      .expect(200);
    const r2 = await x.slotRaw(supervisor, {
      guardId: guard.id,
      gateId: closed.id,
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7_200_000).toISOString(),
    });
    expect(fields(r2)).toEqual([
      { field: 'gateId', code: 'POST_NOT_AVAILABLE' },
    ]);
    const r3 = await x.templateRaw(supervisor, {
      guardId: guard.id,
      gateId,
      schedule: everyDay('06:00', '14:00'),
      effectiveFrom: addDays(today(), -1),
    });
    expect(fields(r3)).toEqual([
      {
        field: 'effectiveFrom',
        code: 'DAY_OUT_OF_RANGE',
        params: { min: today() },
      },
    ]);
    const r4 = await x.slotRaw(supervisor, {
      guardId: guard.id,
      gateId,
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 26 * 3_600_000).toISOString(),
    });
    expect(fields(r4)).toEqual([
      { field: 'endsAt', code: 'INVALID_VALUE', params: { maxMinutes: 1440 } },
    ]);
    const r5 = await x.slotRaw(supervisor, {
      guardId: guard.id,
      gateId,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(fields(r5)).toEqual([
      { field: 'startsAt', code: 'INVALID_VALUE', params: { maxDays: 366 } },
    ]);
  });

  it('ending a template cancels its slots to come; ending again is refused', async () => {
    const guard = await x.guard(s.c);
    const t = await template(supervisor, guard.id);
    const ended = await x
      .http(
        'post',
        `/staff/security/roster/templates/${t.id}/end`,
        supervisor.token,
      )
      .expect(200);
    expect(ended.body).toMatchObject({ endReason: 'manager' });
    const slots = await slotsOf(supervisor, {
      guardId: guard.id,
      from: today(),
      to: addDays(today(), 30),
    });
    expect(slots.length).toBe(28);
    expect(
      new Set(slots.map((sl) => [sl.status, sl.cancelReason].join())),
    ).toEqual(new Set(['cancelled,template_ended']));
    expect(
      code(
        await x.http(
          'post',
          `/staff/security/roster/templates/${t.id}/end`,
          supervisor.token,
        ),
      ),
    ).toEqual({ status: 409, code: 'ROSTER_TEMPLATE_ENDED' });
    // An ended template makes nothing more.
    await x.sweep(ROSTER_MATERIALIZE_SWEEP, at(addDays(today(), 7), 12));
    expect(
      await x.inTx(s.c, (tx) =>
        tx.guardRosterSlot.count({ where: { templateId: t.id } }),
      ),
    ).toBe(28);
  });

  it('a single slot: made, read by its guard alone, cancelled with a reason; a filled one stays', async () => {
    const guard = await x.guard(s.c);
    const other = await x.guard(s.c);
    const slot = await x.slot(supervisor, guard.id, { gateId }, 5, 60);
    expect(slot).toMatchObject({
      guard: { id: guard.id },
      status: 'scheduled',
      templateId: null,
      shift: null,
      late: false,
    });
    const mine = (await x.http('get', '/gate/roster', guard.token).expect(200))
      .body as { data: SlotBody[] };
    expect(mine.data.map((sl) => sl.id)).toEqual([slot.id]);
    expect(Object.keys(mine.data[0])).not.toContain('guard');
    const theirs = (
      await x.http('get', '/gate/roster', other.token).expect(200)
    ).body as { data: SlotBody[] };
    expect(theirs.data).toEqual([]);

    const bad = await x.http(
      'post',
      `/staff/security/roster/slots/${slot.id}/cancel`,
      supervisor.token,
      { reasonCode: 'template_ended' },
    );
    expect(fields(bad)).toEqual([
      expect.objectContaining({
        field: 'reasonCode',
        code: 'INVALID_REASON_CODE',
      }),
    ]);
    const cancelled = await x
      .http(
        'post',
        `/staff/security/roster/slots/${slot.id}/cancel`,
        supervisor.token,
        {
          reasonCode: 'guard_unavailable',
        },
      )
      .expect(200);
    expect(cancelled.body).toMatchObject({
      status: 'cancelled',
      cancelReason: 'guard_unavailable',
    });

    const filled = await x.slot(supervisor, guard.id, { gateId }, 5, 60);
    await x.start(guard, { gateId });
    expect(
      code(
        await x.http(
          'post',
          `/staff/security/roster/slots/${filled.id}/cancel`,
          supervisor.token,
          { reasonCode: 'other' },
        ),
      ),
    ).toEqual({ status: 409, code: 'ROSTER_SLOT_CLOSED' });
    await x.endRaw(guard).expect(200);
  });

  it('a period is 31 days at most, and ends after it starts', async () => {
    const r = await x.http(
      'get',
      `/staff/security/roster/slots?from=${today()}&to=${addDays(today(), 31)}`,
      supervisor.token,
    );
    expect(fields(r)).toEqual([
      { field: 'to', code: 'PERIOD_TOO_LONG', params: { maxDays: 31 } },
    ]);
    const r2 = await x.http(
      'get',
      `/gate/roster?from=${today()}&to=${addDays(today(), -1)}`,
      (await x.guard(s.c)).token,
    );
    expect(fields(r2)).toEqual([{ field: 'to', code: 'ENDS_BEFORE_START' }]);
  });

  it('the forms offer the posts in service and the guards', async () => {
    const posts = (
      await x.http('get', '/staff/security/posts', supervisor.token).expect(200)
    ).body as { gates: { id: string }[]; zones: { key: string | null }[] };
    expect(posts.gates.map((g) => g.id)).toContain(gateId);
    expect(posts.zones.map((z) => z.key)).toContain('clubhouse');
    const guard = await x.guard(s.c);
    const guards = (
      await x
        .http('get', '/staff/security/guards', supervisor.token)
        .expect(200)
    ).body as { data: { id: string; fullName: string }[] };
    expect(guards.data.find((g) => g.id === guard.id)).toEqual({
      id: guard.id,
      fullName: expect.any(String) as string,
    });
    expect(guards.data.map((g) => g.id)).not.toContain(supervisor.id);
  });

  it('a template made during its window makes that window’s slot, due from then; a shift open there fills it', async () => {
    // A compound where it is midday: its 08:00–16:00 window is under way.
    const zone = middayZone();
    const m = await x.setUp('Roster Midday Court');
    await x.v.x.asManager(m.c, () =>
      h.moduleRef.get(TenantSettingsService).update({ timezone: zone }),
    );
    const boss = await x.supervisor(m.c);
    const post = (await x.g.gate(m.c)).id;
    const day0 = clock(zone).today;
    const make = (guardId: string) =>
      x
        .templateRaw(boss, {
          guardId,
          gateId: post,
          schedule: everyDay('08:00', '16:00'),
          effectiveFrom: day0,
        })
        .expect(201);
    const todays = (guardId: string) =>
      slotsOf(boss, { guardId, from: day0, to: day0 });

    // Off duty: today's slot is made, and is not yet late nor absent.
    const away = await x.guard(m.c);
    await make(away.id);
    expect(await todays(away.id)).toEqual([
      expect.objectContaining({ shift: null, absentAt: null }),
    ]);
    expect(
      await slotsOf(boss, {
        guardId: away.id,
        from: day0,
        to: addDays(day0, 28),
      }),
    ).toHaveLength(29);
    await x.sweep(ROSTER_ATTENDANCE_SWEEP, new Date());
    expect((await todays(away.id))[0].absentAt).toBeNull();

    // On shift there already: that shift fills it, on time.
    const there = await x.guard(m.c);
    const shift = await x.start(there, { gateId: post });
    await make(there.id);
    expect(await todays(there.id)).toEqual([
      expect.objectContaining({
        shift: expect.objectContaining({ id: shift.id }) as unknown,
        lateMinutes: 0,
        late: false,
      }),
    ]);
    await x.endRaw(there).expect(200);
    const row = await x.shiftRow(m.c, shift.id);
    expect(row).toMatchObject({ overtimeMinutes: 0, unscheduledMinutes: null });
  });

  it('a template ended and made again mid-shift: accepted, today keeps the old slot, the new one makes the next days', async () => {
    // A compound where it is midday: its 08:00–16:00 window is under way.
    const zone = middayZone();
    const m = await x.setUp('Roster Remade Court');
    await x.v.x.asManager(m.c, () =>
      h.moduleRef.get(TenantSettingsService).update({ timezone: zone }),
    );
    const boss = await x.supervisor(m.c);
    const post = (await x.g.gate(m.c)).id;
    const day0 = clock(zone).today;
    const make = (guardId: string) =>
      x.templateRaw(boss, {
        guardId,
        gateId: post,
        schedule: everyDay('08:00', '16:00'),
        effectiveFrom: day0,
      });
    const guard = await x.guard(m.c);
    const shift = await x.start(guard, { gateId: post });
    const old = (await make(guard.id).expect(201)).body as TemplateBody;
    const [today0] = await slotsOf(boss, {
      guardId: guard.id,
      from: day0,
      to: day0,
    });
    expect(today0).toMatchObject({ shift: { id: shift.id } });

    await x
      .http(
        'post',
        `/staff/security/roster/templates/${old.id}/end`,
        boss.token,
      )
      .expect(200);
    // The dashboard's edit: the same window again, from today.
    const remade = (await make(guard.id).expect(201)).body as TemplateBody;
    const live = (
      await slotsOf(boss, {
        guardId: guard.id,
        from: day0,
        to: addDays(day0, 2),
      })
    ).filter((sl) => sl.status === 'scheduled');
    expect(live.map((sl) => [sl.id === today0.id, sl.templateId])).toEqual([
      [true, old.id],
      [false, remade.id],
      [false, remade.id],
    ]);
    expect(live[0]).toMatchObject({ shift: { id: shift.id } });
    await x.endRaw(guard).expect(200);
  });

  it('a single slot made while its guard is on shift there fills from that shift; elsewhere it does not', async () => {
    const guard = await x.guard(s.c);
    const shift = await x.start(guard, { gateId });
    const soon = await x.slot(supervisor, guard.id, { gateId }, 10, 60);
    expect(soon).toMatchObject({
      shift: { id: shift.id },
      lateMinutes: 0,
    });
    await x.endRaw(guard).expect(200);

    const other = await x.guard(s.c);
    const elsewhere = (await x.g.gate(s.c)).id;
    await x.start(other, { gateId: elsewhere });
    expect(
      await x.slot(supervisor, other.id, { gateId }, 10, 60),
    ).toMatchObject({ shift: null });
    // Starting later than the half hour: left for the next opening.
    expect(
      await x.slot(supervisor, other.id, { gateId: elsewhere }, 120, 60),
    ).toMatchObject({ shift: null });
    await x.endRaw(other).expect(200);
  });

  it('a time without an offset names no instant: INVALID_FORMAT, nothing made', async () => {
    const guard = await x.guard(s.c);
    const res = await x.slotRaw(supervisor, {
      guardId: guard.id,
      gateId,
      startsAt: '2031-01-13T22:00:00',
      endsAt: '2031-01-13T23:00:00Z',
    });
    expect(code(res)).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    expect(fields(res)).toEqual([
      { field: 'startsAt', code: 'INVALID_FORMAT' },
    ]);
    expect(await slotsOf(supervisor, { guardId: guard.id })).toEqual([]);
  });

  it('the wall-clock migration: a slot to come gets its template’s end; a past, single or overlapping one keeps its own', async () => {
    // A compound on Cairo's clock, and its next and last nights the clock
    // goes back (24:00 → 23:00): the day whose noon is 25 hours before the
    // next one's.
    const m = await x.setUp('Roster Clock Court');
    await x.v.x.asManager(m.c, () =>
      h.moduleRef.get(TenantSettingsService).update({ timezone: ZONE }),
    );
    const post = (await x.g.gate(m.c)).id;
    const goesBack = (step: 1 | -1) => {
      for (let n = step; Math.abs(n) <= 400; n += step) {
        const d = day(n);
        if (at(addDays(d, 1), 12).getTime() - at(d, 12).getTime() === 25 * HOUR)
          return d;
      }
      throw new Error('no clock change within 400 days');
    };
    const next = goesBack(1);
    const last = goesBack(-1);
    const night = (d: string) => at(d, 22);
    // The old rule: a 22:00–06:00 window lasted eight hours, whatever the clock.
    const eight = (start: Date) => new Date(start.getTime() + 8 * HOUR);
    const template = (guardId: string) =>
      x.inTx(m.c, (tx) =>
        tx.guardRosterTemplate.create({
          data: {
            id: newId(),
            tenantId: m.c.tenantId,
            guardAccountId: guardId,
            gateId: post,
            schedule: everyDay('22:00', '06:00'),
            effectiveFrom: dbDate(last),
            createdById: m.c.managerId,
          },
        }),
      );
    const slot = (
      guardId: string,
      startsAt: Date,
      endsAt: Date,
      templateId: string | null,
    ) =>
      x.inTx(m.c, (tx) =>
        tx.guardRosterSlot.create({
          data: {
            id: newId(),
            tenantId: m.c.tenantId,
            guardAccountId: guardId,
            gateId: post,
            startsAt,
            endsAt,
            templateId,
            createdById: templateId ? null : m.c.managerId,
          },
        }),
      );

    const a = await x.guard(m.c);
    const ta = await template(a.id);
    const tonight = await slot(a.id, night(next), eight(night(next)), ta.id);
    const weekAfter = await slot(
      a.id,
      night(addDays(next, 7)),
      at(addDays(next, 8), 6),
      ta.id,
    );
    const lastYear = await slot(a.id, night(last), eight(night(last)), ta.id);
    // B's missing hour is covered by a single slot: their night keeps 05:00.
    const b = await x.guard(m.c);
    const tb = await template(b.id);
    const covered = await slot(b.id, night(next), eight(night(next)), tb.id);
    const cover = await slot(
      b.id,
      at(addDays(next, 1), 5),
      at(addDays(next, 1), 7),
      null,
    );
    const c = await x.guard(m.c);
    const single = await slot(c.id, night(next), eight(night(next)), null);

    const migrator = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await migrator.connect();
    try {
      await migrator.query(readFileSync(WALL_CLOCK_MIGRATION, 'utf8'));
      const left = await migrator.query<{ enabled: string; helpers: number }>(
        `SELECT (SELECT tgenabled FROM pg_trigger
                  WHERE tgname = 'guard_roster_slots_move_forward') AS enabled,
                (SELECT count(*)::int FROM pg_proc
                  WHERE proname LIKE 'roster_repair_%') AS helpers`,
      );
      // The trigger is back on, and the helpers are gone.
      expect(left.rows).toEqual([{ enabled: 'O', helpers: 0 }]);
    } finally {
      await migrator.end();
    }

    const ends = new Map(
      (
        await x.inTx(m.c, (tx) =>
          tx.guardRosterSlot.findMany({
            where: {
              id: {
                in: [tonight, weekAfter, lastYear, covered, cover, single].map(
                  (r) => r.id,
                ),
              },
            },
          }),
        )
      ).map((r) => [r.id, r.endsAt.getTime()]),
    );
    // Tonight ends at 06:00 on the compound's clock: nine hours.
    expect(ends.get(tonight.id)).toBe(at(addDays(next, 1), 6).getTime());
    expect(ends.get(tonight.id)! - tonight.startsAt.getTime()).toBe(9 * HOUR);
    for (const kept of [weekAfter, lastYear, covered, cover, single])
      expect(ends.get(kept.id)).toBe(kept.endsAt.getTime());
    // And the trigger holds again: a slot keeps its times.
    await expect(
      x.inTx(m.c, (tx) =>
        tx.guardRosterSlot.update({
          where: { id: tonight.id },
          data: { endsAt: eight(night(next)) },
        }),
      ),
    ).rejects.toThrow(/keeps its post and times/);
  });

  it('a create replays under its Idempotency-Key', async () => {
    const guard = await x.guard(s.c);
    const body = {
      guardId: guard.id,
      gateId,
      startsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    };
    const first = await x
      .slotRaw(supervisor, body, { 'Idempotency-Key': 'roster-slot-0001' })
      .expect(201);
    const again = await x
      .slotRaw(supervisor, body, { 'Idempotency-Key': 'roster-slot-0001' })
      .expect(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
  });
});
