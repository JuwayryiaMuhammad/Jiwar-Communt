import { addDays } from '../../src/core/common/slots/day-slots';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import {
  ROSTER_ATTENDANCE_SWEEP,
  TECHNICIAN_DUTY_SWEEP,
} from '../../src/gate/roster/roster-attendance';
import { auditReaders } from '../setup/audit';
import { at, today } from '../setup/compound-clock';
import { fieldTeamHelpers } from '../setup/field-team';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import type { Who } from '../setup/safety';

const MINUTE = 60_000;

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const fields = (res: { body: unknown }) =>
  (res.body as { fields?: unknown[] }).fields;

interface DutySlot {
  id: string;
  zone: { id: string } | null;
  startsAt: string;
  endsAt: string;
  status: string;
  dutyStartedAt: string | null;
  dutyEndedAt: string | null;
  lateMinutes: number | null;
  late: boolean;
  overtimeMinutes: number | null;
  absentAt: string | null;
}

/**
 * ADR 0078: the technicians' roster is the guards' (ADR 0050) for the
 * maintenance crew. A technician's post is a zone or none, never a gate;
 * their slot is filled by going on duty (being available) and closed by
 * going off it, with lateness, overtime and absence recorded as a
 * guard's. The two crews never see each other's rows.
 */
describe('The technicians’ roster', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof fieldTeamHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof fieldTeamHelpers>['setUp']>>;
  let audit: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = fieldTeamHelpers(h);
    s = await x.setUp('Duty Roster Court');
    audit = auditReaders(h);
  }, 120_000);

  afterAll(() => h.close());

  const slotRow = (id: string) => x.slotRow(s.c, id);

  async function slotsOf(as: Who, q: Record<string, string> = {}) {
    const res = await x
      .http(
        'get',
        `/staff/field-team/roster/slots?${new URLSearchParams(q)}`,
        as.token,
      )
      .expect(200);
    return (res.body as { data: DutySlot[] }).data;
  }

  it('a technician’s template: a zone or none, never a gate; only a technician', async () => {
    const tech = await x.technician(s.c);
    const guard = await x.guard(s.c);
    const gate = (await x.g.gate(s.c)).id;
    const body = {
      technicianId: tech.id,
      schedule: {
        days: [0, 1, 2, 3, 4, 5, 6],
        windows: [{ from: '04:00', to: '05:00' }],
      },
      effectiveFrom: addDays(today(), 1),
    };
    const atGate = await x.templateRaw(s.boss, { ...body, gateId: gate });
    expect(code(atGate)).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    expect(fields(atGate)).toEqual([
      { field: 'gateId', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const notATech = await x.templateRaw(s.boss, {
      ...body,
      technicianId: guard.id,
    });
    expect(fields(notATech)).toEqual([
      { field: 'technicianId', code: 'GUARD_NOT_ELIGIBLE' },
    ]);
    // Nor on the guards' roster: a technician is no guard.
    const onGuards = await x.http(
      'post',
      '/staff/security/roster/templates',
      s.manager.token,
      { ...body, guardId: tech.id, technicianId: undefined, gateId: gate },
    );
    expect(fields(onGuards)).toEqual([
      { field: 'guardId', code: 'GUARD_NOT_ELIGIBLE' },
    ]);

    const made = await x.templateRaw(s.boss, body).expect(201);
    expect(made.body).toMatchObject({
      technician: { id: tech.id },
      zone: null,
      endedAt: null,
    });
    const slots = await slotsOf(s.boss, {
      technicianId: tech.id,
      from: addDays(today(), 1),
      to: addDays(today(), 28),
    });
    expect(slots.length).toBe(28);
    expect(slots.every((sl) => sl.zone === null && !sl.dutyStartedAt)).toBe(
      true,
    );
  });

  it('the two crews never see each other’s rows', async () => {
    const tech = await x.technician(s.c);
    const slot = await x.dutySlot(s.c, tech.id, -120, 60);
    const guards = await x.http(
      'get',
      `/staff/security/roster/slots?${new URLSearchParams({ guardId: tech.id })}`,
      s.manager.token,
    );
    expect((guards.body as { data: unknown[] }).data).toEqual([]);
    expect(
      code(
        await x.http(
          'post',
          `/staff/security/roster/slots/${slot.id}/cancel`,
          s.manager.token,
          { reasonCode: 'other' },
        ),
      ),
    ).toEqual({ status: 404, code: 'ROSTER_SLOT_NOT_FOUND' });
    // A guard's slot is not the field team's.
    const guard = await x.guard(s.c);
    const gate = (await x.g.gate(s.c)).id;
    const guardSlot = await x.pastSlot(s.c, guard.id, { gateId: gate }, -300);
    expect(
      code(
        await x.http(
          'post',
          `/staff/field-team/roster/slots/${guardSlot.id}/cancel`,
          s.boss.token,
          { reasonCode: 'other' },
        ),
      ),
    ).toEqual({ status: 404, code: 'ROSTER_SLOT_NOT_FOUND' });
    expect((await slotsOf(s.boss, { technicianId: guard.id })).length).toBe(0);
  });

  it('going on duty fills the slot, with how late; going off closes it, with the overtime', async () => {
    const tech = await x.technician(s.c);
    // Due 20 minutes ago, for an hour: on duty now is 20 minutes late.
    const slot = await x.dutySlot(s.c, tech.id, 20, 60);
    await x.onDuty(tech);
    let row = await slotRow(slot.id);
    expect(row.dutyStartedAt).not.toBeNull();
    expect(row.lateMinutes).toBeGreaterThanOrEqual(19);
    expect(row.lateMinutes).toBeLessThanOrEqual(21);
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'technician_shift.late',
          targetId: slot.id,
        })
      ).length,
    ).toBe(1);
    await x.offDuty(tech);
    row = await slotRow(slot.id);
    expect(row.dutyEndedAt).not.toBeNull();
    // Off before its end: no overtime.
    expect(row.overtimeMinutes).toBe(0);
    // On again: the slot is closed, nothing more to fill.
    await x.onDuty(tech);
    expect((await slotRow(slot.id)).dutyEndedAt).toEqual(row.dutyEndedAt);
    await x.offDuty(tech);

    // Off after its end: the minutes beyond it are overtime.
    const late = await x.dutySlot(s.c, tech.id, 50, 30);
    // Not on duty when it started: the absence sweep has not reached it yet.
    await x.onDuty(tech);
    // It ended 20 minutes ago: nothing to fill, it is over.
    expect((await slotRow(late.id)).dutyStartedAt).toBeNull();
    await x.offDuty(tech);
  });

  it('overtime counts from the slot’s end to going off duty', async () => {
    const tech = await x.technician(s.c);
    // An hour's slot that ended ten minutes ago, on duty since it started.
    const slot = await x.dutySlot(s.c, tech.id, 70, 60);
    await x.onDuty(tech);
    // It is over: going on duty found nothing to fill.
    expect((await slotRow(slot.id)).dutyStartedAt).toBeNull();
    await x.v.inTx(s.c, (tx) =>
      tx.guardRosterSlot.update({
        where: { id: slot.id },
        data: { dutyStartedAt: slot.startsAt, lateMinutes: 0 },
      }),
    );
    await x.offDuty(tech);
    const closed = await slotRow(slot.id);
    expect(closed.overtimeMinutes).toBeGreaterThanOrEqual(9);
    expect(closed.overtimeMinutes).toBeLessThanOrEqual(11);
    expect(closed.dutyEndedAt!.getTime()).toBeGreaterThan(
      closed.endsAt.getTime(),
    );
  });

  it('a slot made while the technician is on duty is filled at once, on time', async () => {
    const tech = await x.technician(s.c);
    await x.onDuty(tech);
    const startsAt = new Date(Date.now() + 10 * MINUTE);
    const res = await x
      .slotRaw(s.boss, {
        technicianId: tech.id,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 60 * MINUTE).toISOString(),
      })
      .expect(201);
    expect(res.body).toMatchObject({
      technician: { id: tech.id },
      lateMinutes: 0,
      late: false,
    });
    expect((res.body as DutySlot).dutyStartedAt).not.toBeNull();
    await x.offDuty(tech);
  });

  it('a slot whose window opens while the technician is on duty is filled by the duty sweep', async () => {
    const tech = await x.technician(s.c);
    await x.onDuty(tech);
    // Made yesterday, starting now: going on duty came first.
    const slot = await x.dutySlot(s.c, tech.id, 1, 60);
    expect((await slotRow(slot.id)).dutyStartedAt).toBeNull();
    await x.sweep(TECHNICIAN_DUTY_SWEEP, new Date());
    const row = await slotRow(slot.id);
    expect(row.dutyStartedAt).not.toBeNull();
    expect(row.lateMinutes).toBeLessThanOrEqual(2);
    // Off duty, a later slot waits for them.
    await x.offDuty(tech);
    const next = await x.dutySlot(s.c, tech.id, 1, 60);
    await x.sweep(TECHNICIAN_DUTY_SWEEP, new Date());
    expect((await slotRow(next.id)).dutyStartedAt).toBeNull();
  });

  it('absent: not on duty an hour after it was due, the field team told once; on duty is never absent', async () => {
    const away = await x.technician(s.c);
    const slot = await x.dutySlot(s.c, away.id, 61);
    await x.sweep(ROSTER_ATTENDANCE_SWEEP, new Date());
    await x.sweep(ROSTER_ATTENDANCE_SWEEP, new Date());
    expect((await slotRow(slot.id)).absentAt).not.toBeNull();
    expect(await x.told(s.c, s.boss.id, slot.id)).toEqual([
      { kind: 'technician_shift.absent', params: {} },
    ]);
    expect(await x.told(s.c, s.c.managerId, slot.id)).toEqual([
      { kind: 'technician_shift.absent', params: {} },
    ]);
    // A later going on duty still fills it: both facts stay.
    await x.onDuty(away);
    const row = await slotRow(slot.id);
    expect(row.absentAt).not.toBeNull();
    expect(row.dutyStartedAt).not.toBeNull();
    await x.offDuty(away);

    const there = await x.technician(s.c);
    await x.onDuty(there);
    const kept = await x.dutySlot(s.c, there.id, 61);
    await x.sweep(ROSTER_ATTENDANCE_SWEEP, new Date());
    expect((await slotRow(kept.id)).absentAt).toBeNull();
    await x.sweep(TECHNICIAN_DUTY_SWEEP, new Date());
    expect((await slotRow(kept.id)).dutyStartedAt).not.toBeNull();
    await x.offDuty(there);
  });

  it('attendance adds a technician’s slots up; each reads their own schedule', async () => {
    const tech = await x.technician(s.c);
    const done = await x.dutySlot(s.c, tech.id, 30, 60);
    await x.onDuty(tech);
    await x.offDuty(tech);
    await x.dutySlot(s.c, tech.id, 200, 60);
    await x.sweep(ROSTER_ATTENDANCE_SWEEP, new Date());
    const res = await x
      .http(
        'get',
        `/staff/field-team/attendance?${new URLSearchParams({ technicianId: tech.id, from: addDays(today(), -1), to: today() })}`,
        s.boss.token,
      )
      .expect(200);
    expect((res.body as { data: unknown[] }).data).toEqual([
      expect.objectContaining({
        technician: { id: tech.id, fullName: expect.any(String) as string },
        slots: 2,
        filled: 1,
        late: 1,
        absent: 1,
        scheduledMinutes: 120,
        overtimeMinutes: 0,
      }),
    ]);
    const mine = await x
      .http(
        'get',
        `/maintenance/my-roster?${new URLSearchParams({ from: addDays(today(), -1), to: today() })}`,
        tech.token,
      )
      .expect(200);
    expect(
      (mine.body as { data: DutySlot[] }).data.map((sl) => sl.id),
    ).toContain(done.id);
    const own = await x
      .http(
        'get',
        `/maintenance/my-roster/attendance?${new URLSearchParams({ from: addDays(today(), -1), to: today() })}`,
        tech.token,
      )
      .expect(200);
    expect(own.body).toMatchObject({ slots: 2, filled: 1 });
  });

  it('a technician who leaves: their slots to come are cancelled, their template ended, and their duty closed', async () => {
    const tech = await x.technician(s.c);
    const now = await x.dutySlot(s.c, tech.id, 5, 60);
    await x.onDuty(tech);
    const t = await x
      .templateRaw(s.boss, {
        technicianId: tech.id,
        schedule: {
          days: [0, 1, 2, 3, 4, 5, 6],
          windows: [{ from: '04:00', to: '05:00' }],
        },
        effectiveFrom: addDays(today(), 1),
      })
      .expect(201);
    await x.v.x.asManager(s.c, () =>
      h.moduleRef
        .get(AccountsService)
        .updateStatus(tech.id, { status: 'inactive' }),
    );
    const closed = await slotRow(now.id);
    expect(closed.dutyEndedAt).not.toBeNull();
    const template = await x.v.inTx(s.c, (tx) =>
      tx.guardRosterTemplate.findUniqueOrThrow({
        where: { id: (t.body as { id: string }).id },
      }),
    );
    expect(template.endReason).toBe('guard_left');
    const coming = await x.v.inTx(s.c, (tx) =>
      tx.guardRosterSlot.findMany({
        where: {
          guardAccountId: tech.id,
          startsAt: { gt: at(addDays(today(), 1), 0) },
        },
      }),
    );
    expect(coming.every((sl) => sl.status === 'cancelled')).toBe(true);
  });
});
