/** What POST /public/visitor-passes/lookup returns (ADR 0030). */
export type PassView = {
  compoundName: string;
  unitCode: string;
  kind: 'one_time' | 'recurring';
  partySize: number;
  validFrom: string;
  validUntil: string;
  timeZone: string;
  schedule: { days: number[]; windows: { from: string; to: string }[] } | null;
  status: 'active' | 'used' | 'cancelled' | 'expired';
  statusReason: 'host_cancelled' | 'wrong_recipient' | null;
  code: string | null;
  qrPayload: string | null;
  visitorDirections: string | null;
  emergencyPhone: string | null;
};

export type PassState =
  | 'active'
  | 'not_yet'
  | 'outside_schedule'
  | 'used'
  | 'expired'
  | 'cancelled'
  | 'cancelled_host'
  | 'cancelled_wrong';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Day of the week (0 = Sunday) and minutes past midnight, in a zone. */
export function zonedClock(at: Date, timeZone: string): { day: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const value = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const day = DAYS.indexOf(value('weekday'));
    const minutes = Number(value('hour')) * 60 + Number(value('minute'));
    return day < 0 || Number.isNaN(minutes) ? null : { day, minutes };
  } catch {
    // An unknown zone: the schedule cannot be judged here.
    return null;
  }
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

/**
 * Whether the compound's clock is inside the schedule. A window whose `to`
 * is before its `from` runs past midnight and belongs to the day it starts.
 */
export function inSchedule(schedule: NonNullable<PassView['schedule']>, at: Date, timeZone: string): boolean {
  const clock = zonedClock(at, timeZone);
  if (!clock) return true;
  const yesterday = (clock.day + 6) % 7;
  return schedule.windows.some((w) => {
    const from = minutesOf(w.from);
    const to = minutesOf(w.to);
    if (to > from) return schedule.days.includes(clock.day) && clock.minutes >= from && clock.minutes < to;
    return (
      (schedule.days.includes(clock.day) && clock.minutes >= from) ||
      (schedule.days.includes(yesterday) && clock.minutes < to)
    );
  });
}

/**
 * The API's status, refined for the visitor: an `active` pass before its
 * window or outside its schedule still has its code, but will not open the
 * gate yet. The API has no such state; it is worked out from the window.
 */
export function passState(view: PassView, now: Date): PassState {
  if (view.status === 'used') return 'used';
  if (view.status === 'expired') return 'expired';
  if (view.status === 'cancelled') {
    if (view.statusReason === 'host_cancelled') return 'cancelled_host';
    if (view.statusReason === 'wrong_recipient') return 'cancelled_wrong';
    return 'cancelled';
  }
  if (now.getTime() < Date.parse(view.validFrom)) return 'not_yet';
  if (view.schedule && !inSchedule(view.schedule, now, view.timeZone)) return 'outside_schedule';
  return 'active';
}
