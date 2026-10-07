import type { SlaClockState, TicketStatus } from '@prisma/client';
import { overdueClocks, type ClockFacts } from './sla-overdue';

const now = new Date('2026-10-11T10:00:00.000Z');
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

const clock = (
  name: 'response' | 'resolution',
  state: SlaClockState,
  dueIn: number | null = null,
): ClockFacts => ({
  clock: name,
  state,
  dueAt: dueIn === null ? null : at(dueIn),
});

const overdue = (
  clocks: ClockFacts[],
  over: { status?: TicketStatus; responded?: boolean } = {},
) =>
  overdueClocks({
    status: over.status ?? 'assigned',
    responded: over.responded ?? false,
    clocks,
    now,
  });

describe('overdue (ADR 0038)', () => {
  it('a running clock is late from its due time on, by the clock it is given', () => {
    expect(overdue([clock('response', 'running', 1)])).toEqual([]);
    expect(overdue([clock('response', 'running', 0)])).toEqual(['response']);
    expect(overdue([clock('response', 'running', -1)])).toEqual(['response']);
  });

  it('a breached clock is late; a met, stopped or paused one is not', () => {
    expect(overdue([clock('resolution', 'breached')])).toEqual(['resolution']);
    for (const state of ['met', 'stopped', 'paused'] as const)
      expect(overdue([clock('resolution', state)])).toEqual([]);
  });

  it('a late response is no longer overdue once the ticket is responded to', () => {
    const clocks = [
      clock('response', 'breached'),
      clock('resolution', 'running', 600),
    ];
    expect(overdue(clocks)).toEqual(['response']);
    expect(overdue(clocks, { responded: true, status: 'in_progress' })).toEqual(
      [],
    );
  });

  it('a late resolution stays overdue until the work is reported done', () => {
    const clocks = [clock('response', 'met'), clock('resolution', 'breached')];
    for (const status of ['in_progress', 'on_hold'] as const)
      expect(overdue(clocks, { status, responded: true })).toEqual([
        'resolution',
      ]);
    for (const status of ['completed', 'closed', 'cancelled'] as const)
      expect(overdue(clocks, { status, responded: true })).toEqual([]);
  });

  it('both, in a fixed order', () => {
    expect(
      overdue([clock('resolution', 'breached'), clock('response', 'breached')]),
    ).toEqual(['resolution', 'response']);
  });
});
