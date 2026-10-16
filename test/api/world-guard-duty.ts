import {
  addDays,
  localDate,
  zonedInstant,
} from '../../src/core/common/slots/day-slots';
import { GuardInstructionsService } from '../../src/gate/guard-instructions/guard-instructions.service';
import { HandoverService } from '../../src/gate/handover/handover.service';
import { RosterService } from '../../src/gate/roster/roster.service';
import { ShiftsService } from '../../src/gate/shifts/shifts.service';
import { SwapsService } from '../../src/gate/swaps/swaps.service';
import { TasksService } from '../../src/gate/tasks/tasks.service';
import { gateHelpers } from '../setup/gate';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

const ZONE = 'Africa/Cairo';
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** B's guard duty (ADR 0050): foreign ids for the matrix. */
export interface GuardDutyWorld {
  /** A roster template of B's guard at B's gate, from tomorrow. */
  bRosterTemplateId: string;
  /** A single slot of B's guard, in two days. */
  bRosterSlotId: string;
  /** An item of B's handover checklist. */
  bHandoverItemId: string;
  /** The handover of a shift another guard of B ended at B's gate. */
  bHandoverId: string;
  /** A custom task for B's gate. */
  bTaskId: string;
  /** B's guard asks the relief guard to cover B's single slot. */
  bSwapId: string;
  /** An instruction to all of B's guards. */
  bInstructionId: string;
}

export async function guardDutyWorld(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<GuardDutyWorld> {
  const rosterService = h.moduleRef.get(RosterService);
  const today = localDate(new Date(), ZONE);
  const roster = await helpers.asManager(b, async () => {
    const template = await rosterService.createTemplate({
      guardId: b.ids.guard,
      gateId: b.gateId,
      schedule: { days: EVERY_DAY, windows: [{ from: '02:00', to: '03:00' }] },
      effectiveFrom: addDays(today, 1),
    });
    const startsAt = zonedInstant(addDays(today, 2), 10 * 60, ZONE)!;
    const slot = await rosterService.createSlot({
      guardId: b.ids.guard,
      gateId: b.gateId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
    });
    const item = await h.moduleRef
      .get(HandoverService)
      .createItem({ label: 'World keys' });
    const instruction = await h.moduleRef
      .get(GuardInstructionsService)
      .send({ title: 'World', body: 'World words', audience: 'all' });
    const task = await h.moduleRef
      .get(TasksService)
      .create({ kind: 'custom', title: 'World task', gateId: b.gateId });
    return {
      bRosterTemplateId: template.id,
      bRosterSlotId: slot.id,
      bHandoverItemId: item.id,
      bTaskId: task.id,
      bInstructionId: instruction.id,
    };
  });
  const relief = await gateHelpers(h).guard(b);
  const shifts = h.moduleRef.get(ShiftsService);
  const ended = await helpers.as(
    b,
    { id: relief.id, type: 'staff' },
    async () => {
      await shifts.start({ gateId: b.gateId });
      return shifts.end({ checklist: [roster.bHandoverItemId] });
    },
  );
  const handover = await helpers.asManager(b, () =>
    helpers.prisma.tenant.guardHandover.findFirstOrThrow({
      where: { shiftId: ended.id },
    }),
  );
  const swap = await helpers.as(b, { id: b.ids.guard, type: 'staff' }, () =>
    h.moduleRef
      .get(SwapsService)
      .request({ slotId: roster.bRosterSlotId, colleagueId: relief.id }),
  );
  return { ...roster, bHandoverId: handover.id, bSwapId: swap.id };
}
