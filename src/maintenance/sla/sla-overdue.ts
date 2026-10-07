import type { SlaClock, SlaClockState, TicketStatus } from '@prisma/client';

// ============================================================================
// Overdue (ADR 0038)
// ============================================================================
//
// What "overdue" means to a resident: a commitment of the current SLA cycle
// that is late **and still unmet**. Pure: the views and the escalation feed
// it what they read, so both always agree.
//
// - Late: the clock is breached, or it is running and its due time has
//   passed by the database's clock. The read does not wait for the breach
//   sweep, and writes nothing.
// - Unmet: the response, until the ticket is responded to (on the way, in
//   progress, or a visit proposed by the technician's side); the
//   resolution, until the work is reported done.
//
// A paused clock is never past due (it has no due time); one that breached
// before the pause stays late. A ticket nobody is working on any more
// (completed, closed, cancelled) is never overdue.

export interface ClockFacts {
  clock: SlaClock;
  state: SlaClockState;
  dueAt: Date | null;
}

/** The statuses in which a commitment may still be unmet. */
export const AWAITED: readonly TicketStatus[] = [
  'new',
  'assigned',
  'en_route',
  'in_progress',
  'on_hold',
];

function late(c: ClockFacts, now: Date): boolean {
  if (c.state === 'breached') return true;
  return (
    c.state === 'running' &&
    c.dueAt !== null &&
    c.dueAt.getTime() <= now.getTime()
  );
}

/** The clocks of the current cycle that are late and whose commitment is unmet. */
export function overdueClocks(input: {
  status: TicketStatus;
  /** Responded to since it was opened or last reopened (ADR 0034). */
  responded: boolean;
  clocks: readonly ClockFacts[];
  now: Date;
}): SlaClock[] {
  if (!AWAITED.includes(input.status)) return [];
  return input.clocks
    .filter((c) => late(c, input.now))
    .filter((c) => c.clock === 'resolution' || !input.responded)
    .map((c) => c.clock)
    .sort();
}
