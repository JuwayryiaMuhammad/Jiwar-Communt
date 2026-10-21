import { addDays } from '../../src/core/common/slots/day-slots';
import { ROSTER_ATTENDANCE_SWEEP } from '../../src/gate/roster/roster-attendance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';
import { today } from '../setup/compound-clock';

const DAY = 24 * 60;
const MINUTE = 60_000;

/**
 * ADR 0050, the roster under concurrency: one writer at a time per guard
 * (the account FOR SHARE, then the guard's lock), so two overlapping
 * writes never both land; an opening and the absence sweep on one slot
 * are each decided under its row; a slot made beside its guard's shift
 * opening or ending is filled by it, or left to the next, never half; a
 * template ended while its slot is asked to be swapped leaves no live swap
 * on a cancelled slot.
 */
describe('The roster under concurrency', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Roster Race Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
  }, 120_000);

  afterAll(() => h.close());

  const slotBody = (
    guardId: string,
    startsInMinutes: number,
    lasts: number,
  ) => {
    const startsAt = new Date(Date.now() + startsInMinutes * MINUTE);
    return {
      guardId,
      gateId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + lasts * MINUTE).toISOString(),
    };
  };

  it('two overlapping slots for one guard at once: one is made', async () => {
    for (let i = 0; i < 5; i++) {
      const guard = await x.guard(s.c);
      const results = await Promise.all([
        x.slotRaw(supervisor, slotBody(guard.id, DAY, 120)),
        x.slotRaw(supervisor, slotBody(guard.id, DAY + 60, 120)),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body).toMatchObject({
        code: 'ROSTER_OVERLAP',
      });
    }
  });

  it('a template and an overlapping slot at once: one is made', async () => {
    const from = addDays(today(), 1);
    for (let i = 0; i < 5; i++) {
      const guard = await x.guard(s.c);
      const [template, slot] = await Promise.all([
        x.templateRaw(supervisor, {
          guardId: guard.id,
          gateId,
          schedule: {
            days: [0, 1, 2, 3, 4, 5, 6],
            windows: [{ from: '00:00', to: '23:59' }],
          },
          effectiveFrom: from,
        }),
        x.slotRaw(supervisor, slotBody(guard.id, 3 * DAY, 60)),
      ]);
      expect([template.status, slot.status].sort()).toEqual([201, 409]);
    }
  });

  it('a slot made while its guard opens a shift there: that shift fills it either way', async () => {
    for (let i = 0; i < 5; i++) {
      const guard = await x.guard(s.c);
      const [made, started] = await Promise.all([
        x.slotRaw(supervisor, slotBody(guard.id, 10, 60)),
        x.startRaw(guard, { gateId }),
      ]);
      expect([made.status, started.status]).toEqual([201, 201]);
      const row = await x.slotRow(s.c, (made.body as { id: string }).id);
      expect(row).toMatchObject({
        shiftId: (started.body as { id: string }).id,
        lateMinutes: 0,
      });
      await x.endRaw(guard).expect(200);
    }
  });

  it('a slot made while its guard’s shift there ends: the end records that slot, or the slot stays open, never half', async () => {
    for (let i = 0; i < 5; i++) {
      const guard = await x.guard(s.c);
      const shift = await x.start(guard, { gateId });
      const [made, ended] = await Promise.all([
        x.slotRaw(supervisor, slotBody(guard.id, 10, 60)),
        x.endRaw(guard),
      ]);
      expect([made.status, ended.status]).toEqual([201, 200]);
      const slot = await x.slotRow(s.c, (made.body as { id: string }).id);
      const row = await x.shiftRow(s.c, shift.id);
      if (slot.shiftId) {
        expect(slot.shiftId).toBe(shift.id);
        expect(row).toMatchObject({
          overtimeMinutes: 0,
          unscheduledMinutes: null,
        });
      } else {
        expect(row.overtimeMinutes).toBeNull();
        expect(row.unscheduledMinutes).not.toBeNull();
      }
    }
  });

  it('an opening racing the absence sweep: the slot is filled either way, marked absent at most once', async () => {
    for (let i = 0; i < 5; i++) {
      const guard = await x.guard(s.c);
      const gate = (await x.g.gate(s.c)).id;
      const slot = await x.pastSlot(s.c, guard.id, { gateId: gate }, 61);
      const [started] = await Promise.all([
        x.startRaw(guard, { gateId: gate }),
        x.sweep(ROSTER_ATTENDANCE_SWEEP, new Date()),
      ]);
      expect(started.status).toBe(201);
      const row = await x.slotRow(s.c, slot.id);
      expect(row.shiftId).toBe((started.body as { id: string }).id);
      const told = (await x.notifications(s.c, supervisor.id)).filter(
        (n) => n.targetId === slot.id,
      );
      expect(told.length).toBe(row.absentAt ? 1 : 0);
      await x.endRaw(guard).expect(200);
    }
  });

  it('a template ended while its slot is asked to be swapped: no live swap is left on a cancelled slot', async () => {
    const from = addDays(today(), 2);
    for (let i = 0; i < 5; i++) {
      const guard = await x.guard(s.c);
      const colleague = await x.guard(s.c);
      const template = (
        await x
          .templateRaw(supervisor, {
            guardId: guard.id,
            gateId,
            schedule: {
              days: [0, 1, 2, 3, 4, 5, 6],
              windows: [{ from: '10:00', to: '11:00' }],
            },
            effectiveFrom: from,
          })
          .expect(201)
      ).body as { id: string };
      const slot = await x.inTx(s.c, (tx) =>
        tx.guardRosterSlot.findFirstOrThrow({
          where: { templateId: template.id },
          orderBy: { startsAt: 'asc' },
        }),
      );
      const [ended, asked] = await Promise.all([
        x.http(
          'post',
          `/staff/security/roster/templates/${template.id}/end`,
          supervisor.token,
        ),
        x.http('post', '/gate/swaps', guard.token, {
          slotId: slot.id,
          colleagueId: colleague.id,
        }),
      ]);
      expect(ended.status).toBe(200);
      expect([201, 400]).toContain(asked.status);
      const live = await x.inTx(s.c, (tx) =>
        tx.guardShiftSwap.count({
          where: {
            requesterSlotId: slot.id,
            status: { in: ['requested', 'accepted'] },
          },
        }),
      );
      expect(live).toBe(0);
      expect((await x.slotRow(s.c, slot.id)).status).toBe('cancelled');
    }
  });
});
