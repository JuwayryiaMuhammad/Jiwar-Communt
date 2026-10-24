/** The CHECK partner_settings_ranges, and the defaults of its columns. */
export const SETTING_RANGES = {
  newDays: { min: 1, max: 90, default: 30 },
  lateFromMinute: { min: 960, max: 1439, default: 1320 },
  maxLiveRequests: { min: 1, max: 20, default: 5 },
  ratingDays: { min: 1, max: 60, default: 14 },
  complaintDays: { min: 1, max: 60, default: 14 },
  deskLinkDays: { min: 7, max: 365, default: 90 },
} as const;
export type PartnerSettingName = keyof typeof SETTING_RANGES;
