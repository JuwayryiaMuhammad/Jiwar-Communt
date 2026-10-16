/**
 * The guards' duty pages (ADR 0050): plain helpers, no imports, so the
 * tests run them as they are.
 */

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** A gate's name or a zone's English name. */
export function postName(post: { gateName?: string | null; zone?: { nameEn: string } | null } | null | undefined): string {
  if (!post) return '—';
  return post.gateName ?? post.zone?.nameEn ?? '—';
}

/** A person as an AccountRefView carries them. */
export function personName(ref: { fullName?: string | null; erased?: boolean } | null | undefined): string {
  if (!ref) return '—';
  if (ref.erased) return 'An erased account';
  return ref.fullName ?? '—';
}

/** "Sun, Thu 22:00–06:00 (overnight)". */
export function scheduleText(s: { days: number[]; windows: { from: string; to: string }[] }): string {
  const days = [...s.days].sort((a, b) => a - b).map((d) => WEEKDAYS[d] ?? '?').join(', ');
  const windows = s.windows.map((w) => `${w.from}–${w.to}${w.to <= w.from ? ' (overnight)' : ''}`).join(', ');
  return `${days} ${windows}`.trim();
}

/** "1 h 30 min", "45 min", "0 min". */
export function minutesText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** A local `YYYY-MM-DD` moved by `n` days. */
export function addDays(date: string, n: number): string {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Today in the browser's time zone, `YYYY-MM-DD`. */
export function today(): string {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * A weekly schedule from the form: the ticked weekdays and one window.
 * Null when it is not one yet (no day, or a time missing or equal).
 */
export function scheduleFrom(days: readonly number[], from: string, to: string): { days: number[]; windows: { from: string; to: string }[] } | null {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!days.length || !time.test(from) || !time.test(to) || from === to) return null;
  return { days: [...new Set(days)].sort((a, b) => a - b), windows: [{ from, to }] };
}

/** `datetime-local` value plus minutes, as an ISO instant (the API's shape). */
export function instantOf(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** A post the forms send: a gate or a zone, by the picker's value. */
export function postBody(value: string): { gateId: string } | { zoneId: string } | null {
  const [type, id] = value.split(':');
  if (!id) return null;
  return type === 'gate' ? { gateId: id } : type === 'zone' ? { zoneId: id } : null;
}
