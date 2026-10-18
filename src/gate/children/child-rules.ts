import {
  isWithinSchedule,
  minutesOf,
  type WeeklySchedule,
} from '../../core/common/slots/weekly-schedule';

/** A pickup within this many minutes of an authorized exit is a duplicate (ADR 0054). */
export const PICKUP_DEDUP_MINUTES = 5;
/** The household's records, and the keepers' alerts, are kept this long. */
export const CHILD_RECORD_RETENTION_DAYS = 30;

/** What decides whether an escort may collect the child at a time and place. */
export interface EscortValidity {
  validFrom: string;
  validUntil: string | null;
  schedule: WeeklySchedule | null;
  gateId: string | null;
  placeId: string | null;
}

export interface Post {
  gateId: string | null;
  placeId: string | null;
}

/** Inside its days (compound-local `YYYY-MM-DD`, both ends included). */
export function withinDays(v: EscortValidity, today: string): boolean {
  return (
    v.validFrom <= today && (v.validUntil === null || today <= v.validUntil)
  );
}

/** Its post is anywhere, or exactly the guard's. */
export function atPost(v: EscortValidity, post: Post): boolean {
  if (v.gateId === null && v.placeId === null) return true;
  return v.gateId !== null
    ? v.gateId === post.gateId
    : v.placeId === post.placeId;
}

/**
 * Whether the escort may collect the child now, here: `ok`, or why not
 * (`outside_validity` for days and hours, `wrong_post`).
 */
export function validNow(
  v: EscortValidity,
  at: { today: string; instant: Date; timeZone: string; post: Post },
): 'ok' | 'outside_validity' | 'wrong_post' {
  if (!withinDays(v, at.today)) return 'outside_validity';
  if (v.schedule && !isWithinSchedule(v.schedule, at.instant, at.timeZone))
    return 'outside_validity';
  if (!atPost(v, at.post)) return 'wrong_post';
  return 'ok';
}

/**
 * Whether the escort may collect the child at some time today, wherever:
 * what the guard is shown after scanning the card. A window from
 * yesterday that runs past midnight counts.
 */
export function validToday(
  v: EscortValidity,
  today: string,
  weekday: number,
): boolean {
  if (!withinDays(v, today)) return false;
  if (!v.schedule) return true;
  const { days, windows } = v.schedule;
  if (days.includes(weekday)) return true;
  const yesterday = (weekday + 6) % 7;
  return (
    days.includes(yesterday) &&
    windows.some((w) => minutesOf(w.to) < minutesOf(w.from))
  );
}
