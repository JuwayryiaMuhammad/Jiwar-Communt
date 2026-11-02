// The reports platform's words (ADR 0086): pure, tested with the rest.

export const COMPARE_TEXT: Record<string, string> = {
  none: 'No comparison',
  previous: 'The period before',
  last_year: 'A year earlier',
  both: 'Both',
};

export const CADENCE_TEXT: Record<string, string> = {
  daily: 'Daily (the day before)',
  weekly: 'Weekly (Saturday to Friday)',
  monthly: 'Monthly (the month before)',
};

export const FORMAT_TEXT: Record<string, string> = { pdf: 'PDF', xlsx: 'Excel workbook', csv: 'CSV' };

/** Why a figure is missing, as the energy report says. */
export const NOTE_TEXT: Record<string, string> = {
  no_tariff: 'No tariff in force',
  no_area: 'A unit has no recorded area',
};

export const PLAN_STATUS_TEXT: Record<string, string> = {
  draft: 'Draft',
  submitted: 'With the board',
  approved: 'Approved (locked)',
};

export const GROUP_TEXT: Record<string, string> = {
  building: 'Building',
  asset_type: 'Asset type',
  category: 'Category',
  month: 'Month',
  item: 'Item',
};

/** A change in percent, from two decimal strings; null with no base. */
export function change(now: string | null, before: string | null): string | null {
  if (now === null || before === null) return null;
  const b = Number(before);
  if (!b) return null;
  return `${(((Number(now) - b) / Math.abs(b)) * 100).toFixed(1)}%`;
}
