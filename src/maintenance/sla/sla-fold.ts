import type { SlaClockState, SlaEventKind } from '@prisma/client';

// ============================================================================
// The SLA projection, as a pure function of the events (ADR 0034).
// ============================================================================
//
// A clock's events are folded in `seq` order into its state and its due
// time. Elapsed time is always computed from the events (the sum of the
// running intervals), never kept as a counter: the projection stores the
// state and `due_at` only, and a test rebuilds every clock from its events
// and compares.

export interface SlaEventLike {
  seq: number;
  kind: SlaEventKind;
  at: Date;
  targetMinutes: number;
}

export interface ClockProjection {
  state: SlaClockState;
  targetMinutes: number;
  startedAt: Date;
  /** While running: when the target is reached. Null otherwise. */
  dueAt: Date | null;
  /** While paused: since when. */
  pausedAt: Date | null;
  /** Once met, breached or stopped: when. */
  endedAt: Date | null;
  lastSeq: number;
}

const MINUTE = 60_000;

export const TERMINAL: ReadonlySet<SlaClockState> = new Set([
  'met',
  'breached',
  'stopped',
]);

/**
 * The clock after its events. `started` must come first (seq 1); nothing
 * may follow a terminal event. Throws on a sequence the recorder never
 * writes, so a broken history is loud.
 */
export function fold(events: readonly SlaEventLike[]): ClockProjection {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const first = sorted[0];
  if (!first || first.kind !== 'started' || first.seq !== 1)
    throw new Error('An SLA clock starts with `started` at seq 1');
  let state: SlaClockState = 'running';
  let target = first.targetMinutes;
  let elapsed = 0;
  let runningSince: number | null = first.at.getTime();
  let pausedAt: Date | null = null;
  let endedAt: Date | null = null;
  for (const e of sorted.slice(1)) {
    if (TERMINAL.has(state))
      throw new Error(`No SLA event may follow ${state}`);
    const at = e.at.getTime();
    switch (e.kind) {
      case 'started':
        throw new Error('An SLA clock starts once');
      case 'paused':
        if (runningSince === null) throw new Error('Paused while not running');
        elapsed += Math.max(0, at - runningSince);
        runningSince = null;
        state = 'paused';
        pausedAt = e.at;
        break;
      case 'resumed':
        if (runningSince !== null) throw new Error('Resumed while running');
        runningSince = at;
        state = 'running';
        pausedAt = null;
        break;
      case 'retargeted':
        target = e.targetMinutes;
        break;
      case 'met':
      case 'breached':
      case 'stopped':
        if (runningSince !== null) elapsed += Math.max(0, at - runningSince);
        runningSince = null;
        pausedAt = null;
        state = e.kind;
        endedAt = e.at;
        break;
    }
  }
  return {
    state,
    targetMinutes: target,
    startedAt: first.at,
    dueAt:
      runningSince === null
        ? null
        : new Date(runningSince + target * MINUTE - elapsed),
    pausedAt,
    endedAt,
    lastSeq: sorted[sorted.length - 1].seq,
  };
}

/** Running time so far, in milliseconds, as of `now` (from the events). */
export function elapsedMs(events: readonly SlaEventLike[], now: Date): number {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let elapsed = 0;
  let runningSince: number | null = null;
  for (const e of sorted) {
    const at = e.at.getTime();
    if (e.kind === 'started' || e.kind === 'resumed') runningSince = at;
    else if (
      runningSince !== null &&
      (e.kind === 'paused' ||
        e.kind === 'met' ||
        e.kind === 'breached' ||
        e.kind === 'stopped')
    ) {
      elapsed += Math.max(0, at - runningSince);
      runningSince = null;
    }
  }
  if (runningSince !== null)
    elapsed += Math.max(0, now.getTime() - runningSince);
  return elapsed;
}
