import { assetHelpers } from './assets';
import type { HttpHarness } from './http-app';

/**
 * Helpers for the maintenance operations suites (ADR 0065): the asset
 * set-up with automatic dispatch off and its technicians specialized in
 * the general and plumbing categories and available, and a resident's
 * ticket assigned to one of them.
 */
export function operationsHelpers(h: HttpHarness) {
  const a = assetHelpers(h);

  async function setUp(technicians = 1) {
    const s = await a.setUp(technicians);
    // Tickets go to whom a suite assigns them, never by the engine.
    await a.setAutoDispatch(s.c, false);
    for (const tech of s.techs) {
      await a.specialize(s, tech, ['general', 'plumbing']);
      await a.setAvailability(s.c, tech.id, 'available');
    }
    return s;
  }
  type SetUp = Awaited<ReturnType<typeof setUp>>;

  /** A resident's unit ticket, assigned to a technician; its id. */
  async function assignedTicket(s: SetUp, tech = 0): Promise<string> {
    const id = await a.openTicket(s);
    await a
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: s.techs[tech].id,
      })
      .expect((r) => expect([200, 201, 204]).toContain(r.status));
    return id;
  }

  /** The assigned ticket, started; its id. */
  async function startedTicket(s: SetUp, tech = 0): Promise<string> {
    const id = await assignedTicket(s, tech);
    await a
      .http('post', `/technician/tickets/${id}/start`, s.techs[tech].token)
      .expect(204);
    return id;
  }

  return { ...a, setUp, assignedTicket, startedTicket };
}

export type OperationsSetUp = Awaited<
  ReturnType<ReturnType<typeof operationsHelpers>['setUp']>
>;
