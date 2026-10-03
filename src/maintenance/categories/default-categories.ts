import type { TicketPriority } from '@prisma/client';

export interface DefaultCategory {
  key: string;
  nameAr: string;
  nameEn: string;
  defaultPriority: TicketPriority;
  commonAreaAllowed: boolean;
}

/**
 * The categories a new compound starts with (ADR 0032). They are the
 * compound's own data from then on: the manager renames, retires or adds.
 * Every one may be used for a common area (a leak in a corridor is
 * plumbing); the manager turns that off per category.
 *
 * The migration 20261007090100_maintenance backfills existing compounds
 * with the same list; a unit test keeps the two in step.
 */
export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  {
    key: 'plumbing',
    nameAr: 'سباكة',
    nameEn: 'Plumbing',
    defaultPriority: 'normal',
    commonAreaAllowed: true,
  },
  {
    key: 'electrical',
    nameAr: 'كهرباء',
    nameEn: 'Electrical',
    defaultPriority: 'normal',
    commonAreaAllowed: true,
  },
  {
    key: 'ac',
    nameAr: 'تكييف',
    nameEn: 'Air conditioning',
    defaultPriority: 'normal',
    commonAreaAllowed: true,
  },
  {
    key: 'carpentry',
    nameAr: 'نجارة',
    nameEn: 'Carpentry',
    defaultPriority: 'normal',
    commonAreaAllowed: true,
  },
  {
    key: 'general',
    nameAr: 'أعمال عامة',
    nameEn: 'General',
    defaultPriority: 'normal',
    commonAreaAllowed: true,
  },
];
