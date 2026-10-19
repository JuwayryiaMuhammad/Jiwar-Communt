/**
 * The gate's settings (ADR 0056), one row per compound: each value with its
 * bounds (the table's CHECKs say the same) and its default. A feature adds
 * its own here with its migration's column.
 */
export const GATE_SETTING_LIMITS = {
  /** Minutes the management has to answer a field exception. */
  exceptionAnswerMinutes: { min: 1, max: 60, default: 10 },
  /** Minutes an approved field exception lets its one entry in. */
  exceptionEntryMinutes: { min: 5, max: 120, default: 15 },
} as const;

export type GateSettingName = keyof typeof GATE_SETTING_LIMITS;

/** The values as the management reads and sets them. */
export type GateSettingsValues = Record<GateSettingName, number>;

export const GATE_SETTING_NAMES = Object.keys(
  GATE_SETTING_LIMITS,
) as GateSettingName[];
