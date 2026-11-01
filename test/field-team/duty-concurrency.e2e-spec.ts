import {
  ROSTER_ATTENDANCE_SWEEP,
  TECHNICIAN_DUTY_SWEEP,
} from '../../src/gate/roster/roster-attendance';
import { fieldTeamHelpers } from '../setup/field-team';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0078: going on duty, the absence sweep, the duty sweep and a cancel
 * meet on one technician's slot. Going on duty takes the technician's
 * account row, then their roster lock, then the slot; the duty sweep the
 * same order; the absence sweep and a cancel take the slot alone. So a
 * slot is filled once at most, marked absent once at most, and never both
 * filled and cancelled.
 */
describe('The technicians’ roster — concurrency', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof fieldTeamHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof fieldTeamHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = fieldTeamHelpers(h);
    s = await x.setUp('Duty Race Court');
  }, 120_000);

  afterAll(() => h.close());

  it('going on duty racing the absence sweep: filled either way, marked absent and told at most once', async () => {
    for (let i = 0; i < 5; i++) {
      const tech = await x.technician(s.c);
      const slot = await x.dutySlot(s.c, tech.id, 61);
      const [res] = await Promise.all([
        x.dutyRaw(tech, true),
        x.sweep(ROSTER_ATTENDANCE_SWEEP, new Date()),
      ]);
      expect(res.status).toBe(200);
      const row = await x.slotRow(s.c, slot.id);
      expect(row.dutyStartedAt).not.toBeNull();
      const told = (await x.notifications(s.c, s.boss.id)).filter(
        (n) => n.targetId === slot.id,
      );
      expect(told.length).toBe(row.absentAt ? 1 : 0);
      await x.offDuty(tech);
    }
  });

  it('going on duty racing a cancel: the slot is filled or cancelled, never both', async () => {
    for (let i = 0; i < 5; i++) {
      const tech = await x.technician(s.c);
      const slot = await x.dutySlot(s.c, tech.id, 5, 60);
      const [duty, cancel] = await Promise.all([
        x.dutyRaw(tech, true),
        x.http(
          'post',
          `/staff/field-team/roster/slots/${slot.id}/cancel`,
          s.boss.token,
          { reasonCode: 'other' },
        ),
      ]);
      expect(duty.status).toBe(200);
      const row = await x.slotRow(s.c, slot.id);
      if (cancel.status === 200) {
        expect(row.status).toBe('cancelled');
        expect(row.dutyStartedAt).toBeNull();
      } else {
        expect(cancel.status).toBe(409);
        expect(row.status).toBe('scheduled');
        expect(row.dutyStartedAt).not.toBeNull();
      }
      await x.offDuty(tech);
    }
  });

  it('going on duty racing the duty sweep: the slot is filled once', async () => {
    for (let i = 0; i < 5; i++) {
      const tech = await x.technician(s.c);
      const slot = await x.dutySlot(s.c, tech.id, 1, 60);
      const [res] = await Promise.all([
        x.dutyRaw(tech, true),
        x.sweep(TECHNICIAN_DUTY_SWEEP, new Date()),
      ]);
      expect(res.status).toBe(200);
      const row = await x.slotRow(s.c, slot.id);
      expect(row.dutyStartedAt).not.toBeNull();
      expect(row.dutyEndedAt).toBeNull();
      await x.offDuty(tech);
      expect((await x.slotRow(s.c, slot.id)).dutyEndedAt).not.toBeNull();
    }
  });
});
