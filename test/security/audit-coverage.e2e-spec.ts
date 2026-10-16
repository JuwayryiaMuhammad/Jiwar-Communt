import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { addDays, localDate } from '../../src/core/common/slots/day-slots';
import { ROSTER_ATTENDANCE_SWEEP } from '../../src/gate/roster/roster-attendance';
import { SWAP_EXPIRY_SWEEP } from '../../src/gate/swaps/swaps.service';
import { auditReaders } from '../setup/audit';
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
  PERMITS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
  SAFETY_COVERAGE,
  VEHICLES_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';

/**
 * One scenario per guard shifts and tasks catalog entry (ADR 0014, 0050):
 * actor, target and metadata — ids, codes and counts by value, never what
 * someone wrote.
 */
const covered = new Set<string>();

/** Words typed in every scenario: no audit row may hold them. */
const WORDS = 'Audit-visible words 5093';

describe('Audit coverage — guard shifts and tasks', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;
  let supervisor: Who;
  let gateId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Guard Duty Audit Court');
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

  describe('the roster', () => {
    it('a template created and ended; a slot created and cancelled', async () => {
      const guard = await x.guard(s.c);
      const from = addDays(localDate(new Date(), 'Africa/Cairo'), 1);
      const t = (
        await x
          .templateRaw(supervisor, {
            guardId: guard.id,
            gateId,
            schedule: { days: [2], windows: [{ from: '06:00', to: '14:00' }] },
            effectiveFrom: from,
          })
          .expect(201)
      ).body as { id: string };
      const created = await single('guard_roster.template_created', t.id);
      expect(created).toMatchObject(by(supervisor, 'guard_roster_template'));
      expect(created.metadata).toEqual({
        guardId: guard.id,
        gateId,
        effectiveFrom: from,
        effectiveUntil: null,
        slots: 4,
      });
      await x
        .http(
          'post',
          `/staff/security/roster/templates/${t.id}/end`,
          supervisor.token,
        )
        .expect(200);
      const ended = await single('guard_roster.template_ended', t.id);
      expect(ended).toMatchObject(by(supervisor, 'guard_roster_template'));
      expect(ended.metadata).toEqual({ reason: 'manager', cancelled: 4 });

      const slot = await x.slot(supervisor, guard.id, { gateId }, 60);
      const made = await single('guard_roster.slot_created', slot.id);
      expect(made).toMatchObject(by(supervisor, 'guard_roster_slot'));
      expect(made.metadata).toEqual({ guardId: guard.id, gateId });
      await x
        .http(
          'post',
          `/staff/security/roster/slots/${slot.id}/cancel`,
          supervisor.token,
          {
            reasonCode: 'schedule_change',
          },
        )
        .expect(200);
      const cancelled = await single('guard_roster.slot_cancelled', slot.id);
      expect(cancelled).toMatchObject(by(supervisor, 'guard_roster_slot'));
      expect(cancelled.metadata).toEqual({ reason: 'schedule_change' });
    });

    it('a shift opened late, and a slot nobody opened', async () => {
      const guard = await x.guard(s.c);
      const slot = await x.pastSlot(s.c, guard.id, { gateId }, 25);
      const shift = await x.start(guard, { gateId });
      const late = await single('guard_shift.late', shift.id);
      expect(late).toMatchObject(by(guard, 'guard_shift'));
      expect(late.metadata).toEqual({ slotId: slot.id, minutes: 25 });
      await x.endRaw(guard).expect(200);

      const absent = await x.pastSlot(
        s.c,
        (await x.guard(s.c)).id,
        { gateId },
        65,
      );
      await x.sweep(ROSTER_ATTENDANCE_SWEEP, new Date());
      const a = await single('guard_shift.absent', absent.id);
      expect(a).toMatchObject(system('guard_roster_slot'));
      expect(a.metadata).toEqual({ unmanned: true, recipients: 2 });
    });
  });

  describe('the handover', () => {
    it('items created and updated: position and state by value, the label as changed', async () => {
      const item = (
        await x
          .http('post', '/staff/security/handover-items', supervisor.token, {
            label: WORDS,
            position: 4,
          })
          .expect(201)
      ).body as { id: string };
      const created = await single('guard_handover_item.created', item.id);
      expect(created).toMatchObject(by(supervisor, 'guard_handover_item'));
      expect(created.changes).toEqual({
        label: { changed: true },
        position: { from: null, to: 4 },
        active: { from: null, to: true },
      });
      await x
        .http(
          'patch',
          `/staff/security/handover-items/${item.id}`,
          supervisor.token,
          {
            label: `${WORDS} again`,
            active: false,
          },
        )
        .expect(200);
      const updated = await single('guard_handover_item.updated', item.id);
      expect(updated.changes).toEqual({
        label: { changed: true },
        active: { from: true, to: false },
      });
    });

    it('recorded at the end, with counts; acknowledged by the next guard', async () => {
      const one = await x.guard(s.c);
      const two = await x.guard(s.c);
      const shift = await x.start(one, { gateId });
      await x.endRaw(one, { notes: WORDS }).expect(200);
      const handover = await x.inTx(s.c, (tx) =>
        tx.guardHandover.findFirstOrThrow({ where: { shiftId: shift.id } }),
      );
      const recorded = await single('guard_handover.recorded', handover.id);
      expect(recorded).toMatchObject(by(one, 'guard_handover'));
      expect(recorded.metadata).toEqual({
        shiftId: shift.id,
        kind: 'guard',
        items: 0,
        notes: true,
      });
      const next = await x.start(two, { gateId });
      await x
        .http('post', `/gate/handovers/${handover.id}/acknowledge`, two.token)
        .expect(200);
      const acked = await single('guard_handover.acknowledged', handover.id);
      expect(acked).toMatchObject(by(two, 'guard_handover'));
      expect(acked.metadata).toEqual({ shiftId: next.id });
      await x.endRaw(two).expect(200);
    });
  });

  describe('tasks', () => {
    it('created, taken, completed; cancelled; carried at a shift’s end: ids, codes and counts, never the words', async () => {
      const guard = await x.guard(s.c);
      const shift = await x.start(guard, { gateId });
      const task = (
        await x
          .http('post', '/staff/security/tasks', supervisor.token, {
            kind: 'custom',
            title: WORDS,
            details: WORDS,
            gateId,
          })
          .expect(201)
      ).body as { id: string };
      const created = await single('guard_task.created', task.id);
      expect(created).toMatchObject(by(supervisor, 'guard_task'));
      expect(created.metadata).toEqual({ kind: 'custom', gateId, told: 1 });
      await x
        .http('post', `/gate/tasks/${task.id}/take`, guard.token)
        .expect(200);
      const taken = await single('guard_task.taken', task.id);
      expect(taken).toMatchObject(by(guard, 'guard_task'));
      expect(taken.metadata).toEqual({ shiftId: shift.id });
      await x
        .http('post', `/gate/tasks/${task.id}/complete`, guard.token, {
          outcome: 'done',
          note: WORDS,
        })
        .expect(200);
      const completed = await single('guard_task.completed', task.id);
      expect(completed.metadata).toEqual({
        outcome: 'done',
        photos: 0,
        note: true,
      });

      const spare = (
        await x
          .http('post', '/staff/security/tasks', supervisor.token, {
            kind: 'custom',
            title: 'Spare',
            gateId,
          })
          .expect(201)
      ).body as { id: string };
      await x
        .http(
          'post',
          `/staff/security/tasks/${spare.id}/cancel`,
          supervisor.token,
          {
            reasonCode: 'duplicate',
          },
        )
        .expect(200);
      const cancelled = await single('guard_task.cancelled', spare.id);
      expect(cancelled).toMatchObject(by(supervisor, 'guard_task'));
      expect(cancelled.metadata).toEqual({ reasonCode: 'duplicate' });

      const mine = (
        await x
          .http('post', '/staff/security/tasks', supervisor.token, {
            kind: 'custom',
            title: 'Mine',
            guardId: guard.id,
          })
          .expect(201)
      ).body as { id: string };
      await x.endRaw(guard).expect(200);
      const carried = await single('guard_task.carried', mine.id);
      expect(carried).toMatchObject(by(guard, 'guard_task'));
      expect(carried.metadata).toEqual({ shiftId: shift.id, gateId });
    });
  });

  describe('swaps', () => {
    const swapOf = async (a: Who, b: Who, inMinutes: number) => {
      const slot = await x.slot(supervisor, a.id, { gateId }, inMinutes, 60);
      const swap = (
        await x
          .http('post', '/gate/swaps', a.token, {
            slotId: slot.id,
            colleagueId: b.id,
            reason: WORDS,
          })
          .expect(201)
      ).body as { id: string };
      return { slot, swap };
    };

    it('asked, answered, withdrawn, decided, expired and cancelled: ids and codes, never the reason', async () => {
      const a = await x.guard(s.c);
      const b = await x.guard(s.c);
      const day = 24 * 60;

      const first = await swapOf(a, b, 2 * day);
      const requested = await single('guard_swap.requested', first.swap.id);
      expect(requested).toMatchObject(by(a, 'guard_shift_swap'));
      expect(requested.metadata).toEqual({
        requesterSlotId: first.slot.id,
        colleagueId: b.id,
        colleagueSlotId: null,
        reason: true,
      });
      await x
        .http('post', `/gate/swaps/${first.swap.id}/decline`, b.token)
        .expect(200);
      expect(await single('guard_swap.declined', first.swap.id)).toMatchObject(
        by(b, 'guard_shift_swap'),
      );

      const second = await swapOf(a, b, 3 * day);
      await x
        .http('post', `/gate/swaps/${second.swap.id}/withdraw`, a.token)
        .expect(200);
      expect(
        await single('guard_swap.withdrawn', second.swap.id),
      ).toMatchObject(by(a, 'guard_shift_swap'));

      const third = await swapOf(a, b, 4 * day);
      await x
        .http('post', `/gate/swaps/${third.swap.id}/accept`, b.token)
        .expect(200);
      expect(await single('guard_swap.accepted', third.swap.id)).toMatchObject(
        by(b, 'guard_shift_swap'),
      );
      await x
        .http(
          'post',
          `/staff/security/swaps/${third.swap.id}/approve`,
          supervisor.token,
        )
        .expect(200);
      const approved = await single('guard_swap.approved', third.swap.id);
      expect(approved).toMatchObject(by(supervisor, 'guard_shift_swap'));
      expect(approved.metadata).toEqual({
        requesterSlotId: third.slot.id,
        colleagueSlotId: null,
      });

      const fourth = await swapOf(a, b, 5 * day);
      await x
        .http('post', `/gate/swaps/${fourth.swap.id}/accept`, b.token)
        .expect(200);
      await x
        .http(
          'post',
          `/staff/security/swaps/${fourth.swap.id}/reject`,
          supervisor.token,
          {
            reasonCode: 'too_late',
          },
        )
        .expect(200);
      expect(
        (await single('guard_swap.rejected', fourth.swap.id)).metadata,
      ).toEqual({
        reasonCode: 'too_late',
      });

      const fifth = await swapOf(a, b, 40);
      await x.sweep(SWAP_EXPIRY_SWEEP, new Date(Date.now() + 45 * 60_000));
      expect(await single('guard_swap.expired', fifth.swap.id)).toMatchObject(
        system('guard_shift_swap'),
      );

      const sixth = await swapOf(a, b, 6 * day);
      await x
        .http(
          'post',
          `/staff/security/roster/slots/${sixth.slot.id}/cancel`,
          supervisor.token,
          {
            reasonCode: 'other',
          },
        )
        .expect(200);
      const cancelled = await single('guard_swap.cancelled', sixth.swap.id);
      expect(cancelled).toMatchObject(by(supervisor, 'guard_shift_swap'));
      expect(cancelled.metadata).toEqual({ reason: 'slot_cancelled' });
    });
  });

  describe('instructions', () => {
    it('issued with counts, acknowledged by the guard, archived with counts: never the words', async () => {
      // A gate of its own: nobody else is on shift or scheduled there.
      const own = (await x.g.gate(s.c)).id;
      const guard = await x.guard(s.c);
      await x.start(guard, { gateId: own });
      const i = (
        await x
          .http('post', '/staff/security/instructions', supervisor.token, {
            title: WORDS,
            body: WORDS,
            audience: 'gate',
            gateId: own,
            urgent: true,
          })
          .expect(201)
      ).body as { id: string };
      const issued = await single('guard_instruction.issued', i.id);
      expect(issued).toMatchObject(by(supervisor, 'guard_instruction'));
      expect(issued.metadata).toEqual({
        audience: 'gate',
        gateId: own,
        urgent: true,
        recipients: 1,
      });
      await x
        .http(
          'post',
          `/gate/guard-instructions/${i.id}/acknowledge`,
          guard.token,
        )
        .expect(200);
      expect(
        await single('guard_instruction.acknowledged', i.id),
      ).toMatchObject(by(guard, 'guard_instruction'));
      await x
        .http(
          'post',
          `/staff/security/instructions/${i.id}/archive`,
          supervisor.token,
        )
        .expect(200);
      expect(
        (await single('guard_instruction.archived', i.id)).metadata,
      ).toEqual({ recipients: 1, acknowledged: 1 });
      await x.endRaw(guard).expect(200);
    });
  });

  describe('catalog completeness', () => {
    it('every guard shifts and tasks entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of GUARD_DUTY_COVERAGE) {
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
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...GUARD_DUTY_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(
        all
          .filter((k) =>
            /^(guard_roster|guard_shift|guard_handover|guard_handover_item|guard_task|guard_swap|guard_instruction|found_item)\./.test(
              k,
            ),
          )
          .sort(),
      ).toEqual([...GUARD_DUTY_COVERAGE].sort());
    });
  });
});
