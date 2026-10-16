import {
  addDays,
  localDate,
  zonedInstant,
} from '../../src/core/common/slots/day-slots';
import { RosterService } from '../../src/gate/roster/roster.service';
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
}

export async function guardDutyWorld(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<GuardDutyWorld> {
  const roster = h.moduleRef.get(RosterService);
  const today = localDate(new Date(), ZONE);
  return helpers.asManager(b, async () => {
    const template = await roster.createTemplate({
      guardId: b.ids.guard,
      gateId: b.gateId,
      schedule: { days: EVERY_DAY, windows: [{ from: '02:00', to: '03:00' }] },
      effectiveFrom: addDays(today, 1),
    });
    const startsAt = zonedInstant(addDays(today, 2), 10 * 60, ZONE)!;
    const slot = await roster.createSlot({
      guardId: b.ids.guard,
      gateId: b.gateId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
    });
    return { bRosterTemplateId: template.id, bRosterSlotId: slot.id };
  });
}
