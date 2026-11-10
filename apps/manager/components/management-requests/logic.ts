/**
 * What the request screens decide without the network (ADR 0039): which
 * filters a view of the inbox sends, which actions a status allows, and the
 * office-hours form's own checks. Plain TypeScript with no imports, so the
 * tests run it as is. The API decides again on every call.
 */

export const VIEWS = ['open', 'mine', 'unassigned', 'overdue', 'escalated', 'all'] as const;
export type View = (typeof VIEWS)[number];

export interface Picked {
  status: string;
  type: string;
  topicId: string;
  /** An account id, or '' for anyone. */
  assignee: string;
}

export interface InboxFilters {
  status: string;
  type: string;
  topicId: string;
  assignee: string;
  open: 'true' | '';
  overdue: 'true' | '';
  escalated: 'true' | '';
}

/**
 * The query of a view. A view narrows who and what; a status picked by hand
 * says what to show and switches "not closed" off. "Mine" and "Unassigned"
 * own the assignee, whatever the assignee select says.
 */
export function filtersFor(view: View, picked: Picked): InboxFilters {
  const assignee = view === 'mine' ? 'me' : view === 'unassigned' ? 'none' : picked.assignee;
  // Overdue is open or in progress by definition, and an escalation of a
  // closed request needs nobody: only "All" shows closed ones unasked.
  const live = view !== 'all' && view !== 'overdue' && picked.status === '';
  return {
    status: picked.status,
    type: picked.type,
    topicId: picked.topicId,
    assignee,
    open: live ? 'true' : '',
    overdue: view === 'overdue' ? 'true' : '',
    escalated: view === 'escalated' ? 'true' : '',
  };
}

/** The catalog key of the inbox's empty text for a view. */
export function emptyKey(view: View): `empty.${'mine' | 'unassigned' | 'overdue' | 'escalated' | 'any'}` {
  switch (view) {
    case 'mine':
    case 'unassigned':
    case 'overdue':
    case 'escalated':
      return `empty.${view}`;
    default:
      return 'empty.any';
  }
}

const LIVE = ['open', 'in_progress', 'answered'];

/** The backend's request-rules.ts, for showing and hiding buttons. */
export function actionsFor(status: string) {
  const live = LIVE.includes(status);
  return {
    reply: live,
    /** A staff note is possible on a closed request too. */
    note: true,
    start: status === 'open',
    assign: live,
    close: live,
    appointment: live,
  };
}

const LIVE_APPOINTMENT = ['requested', 'proposed', 'confirmed'];

/** What staff may do to a request's appointment (`null`: it has none). */
export function appointmentActionsFor(requestStatus: string, appointmentStatus: string | null) {
  const live = appointmentStatus !== null && LIVE_APPOINTMENT.includes(appointmentStatus);
  const open = LIVE.includes(requestStatus);
  return {
    confirm: open && appointmentStatus === 'requested',
    /** Another slot instead of the resident's, or a slot when there is none. */
    propose: open,
    cancel: open && live,
    /** How the propose button reads: a key of the requests catalog. */
    proposeLabel: live ? ('proposeAnother' as const) : ('propose' as const),
  };
}

// ---------------------------------------------------------------------------
// Office hours
// ---------------------------------------------------------------------------

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export interface Window {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/** 540 → "09:00"; 1440 → "24:00" (the end of the day). */
export function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** Every half hour of the day, as select options; `end` adds 24:00 and drops 00:00. */
export function halfHours(end = false): number[] {
  const all = Array.from({ length: 49 }, (_, i) => i * 30);
  return end ? all.slice(1) : all.slice(0, 48);
}

/** What is wrong with a window: it ends before it starts, or overlaps another of its day. */
export type WindowProblem = 'order' | 'overlap';

/**
 * What is wrong with a set of windows, by position — the API's own two
 * rules (office-hours-rules.ts): a window ends after it starts, and two
 * windows of one day may touch but not overlap.
 */
export function windowProblemCodes(windows: readonly Window[]): Record<number, WindowProblem> {
  const problems: Record<number, WindowProblem> = {};
  windows.forEach((w, i) => {
    if (w.endMinute <= w.startMinute) {
      problems[i] = 'order';
      return;
    }
    const clash = windows.some(
      (o, j) =>
        j < i && o.weekday === w.weekday && o.endMinute > o.startMinute && o.startMinute < w.endMinute && w.startMinute < o.endMinute,
    );
    if (clash) problems[i] = 'overlap';
  });
  return problems;
}

const PROBLEM_TEXT: Record<WindowProblem, string> = {
  order: 'Ends after it starts.',
  overlap: 'Overlaps another window of the same day.',
};

/** `windowProblemCodes` in English words (the facilities' pages still read these). */
export function windowProblems(windows: readonly Window[]): Record<number, string> {
  const problems: Record<number, string> = {};
  for (const [i, code] of Object.entries(windowProblemCodes(windows))) problems[Number(i)] = PROBLEM_TEXT[code];
  return problems;
}

/** By weekday, then start: how the API returns them. */
export function sortWindows<T extends Window>(windows: readonly T[]): T[] {
  return [...windows].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
}

export function sameWindows(a: readonly Window[], b: readonly Window[]): boolean {
  const key = (ws: readonly Window[]) => sortWindows(ws).map((w) => `${w.weekday}:${w.startMinute}-${w.endMinute}`).join('|');
  return key(a) === key(b);
}

/**
 * "Monday 09:00–12:00, 14:00–16:00"-style lines, one per weekday that is
 * open, the day named by `dayName` (0 = Sunday) and its ranges joined by
 * `join` (the page's list format).
 */
export function describeWindowsWith(
  windows: readonly Window[],
  dayName: (weekday: number) => string,
  join: (ranges: string[]) => string = (ranges) => ranges.join(', '),
): string[] {
  return WEEKDAYS.flatMap((_, weekday) => {
    const day = sortWindows(windows.filter((w) => w.weekday === weekday));
    return day.length ? [`${dayName(weekday)} ${join(day.map((w) => `${clock(w.startMinute)}–${clock(w.endMinute)}`))}`] : [];
  });
}

/** `describeWindowsWith` in English (the facilities' pages still read these). */
export function describeWindows(windows: readonly Window[]): string[] {
  return describeWindowsWith(windows, (weekday) => WEEKDAYS[weekday] ?? '');
}

/** How many slots a week of these windows gives, at this slot length. */
export function slotsPerWeek(windows: readonly Window[], slotMinutes: number): number {
  if (!(slotMinutes > 0)) return 0;
  return windows.reduce((n, w) => n + Math.max(0, Math.floor((w.endMinute - w.startMinute) / slotMinutes)), 0);
}

/** A name the compound wrote in both languages, in the page's: the Arabic one when there is one. */
export function localName(locale: string, x: { nameEn: string; nameAr?: string | null }): string {
  return locale === 'ar' && x.nameAr ? x.nameAr : x.nameEn;
}
