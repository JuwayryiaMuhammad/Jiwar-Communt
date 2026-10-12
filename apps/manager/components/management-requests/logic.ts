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

export function emptyText(view: View): string {
  switch (view) {
    case 'mine':
      return 'No request is assigned to you';
    case 'unassigned':
      return 'No request is waiting in the queue';
    case 'overdue':
      return 'No request is overdue';
    case 'escalated':
      return 'No request was escalated';
    default:
      return 'No request matches';
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
    /** How the propose button reads. */
    proposeLabel: live ? 'Propose another slot' : 'Propose a slot',
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

/**
 * What is wrong with a set of windows, by position — the API's own two
 * rules (office-hours-rules.ts): a window ends after it starts, and two
 * windows of one day may touch but not overlap.
 */
export function windowProblems(windows: readonly Window[]): Record<number, string> {
  const problems: Record<number, string> = {};
  windows.forEach((w, i) => {
    if (w.endMinute <= w.startMinute) {
      problems[i] = 'Ends after it starts.';
      return;
    }
    const clash = windows.some(
      (o, j) =>
        j < i && o.weekday === w.weekday && o.endMinute > o.startMinute && o.startMinute < w.endMinute && w.startMinute < o.endMinute,
    );
    if (clash) problems[i] = 'Overlaps another window of the same day.';
  });
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

/** "Sat–Thu 09:00–17:00"-style lines, one per weekday that is open. */
export function describeWindows(windows: readonly Window[]): string[] {
  return WEEKDAYS.flatMap((name, weekday) => {
    const day = sortWindows(windows.filter((w) => w.weekday === weekday));
    return day.length ? [`${name} ${day.map((w) => `${clock(w.startMinute)}–${clock(w.endMinute)}`).join(', ')}`] : [];
  });
}

/** How many slots a week of these windows gives, at this slot length. */
export function slotsPerWeek(windows: readonly Window[], slotMinutes: number): number {
  if (!(slotMinutes > 0)) return 0;
  return windows.reduce((n, w) => n + Math.max(0, Math.floor((w.endMinute - w.startMinute) / slotMinutes)), 0);
}
