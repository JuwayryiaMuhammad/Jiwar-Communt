/** Minutes as a person reads them: `90` → `1 h 30 min`, `10080` → `7 d`. */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = Math.round(minutes % 60);
  return [d ? `${d} d` : '', h ? `${h} h` : '', m || (!d && !h) ? `${m} min` : ''].filter(Boolean).join(' ');
}

/** Minutes after midnight as a clock time; 1440 is the end of the day. */
export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** A stable code from a name: `Water heater` → `water_heater` (the API's key pattern). */
export function suggestKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 40);
}

export const KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
