import type { Response } from 'supertest';
import {
  addDays,
  localDate,
  zonedInstant,
} from '../../src/core/common/slots/day-slots';
import { HandoverService } from '../../src/gate/handover/handover.service';
import { ShiftsService } from '../../src/gate/shifts/shifts.service';
import { gateHelpers } from '../setup/gate';
import { call } from './request';
import type { World } from './world';

const ZONE = 'Africa/Cairo';

/**
 * A real call for each of the guards' duty routes (ADR 0050), as A's
 * manager or A's guard. Each write takes a time of its own on A's guard's
 * roster, so no call answers ROSTER_OVERLAP instead.
 */
export function guardDutyCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const manager = (
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    payload?: object,
  ) =>
    call(world(), method, path, {
      token: world().a.tokens.manager,
      body: payload,
    });
  const guard = (method: 'GET' | 'POST', path: string, payload?: object) =>
    call(world(), method, path, {
      token: world().a.tokens.guard,
      body: payload,
    });
  const today = () => localDate(new Date(), ZONE);
  /** A template of A's guard on one weekday, at 04:00 for an hour. */
  const template = (weekday: number) =>
    manager('POST', '/staff/security/roster/templates', {
      guardId: world().a.ids.guard,
      gateId: world().a.gateId,
      schedule: { days: [weekday], windows: [{ from: '04:00', to: '05:00' }] },
      effectiveFrom: addDays(today(), 1),
    });
  /** A single slot of A's guard, `days` ahead at noon for an hour. */
  const slot = (days: number) => {
    const startsAt = zonedInstant(addDays(today(), days), 12 * 60, ZONE)!;
    return manager('POST', '/staff/security/roster/slots', {
      guardId: world().a.ids.guard,
      gateId: world().a.gateId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
    });
  };
  const id = (res: Response) => (res.body as { id: string }).id;
  /** Each swap's slot on a day of its own: A's guard's slots never overlap. */
  let nextDay = 20;
  /**
   * A handover at A's gate by another guard, ticking the whole checklist:
   * its id, for A's guard (on shift there) to read and acknowledge.
   */
  const aHandover = async () => {
    const w = world();
    const relief = await gateHelpers(w.h).guard(w.a);
    const shifts = w.h.moduleRef.get(ShiftsService);
    const handover = w.h.moduleRef.get(HandoverService);
    const ended = await w.helpers.as(
      w.a,
      { id: relief.id, type: 'staff' },
      async () => {
        await shifts.start({ gateId: w.a.gateId });
        const items = await handover.activeItems();
        return shifts.end({ checklist: items.map((i) => i.id) });
      },
    );
    return (
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.guardHandover.findFirstOrThrow({
          where: { shiftId: ended.id },
        }),
      )
    ).id;
  };
  /** A custom task for A's gate, where A's guard is on shift: its id. */
  const aTask = async () =>
    id(
      await manager('POST', '/staff/security/tasks', {
        kind: 'custom',
        title: 'No-store task',
        gateId: world().a.gateId,
      }),
    );
  /**
   * A swap: A's guard asks a relief guard of A to cover a new slot of A's
   * guard. `accepted`: the relief guard accepted it.
   */
  const aSwap = async (accepted = false) => {
    const w = world();
    const relief = await gateHelpers(w.h).guard(w.a);
    const reliefToken = await w.tokenFor(w.a, relief.id, 'staff');
    const s = id(await slot(nextDay++));
    const swap = id(
      await guard('POST', '/gate/swaps', {
        slotId: s,
        colleagueId: relief.id,
      }),
    );
    if (accepted)
      await call(w, 'POST', `/gate/swaps/${swap}/accept`, {
        token: reliefToken,
      });
    return { swap, reliefToken };
  };
  const anItem = async () =>
    id(
      await manager('POST', '/staff/security/handover-items', {
        label: `No-store item ${Date.now()}`,
      }),
    );
  return {
    'GET /staff/security/posts': () => manager('GET', '/staff/security/posts'),
    'GET /staff/security/guards': () =>
      manager('GET', '/staff/security/guards'),
    'POST /staff/security/roster/templates': () => template(3),
    'GET /staff/security/roster/templates': () =>
      manager('GET', '/staff/security/roster/templates'),
    'POST /staff/security/roster/templates/{id}/end': async () =>
      manager(
        'POST',
        `/staff/security/roster/templates/${id(await template(4))}/end`,
      ),
    'POST /staff/security/roster/slots': () => slot(3),
    'GET /staff/security/roster/slots': () =>
      manager('GET', '/staff/security/roster/slots'),
    'POST /staff/security/roster/slots/{id}/cancel': async () =>
      manager(
        'POST',
        `/staff/security/roster/slots/${id(await slot(5))}/cancel`,
        { reasonCode: 'other' },
      ),
    'GET /staff/security/attendance': () =>
      manager('GET', '/staff/security/attendance'),
    'GET /gate/roster': () => guard('GET', '/gate/roster'),
    'GET /gate/roster/attendance': () =>
      guard('GET', '/gate/roster/attendance'),
    'GET /gate/handover-items': () => guard('GET', '/gate/handover-items'),
    'GET /gate/handovers/pending': async () => {
      await aHandover();
      return guard('GET', '/gate/handovers/pending');
    },
    'POST /gate/handovers/{id}/acknowledge': async () =>
      guard('POST', `/gate/handovers/${await aHandover()}/acknowledge`),
    'GET /staff/security/handovers': () =>
      manager('GET', '/staff/security/handovers'),
    'GET /staff/security/handovers/{id}': async () =>
      manager('GET', `/staff/security/handovers/${await aHandover()}`),
    'GET /staff/security/handover-items': () =>
      manager('GET', '/staff/security/handover-items'),
    'POST /staff/security/handover-items': () =>
      manager('POST', '/staff/security/handover-items', {
        label: 'No-store keys',
      }),
    'GET /gate/my-work': () => guard('GET', '/gate/my-work'),
    'POST /gate/swaps': async () => {
      const w = world();
      const relief = await gateHelpers(w.h).guard(w.a);
      return guard('POST', '/gate/swaps', {
        slotId: id(await slot(nextDay++)),
        colleagueId: relief.id,
      });
    },
    'GET /gate/swaps': () => guard('GET', '/gate/swaps'),
    'GET /gate/swaps/{id}': async () =>
      guard('GET', `/gate/swaps/${(await aSwap()).swap}`),
    'POST /gate/swaps/{id}/accept': async () => {
      const { swap, reliefToken } = await aSwap();
      return call(world(), 'POST', `/gate/swaps/${swap}/accept`, {
        token: reliefToken,
      });
    },
    'POST /gate/swaps/{id}/decline': async () => {
      const { swap, reliefToken } = await aSwap();
      return call(world(), 'POST', `/gate/swaps/${swap}/decline`, {
        token: reliefToken,
      });
    },
    'POST /gate/swaps/{id}/withdraw': async () =>
      guard('POST', `/gate/swaps/${(await aSwap()).swap}/withdraw`),
    'GET /staff/security/swaps': () => manager('GET', '/staff/security/swaps'),
    'GET /staff/security/swaps/{id}': async () =>
      manager('GET', `/staff/security/swaps/${(await aSwap()).swap}`),
    'POST /staff/security/swaps/{id}/approve': async () =>
      manager(
        'POST',
        `/staff/security/swaps/${(await aSwap(true)).swap}/approve`,
      ),
    'POST /staff/security/swaps/{id}/reject': async () =>
      manager(
        'POST',
        `/staff/security/swaps/${(await aSwap(true)).swap}/reject`,
        { reasonCode: 'too_late' },
      ),
    'POST /staff/security/tasks': () =>
      manager('POST', '/staff/security/tasks', {
        kind: 'custom',
        title: 'No-store task',
        gateId: world().a.gateId,
      }),
    'GET /staff/security/tasks': () => manager('GET', '/staff/security/tasks'),
    'GET /staff/security/tasks/{id}': async () =>
      manager('GET', `/staff/security/tasks/${await aTask()}`),
    'POST /staff/security/tasks/{id}/cancel': async () =>
      manager('POST', `/staff/security/tasks/${await aTask()}/cancel`, {
        reasonCode: 'duplicate',
      }),
    'GET /gate/tasks/{id}': async () =>
      guard('GET', `/gate/tasks/${await aTask()}`),
    'POST /gate/tasks/{id}/take': async () =>
      guard('POST', `/gate/tasks/${await aTask()}/take`),
    'POST /gate/tasks/{id}/complete': async () => {
      const task = await aTask();
      await guard('POST', `/gate/tasks/${task}/take`);
      return guard('POST', `/gate/tasks/${task}/complete`, { outcome: 'done' });
    },
    'PATCH /staff/security/handover-items/{id}': async () =>
      manager('PATCH', `/staff/security/handover-items/${await anItem()}`, {
        position: 5,
      }),
  };
}
