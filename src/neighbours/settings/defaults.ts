export interface DefaultComplaintCategory {
  key: string;
  nameAr: string;
  nameEn: string;
}

/**
 * The complaint categories a new compound starts with (ADR 0042). They are
 * the compound's own data from then on: the manager renames, retires or
 * adds.
 *
 * The migration 20261020090100_neighbours_setup backfills existing
 * compounds with the same list; a unit test keeps the two in step.
 */
export const DEFAULT_COMPLAINT_CATEGORIES: readonly DefaultComplaintCategory[] =
  [
    { key: 'noise', nameAr: 'ضوضاء', nameEn: 'Noise' },
    { key: 'parking', nameAr: 'مواقف السيارات', nameEn: 'Parking' },
    { key: 'pets', nameAr: 'حيوانات أليفة', nameEn: 'Pets' },
    { key: 'garbage', nameAr: 'قمامة', nameEn: 'Garbage' },
    { key: 'smoking', nameAr: 'تدخين', nameEn: 'Smoking' },
    { key: 'damage', nameAr: 'أضرار', nameEn: 'Damage' },
    { key: 'rules', nameAr: 'مخالفة القواعد', nameEn: 'Breaking the rules' },
    { key: 'other', nameAr: 'أخرى', nameEn: 'Other' },
  ];

/** The CHECK neighbour_settings_ranges, and the defaults of its columns. */
export const SETTING_RANGES = {
  maxOpenComplaints: { min: 1, max: 50, default: 5 },
  lostFoundExpiryDays: { min: 1, max: 180, default: 30 },
  lendingExpiryDays: { min: 1, max: 90, default: 14 },
  maxOpenPosts: { min: 1, max: 50, default: 5 },
  maxNewConversationsPerDay: { min: 1, max: 100, default: 10 },
} as const;
export type NeighbourSettingName = keyof typeof SETTING_RANGES;
