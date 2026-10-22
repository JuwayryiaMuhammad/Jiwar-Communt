import type { PartnerCategory } from '../categories';

export interface DefaultSubcategory {
  category: PartnerCategory;
  key: string;
  nameEn: string;
  nameAr: string;
  position: number;
}

const sub = (
  category: PartnerCategory,
  key: string,
  nameEn: string,
  nameAr: string,
  position: number,
): DefaultSubcategory => ({ category, key, nameEn, nameAr, position });

/**
 * The named sub-categories a new compound starts with (ADR 0060). They are
 * the compound's own data from then on: the manager renames, retires or
 * adds; a key and its category never change.
 *
 * The migration 20261112090100_partners_catalogue backfills existing
 * compounds with the same list; a unit test keeps the two in step.
 */
export const DEFAULT_SUBCATEGORIES: readonly DefaultSubcategory[] = [
  sub('gas_water', 'gas_cylinders', 'Gas cylinders', 'أنابيب البوتاجاز', 0),
  sub('gas_water', 'drinking_water', 'Drinking water', 'مياه الشرب', 1),
  sub('pharmacy', 'medicines', 'Medicines', 'أدوية', 0),
  sub('grocery', 'groceries', 'Groceries', 'بقالة', 0),
  sub('grocery', 'fruit_vegetables', 'Fruit and vegetables', 'خضار وفاكهة', 1),
  sub('home_services', 'cleaning', 'Cleaning', 'تنظيف', 0),
  sub('home_services', 'pest_control', 'Pest control', 'مكافحة الحشرات', 1),
  sub('home_services', 'air_conditioning', 'Air conditioning', 'تكييف', 2),
  sub('laundry', 'laundry', 'Laundry', 'مغسلة', 0),
  sub('laundry', 'carpets', 'Carpets', 'سجاد', 1),
  sub('gardening', 'gardening', 'Gardening', 'تنسيق حدائق', 0),
  sub('beauty_at_home', 'barber', 'Barber', 'حلاق', 0),
  sub('beauty_at_home', 'salon', 'Salon', 'صالون تجميل', 1),
  sub('repair', 'appliances', 'Appliances', 'أجهزة منزلية', 0),
  sub('repair', 'phones', 'Phones', 'هواتف', 1),
  sub('pets', 'pet_grooming', 'Grooming', 'العناية بالحيوانات', 0),
  sub('pets', 'vet_visits', 'Vet visits', 'طبيب بيطري', 1),
  sub('events', 'event_setup', 'Event setup', 'تجهيز المناسبات', 0),
  sub('moving_storage', 'moving', 'Moving', 'نقل أثاث', 0),
  sub('moving_storage', 'storage', 'Storage', 'تخزين', 1),
  sub('car_services', 'car_wash', 'Car wash', 'غسيل سيارات', 0),
  sub('car_services', 'car_maintenance', 'Car maintenance', 'صيانة سيارات', 1),
  sub('elderly_care', 'home_care', 'Home care', 'رعاية منزلية', 0),
  sub('elderly_care', 'nursing', 'Nursing', 'تمريض', 1),
];

/**
 * How an announced price is counted (`partner_price_items_unit`).
 * `visit_fee` is what coming to the home costs: the paid home service.
 */
export const PARTNER_PRICE_UNITS = [
  'fixed',
  'per_visit',
  'visit_fee',
  'per_hour',
  'per_item',
  'per_kg',
  'per_sqm',
] as const;
export type PartnerPriceUnit = (typeof PARTNER_PRICE_UNITS)[number];
