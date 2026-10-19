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
  /**
   * Minutes a visit is expected to last when its pass gives none; null
   * turns the overstay alert off. At most 12 hours: a visitor inside
   * longer gets the system's unconfirmed exit.
   */
  visitExpectedMinutes: { min: 15, max: 720, default: 240, nullable: true },
} as const;

type Limits = typeof GATE_SETTING_LIMITS;
export type GateSettingName = keyof Limits;

/** The values as the management reads and sets them: null where allowed. */
export type GateSettingsValues = {
  [K in GateSettingName]: Limits[K] extends { nullable: true }
    ? number | null
    : number;
};

export const GATE_SETTING_NAMES = Object.keys(
  GATE_SETTING_LIMITS,
) as GateSettingName[];
