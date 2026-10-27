/**
 * What a new compound's asset types are (ADR 0064); the migration gave
 * existing compounds the same (a unit test keeps the two in step). Each
 * joins its category by key; the expected life is in years.
 */
export const DEFAULT_ASSET_TYPES: readonly {
  key: string;
  nameAr: string;
  nameEn: string;
  categoryKey: string;
  lifeYears: number;
}[] = [
  {
    key: 'hvac',
    nameAr: 'وحدة تكييف مركزي',
    nameEn: 'HVAC unit',
    categoryKey: 'ac',
    lifeYears: 15,
  },
  {
    key: 'pump',
    nameAr: 'مضخة',
    nameEn: 'Pump',
    categoryKey: 'plumbing',
    lifeYears: 10,
  },
  {
    key: 'water_tank',
    nameAr: 'خزان مياه',
    nameEn: 'Water tank',
    categoryKey: 'plumbing',
    lifeYears: 20,
  },
  {
    key: 'irrigation',
    nameAr: 'نظام ري',
    nameEn: 'Irrigation system',
    categoryKey: 'plumbing',
    lifeYears: 10,
  },
  {
    key: 'pool_equipment',
    nameAr: 'معدات حمام السباحة',
    nameEn: 'Pool equipment',
    categoryKey: 'plumbing',
    lifeYears: 10,
  },
  {
    key: 'generator',
    nameAr: 'مولد كهرباء',
    nameEn: 'Generator',
    categoryKey: 'electrical',
    lifeYears: 20,
  },
  {
    key: 'electrical_panel',
    nameAr: 'لوحة كهرباء',
    nameEn: 'Electrical panel',
    categoryKey: 'electrical',
    lifeYears: 25,
  },
  {
    key: 'lighting',
    nameAr: 'إنارة',
    nameEn: 'Lighting',
    categoryKey: 'electrical',
    lifeYears: 10,
  },
  {
    key: 'elevator',
    nameAr: 'مصعد',
    nameEn: 'Elevator',
    categoryKey: 'general',
    lifeYears: 25,
  },
  {
    key: 'fire_system',
    nameAr: 'نظام إطفاء الحريق',
    nameEn: 'Fire system',
    categoryKey: 'general',
    lifeYears: 15,
  },
  {
    key: 'gate_barrier',
    nameAr: 'حاجز البوابة',
    nameEn: 'Gate barrier',
    categoryKey: 'general',
    lifeYears: 10,
  },
  {
    key: 'meter',
    nameAr: 'عداد',
    nameEn: 'Meter',
    categoryKey: 'general',
    lifeYears: 15,
  },
];
