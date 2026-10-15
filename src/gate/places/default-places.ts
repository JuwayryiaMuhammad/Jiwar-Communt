/**
 * The places every compound starts with (ADR 0047): those of the mobile
 * contract, known by `key` so the app can name them in its own words.
 * Existing compounds got the same from the migration (a unit test keeps
 * the two in step). `other` comes last.
 */
export const DEFAULT_PLACES = [
  {
    key: 'main_gate',
    nameAr: 'البوابة الرئيسية',
    nameEn: 'Main gate',
    position: 10,
  },
  {
    key: 'north_gate',
    nameAr: 'البوابة الشمالية',
    nameEn: 'North gate',
    position: 20,
  },
  { key: 'phase_a', nameAr: 'المرحلة أ', nameEn: 'Phase A', position: 30 },
  { key: 'phase_b', nameAr: 'المرحلة ب', nameEn: 'Phase B', position: 40 },
  { key: 'clubhouse', nameAr: 'النادي', nameEn: 'Clubhouse', position: 50 },
  { key: 'parking', nameAr: 'الجراج', nameEn: 'Parking', position: 60 },
  { key: 'other', nameAr: 'مكان آخر', nameEn: 'Other', position: 1000 },
] as const;

export const PLACE_NAME = { min: 1, max: 60 } as const;
export const PLACE_POSITION = { min: 0, max: 1000 } as const;
/** A compound has a handful; the lists are bounded. */
export const MAX_PLACES = 100;
