export interface DefaultSuggestionTopic {
  key: string;
  nameAr: string;
  nameEn: string;
}

/**
 * The suggestion topics a new compound starts with (ADR 0040). They are
 * the compound's own data from then on: the staff rename, retire or add.
 *
 * The migration 20261019090200_engagement_setup backfills existing
 * compounds with the same list; a unit test keeps the two in step.
 */
export const DEFAULT_SUGGESTION_TOPICS: readonly DefaultSuggestionTopic[] = [
  { key: 'general', nameAr: 'عام', nameEn: 'General' },
  { key: 'facilities', nameAr: 'المرافق', nameEn: 'Facilities' },
  { key: 'security', nameAr: 'الأمن', nameEn: 'Security' },
  {
    key: 'cleanliness_landscaping',
    nameAr: 'النظافة والمساحات الخضراء',
    nameEn: 'Cleanliness and landscaping',
  },
  {
    key: 'events_activities',
    nameAr: 'الفعاليات والأنشطة',
    nameEn: 'Events and activities',
  },
  { key: 'services', nameAr: 'الخدمات', nameEn: 'Services' },
];
