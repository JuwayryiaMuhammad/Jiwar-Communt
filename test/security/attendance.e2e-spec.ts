import { newId } from '../../src/core/common/uuid';
import { ROSTER_ATTENDANCE_SWEEP } from '../../src/gate/roster/roster-attendance';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type ShiftBody, type Who } from '../setup/security';
import { day } from '../setup/compound-clock';

const MINUTE = 60_000;

/**
 * ADR 0050: opening a shift fills the guard's slot at that post (from 30
 * minutes before its start until its end), with how late it opened; more
 * than ten minutes is late. A slot not opened an hour after its start is
 * marked absent by a sweep, and the roster's keepers are told — critically
 * when nobody else is on shift there. A shift's end records overtime for a
 * filled slot, and unscheduled minutes (never overtime) without one.
 */
describe('Attendance', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let supervisor: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Attendance Court');
    supervisor = await x.supervisor(s.c);
  }, 120_000);

  afterAll(() => h.close());

  // From yesterday: a slot that started minutes ago may have started then.
  const yesterday = () => day(-1);

  const told = async (accountId: string, slotId: string) =>
    (await x.notifications(s.c, accountId))
      .filter((n) => n.targetId === slotId)
      .map((n) => n.kind);

  it('a shift opened on time fills the slot; its end records overtime only', async () => {
    const guard = await x.guard(s.c);
    const gateId = (await x.g.gate(s.c)).id;
    const slot = await x.slot(supervisor, guard.id, { gateId }, 20, 60);
    const shift = await x.start(guard, { gateId });
    expect(shift).toMatchObject({
      scheduledStart: slot.startsAt,
      scheduledEnd: slot.endsAt,
      lateMinutes: 0,
    });
    await x.endRaw(guard).expect(200);
    const row = await x.shiftRow(s.c, shift.id);
    expect(row).toMatchObject({ overtimeMinutes: 0, unscheduledMinutes: null });
  });

  it('opened more than ten minutes late: recorded and audited', async () => {
    const guard = await x.guard(s.c);
    const gateId = (await x.g.gate(s.c)).id;
    const slot = await x.pastSlot(s.c, guard.id, { gateId }, 15);
    const shift = await x.start(guard, { gateId });
    expect(shift.lateMinutes).toBe(15);
    expect(await x.slotRow(s.c, slot.id)).toMatchObject({
      shiftId: shift.id,
      lateMinutes: 15,
    });
    const [entry] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'guard_shift.late',
      targetId: shift.id,
    });
    expect(entry.metadata).toEqual({ slotId: slot.id, minutes: 15 });
    await x.endRaw(guard).expect(200);
  });

  it('a slot elsewhere, or one ended, is not filled: the shift is unscheduled, never overtime', async () => {
    const guard = await x.guard(s.c);
    const gateId = (await x.g.gate(s.c)).id;
    const other = (await x.g.gate(s.c)).id;
    await x.pastSlot(s.c, guard.id, { gateId: other }, 5);
    await x.pastSlot(s.c, guard.id, { gateId }, 120, 60);
    const shift = await x.start(guard, { gateId });
    expect(shift).toMatchObject({ scheduledStart: null, lateMinutes: null });
    await x.endRaw(guard).expect(200);
    expect(await x.shiftRow(s.c, shift.id)).toMatchObject({
      overtimeMinutes: null,
      unscheduledMinutes: 0,
    });
  });

  it('worked beyond the slot: overtime is the minutes past its length', async () => {
    const guard = await x.guard(s.c);
    const gateId = (await x.g.gate(s.c)).id;
    // A shift opened three hours ago on a slot of one hour.
    const shiftId = newId();
    const startedAt = new Date(Date.now() - 180 * MINUTE);
    await x.inTx(s.c, (tx) =>
      tx.guardShift.create({
        data: {
          id: shiftId,
          tenantId: s.c.tenantId,
          guardAccountId: guard.id,
          gateId,
          startedAt,
        },
      }),
    );
    await x.pastSlot(s.c, guard.id, { gateId }, 180, 60, {
      shiftId,
      lateMinutes: 0,
    });
    await x.endRaw(guard).expect(200);
    const row = await x.shiftRow(s.c, shiftId);
    expect(row.overtimeMinutes).toBeGreaterThanOrEqual(119);
    expect(row.overtimeMinutes).toBeLessThanOrEqual(121);
    expect(row.unscheduledMinutes).toBeNull();
  });

  it('not opened an hour after its start: absent once; the keepers are told, critically when nobody is on shift there', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const absent = await x.guard(s.c);
    const slot = await x.pastSlot(s.c, absent.id, { gateId }, 61);
    const now = new Date();
    expect(await x.sweep(ROSTER_ATTENDANCE_SWEEP, now)).toBeGreaterThanOrEqual(
      1,
    );
    expect((await x.slotRow(s.c, slot.id)).absentAt).not.toBeNull();
    expect(await told(supervisor.id, slot.id)).toEqual([
      'guard_shift.absent_unmanned',
    ]);
    expect(await told(s.manager.id, slot.id)).toEqual([
      'guard_shift.absent_unmanned',
    ]);
    // Once.
    await x.sweep(ROSTER_ATTENDANCE_SWEEP, now);
    expect(await told(supervisor.id, slot.id)).toHaveLength(1);
    const [entry] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'guard_shift.absent',
      targetId: slot.id,
    });
    expect(entry.metadata).toEqual({ unmanned: true, recipients: 2 });

    // A later opening still fills it: both are recorded.
    const shift = await x.start(absent, { gateId });
    expect(shift.lateMinutes).toBe(61);
    const row = await x.slotRow(s.c, slot.id);
    expect(row.shiftId).toBe(shift.id);
    expect(row.absentAt).not.toBeNull();
    await x.endRaw(absent).expect(200);

    // Another guard on shift there: told, not critically.
    const present = await x.guard(s.c);
    await x.start(present, { gateId });
    const second = await x.pastSlot(
      s.c,
      (await x.guard(s.c)).id,
      { gateId },
      70,
    );
    await x.sweep(ROSTER_ATTENDANCE_SWEEP, new Date());
    expect(await told(supervisor.id, second.id)).toEqual([
      'guard_shift.absent',
    ]);
    await x.endRaw(present).expect(200);
  });

  it('a post out of service is nobody’s absence; less than an hour is not one yet', async () => {
    const gate = await x.g.gate(s.c);
    const guard = await x.guard(s.c);
    const slot = await x.pastSlot(s.c, guard.id, { gateId: gate.id }, 90);
    const early = await x.pastSlot(
      s.c,
      (await x.guard(s.c)).id,
      { gateId: gate.id },
      30,
    );
    await x
      .http('patch', `/gates/${gate.id}`, s.manager.token, {
        status: 'inactive',
      })
      .expect(200);
    await x.sweep(ROSTER_ATTENDANCE_SWEEP, new Date());
    expect((await x.slotRow(s.c, slot.id)).absentAt).toBeNull();
    expect((await x.slotRow(s.c, early.id)).absentAt).toBeNull();
  });

  it('attendance adds it up per guard; each guard reads their own', async () => {
    const guard = await x.guard(s.c);
    const gateId = (await x.g.gate(s.c)).id;
    await x.pastSlot(s.c, guard.id, { gateId }, 20, 60);
    const shift = await x.start(guard, { gateId });
    expect(shift.lateMinutes).toBe(20);
    await x.endRaw(guard).expect(200);
    const unscheduled: ShiftBody = await x.start(guard, { gateId });
    await x.endRaw(guard).expect(200);
    const all = (
      await x
        .http(
          'get',
          `/staff/security/attendance?guardId=${guard.id}&from=${yesterday()}`,
          supervisor.token,
        )
        .expect(200)
    ).body as { data: Record<string, unknown>[] };
    expect(all.data).toEqual([
      {
        guard: { id: guard.id, fullName: expect.any(String) as string },
        slots: 1,
        filled: 1,
        late: 1,
        absent: 0,
        scheduledMinutes: 60,
        workedMinutes: expect.any(Number) as number,
        overtimeMinutes: 0,
        unscheduledShifts: 1,
        unscheduledMinutes: expect.any(Number) as number,
      },
    ]);
    const mine = (
      await x
        .http('get', `/gate/roster/attendance?from=${yesterday()}`, guard.token)
        .expect(200)
    ).body as Record<string, unknown>;
    expect(mine).toEqual(all.data[0]);
    expect(unscheduled.scheduledStart).toBeNull();
  });
});
