// The reports platform's choices (ADR 0086): pure, tested with the rest. Their
// words are in messages/{en,ar}/ops-reports.ts, keyed by these values.

export const COMPARES = ['none', 'previous', 'last_year', 'both'] as const;
export const CADENCES = ['daily', 'weekly', 'monthly'] as const;
export const FORMATS = ['pdf', 'xlsx', 'csv'] as const;
/** Why a figure is missing, as the energy report says. */
export const NOTES = ['no_tariff', 'no_area'] as const;
export const GROUPS = ['building', 'asset_type', 'category', 'month', 'item', 'order', 'vendor', 'invoice', 'issue'] as const;

export const isNote = (v: string): v is (typeof NOTES)[number] => (NOTES as readonly string[]).includes(v);
export const isGroup = (v: string): v is (typeof GROUPS)[number] => (GROUPS as readonly string[]).includes(v);

/** A change as a ratio (0.5 is +50%), from two decimal strings; null with no base. */
export function change(now: string | null, before: string | null): number | null {
  if (now === null || before === null) return null;
  const b = Number(before);
  if (!b) return null;
  return (Number(now) - b) / Math.abs(b);
}
