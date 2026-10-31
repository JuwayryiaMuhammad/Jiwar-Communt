/** The CHECK facility_settings_ranges, and the defaults of its columns. */
export const SETTING_RANGES = {
  noShowThreshold: { min: 1, max: 10, default: 3 },
  noShowWindowDays: { min: 7, max: 90, default: 30 },
  suspensionDays: { min: 1, max: 90, default: 14 },
  /** ADR 0070: how long a waitlist offer holds its place. */
  waitlistHoldMinutes: { min: 5, max: 120, default: 30 },
} as const;
export type FacilitySettingName = keyof typeof SETTING_RANGES;
