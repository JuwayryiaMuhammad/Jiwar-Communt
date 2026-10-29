/** What a meter measures (ADR 0066); the migration's CHECK repeats them. */
export const METER_KINDS = [
  'electricity',
  'water',
  'gas',
  'fuel',
  'run_hours',
] as const;
export type MeterKind = (typeof METER_KINDS)[number];

/** The unit each kind is read in. */
export const METER_UNITS: Record<MeterKind, string> = {
  electricity: 'kWh',
  water: 'm³',
  gas: 'm³',
  fuel: 'L',
  run_hours: 'h',
};

/**
 * `cumulative`: a register that only climbs, read as it stands;
 * `interval`: what was used since the last reading.
 */
export const METER_MODES = ['cumulative', 'interval'] as const;
export type MeterMode = (typeof METER_MODES)[number];

/** A meter's code, like the asset register's and the store's. */
export const METER_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** What one step of the register is worth: four decimals, more than 0. */
export const MULTIPLIER = /^\d{1,5}(\.\d{1,4})?$/;
export const METER_SERIAL = { min: 1, max: 60 } as const;
