export interface DefaultTopic {
  key: string;
  nameAr: string;
  nameEn: string;
  targetResponseHours: number;
}

/**
 * The topics a new compound starts with (ADR 0039). They are the compound's
 * own data from then on: the manager renames, retires or adds, and sets
 * each one's response target.
 *
 * The migration 20261017090100_management_requests backfills existing
 * compounds with the same list; a unit test keeps the two in step.
 */
export const DEFAULT_TOPICS: readonly DefaultTopic[] = [
  { key: 'general', nameAr: 'عام', nameEn: 'General', targetResponseHours: 48 },
  {
    key: 'billing_fees',
    nameAr: 'الفواتير والرسوم',
    nameEn: 'Billing and fees',
    targetResponseHours: 48,
  },
  {
    key: 'security_gate',
    nameAr: 'الأمن والبوابة',
    nameEn: 'Security and gate',
    targetResponseHours: 24,
  },
  {
    key: 'facilities',
    nameAr: 'المرافق',
    nameEn: 'Facilities',
    targetResponseHours: 72,
  },
  {
    key: 'documents',
    nameAr: 'المستندات',
    nameEn: 'Documents',
    targetResponseHours: 72,
  },
];

export interface OfficeWindow {
  /** 0 is Sunday. */
  weekday: number;
  /** Minutes after local midnight, in the compound's time zone. */
  startMinute: number;
  endMinute: number;
}

/**
 * The office hours a new compound starts with (ADR 0039): Saturday to
 * Thursday, 09:00 to 17:00; Friday off. The same migration backfills them.
 */
export const DEFAULT_OFFICE_HOURS: readonly OfficeWindow[] = [
  0, 1, 2, 3, 4, 6,
].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));
