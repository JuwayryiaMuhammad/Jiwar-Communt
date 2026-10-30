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
  /** Minutes outside a patrol route's geofence that flag the exit. */
  geofenceExitMinutes: { min: 1, max: 60, default: 3 },
  /**
   * Recordings a patrol note or an incident takes (ADR 0056), under the
   * system's caps: seconds, and megabytes (the uploads' caps are 20 and
   * 100).
   */
  audioMaxSeconds: { min: 10, max: 600, default: 300 },
  videoMaxSeconds: { min: 10, max: 300, default: 120 },
  audioMaxMb: { min: 1, max: 20, default: 20 },
  videoMaxMb: { min: 1, max: 100, default: 100 },
  /**
   * Minutes a guard device on an open shift may go without calling before
   * the management is told (ADR 0057), once per outage.
   */
  offlineSyncAlertMinutes: { min: 5, max: 240, default: 15 },
} as const;

/** The gate's switches, each with its default. */
export const GATE_SETTING_FLAGS = {
  /**
   * Face checks against the blocklist's faces (ADR 0068): off until the
   * management turns them on, having posted a visible notice at the gate.
   */
  faceChecks: { default: false },
} as const;

type Limits = typeof GATE_SETTING_LIMITS;
export type GateSettingName = keyof Limits | keyof typeof GATE_SETTING_FLAGS;

/** The values as the management reads and sets them: null where allowed. */
export type GateSettingsValues = {
  [K in keyof Limits]: Limits[K] extends { nullable: true }
    ? number | null
    : number;
} & { [K in keyof typeof GATE_SETTING_FLAGS]: boolean };

export const GATE_SETTING_NAMES = [
  ...Object.keys(GATE_SETTING_LIMITS),
  ...Object.keys(GATE_SETTING_FLAGS),
] as GateSettingName[];
