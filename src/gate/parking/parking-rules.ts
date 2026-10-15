/** A visitor parking booking lasts at least this many minutes. */
export const MIN_MINUTES = 15;
/** It starts at most this many days ahead. */
export const DAYS_AHEAD = 14;
/** It starts no earlier than this many minutes ago (a visitor arriving now). */
export const EARLIEST_MINUTES = 15;
/** A visitor's name is deleted this many days after the booking ends. */
export const VISITOR_NAME_RETENTION_DAYS = 30;
/** What the guard sees ahead: bookings starting within this many minutes. */
export const GUARD_AHEAD_MINUTES = 120;

export const VISITOR_NAME = { min: 1, max: 80 } as const;
export const SLOT_CODE = { min: 1, max: 20 } as const;
export const SLOT_PLACE = { min: 1, max: 80 } as const;
export const AREA_NAME = { min: 1, max: 60 } as const;
export const AREA_CAPACITY = { min: 1, max: 500 } as const;

export interface Window {
  startsAt: Date;
  endsAt: Date;
}

/**
 * The most windows that hold one instant inside [from, to), windows
 * half-open (ADR 0045). The exact form of counting an area's bookings by
 * overlap: two one-hour bookings at 10:00 and 12:00 both overlap a 10:00–
 * 13:00 window, yet never hold two spaces at once.
 */
export function peakOverlap(
  windows: readonly Window[],
  from: Date,
  to: Date,
): number {
  const events: [number, number][] = [];
  for (const w of windows) {
    const start = Math.max(w.startsAt.getTime(), from.getTime());
    const end = Math.min(w.endsAt.getTime(), to.getTime());
    if (start >= end) continue;
    events.push([start, 1], [end, -1]);
  }
  // At one instant an end comes before a start: windows are half-open.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let held = 0;
  let peak = 0;
  for (const [, delta] of events) {
    held += delta;
    peak = Math.max(peak, held);
  }
  return peak;
}

/** Spaces an area has free at `now`: never below zero after a capacity cut. */
export function freeSpaces(
  capacity: number,
  windows: readonly Window[],
  now: Date,
): number {
  const held = windows.filter(
    (w) => w.startsAt <= now && w.endsAt > now,
  ).length;
  return Math.max(0, capacity - held);
}
