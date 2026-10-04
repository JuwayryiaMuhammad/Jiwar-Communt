export interface DefaultSpecialty {
  key: string;
  nameAr: string;
  nameEn: string;
}

/**
 * The specialties a new compound starts with (ADR 0033). Like the
 * categories, they are the compound's own data from then on.
 *
 * The migration 20261008090000_dispatch_engine backfills existing
 * compounds with the same list; a unit test keeps the two in step.
 */
export const DEFAULT_SPECIALTIES: readonly DefaultSpecialty[] = [
  { key: 'plumbing', nameAr: 'سباكة', nameEn: 'Plumbing' },
  { key: 'electrical', nameAr: 'كهرباء', nameEn: 'Electrical' },
  { key: 'ac', nameAr: 'تكييف', nameEn: 'Air conditioning' },
  { key: 'carpentry', nameAr: 'نجارة', nameEn: 'Carpentry' },
  { key: 'general', nameAr: 'أعمال عامة', nameEn: 'General' },
];

/**
 * Each default category is handled by its namesake specialty. A category
 * with no specialty at all can go to any technician; these have one, so a
 * technician is only offered the work their dispatcher said they can do.
 */
export const DEFAULT_CATEGORY_SPECIALTIES: readonly {
  categoryKey: string;
  specialtyKey: string;
}[] = DEFAULT_SPECIALTIES.map((s) => ({
  categoryKey: s.key,
  specialtyKey: s.key,
}));
