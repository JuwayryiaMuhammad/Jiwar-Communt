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

/**
 * The topic of a request to release a hold (ADR 0058): seeded in every
 * compound (the migration 20261108090300 backfills it), renamed or retired
 * like any other, its key fixed.
 */
export const RELEASE_TOPIC: DefaultTopic = {
  key: 'release_request',
  nameAr: 'طلب رفع تعليق',
  nameEn: 'Release a hold',
  targetResponseHours: 48,
};

/**
 * Topics the system opens requests on, seeded with every compound beside
 * the defaults and never named by a resident: a complaint against a
 * partner is a management request on `partner_service` (ADR 0060). The
 * manager may rename it or set its target; retiring it hides it from the
 * residents' list, and complaints still open on it. The migration
 * 20261112090500_partner_ratings_complaints backfills existing compounds;
 * a unit test keeps the two in step.
 */
export const SYSTEM_TOPICS: readonly DefaultTopic[] = [
  {
    key: 'partner_service',
    nameAr: 'خدمات مقدمي الخدمة',
    nameEn: 'Partner services',
    targetResponseHours: 48,
  },
];

/**
 * Topics about a resident's unit that residents pick (ADR 0063), seeded
 * with every compound beside the defaults: `utilities`, to have the
 * electricity, water and gas switched on when moving in (a move-in's
 * checklist reads a request on it), and `unit_preparation`, to have a
 * closed unit prepared before the owner returns. The migrations
 * 20261120090000_unit_moves and 20261120090300_inspection_requests
 * backfill existing compounds; a unit test keeps them in step.
 */
export const UNIT_TOPICS: readonly DefaultTopic[] = [
  {
    key: 'utilities',
    nameAr: 'المرافق: كهرباء ومياه وغاز',
    nameEn: 'Utilities: electricity, water and gas',
    targetResponseHours: 72,
  },
  {
    key: 'unit_preparation',
    nameAr: 'تجهيز الوحدة قبل العودة',
    nameEn: 'Preparing the unit before I return',
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
