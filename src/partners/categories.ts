/**
 * The categories of service a partner gives (ADR 0060): a closed list in
 * code, never per compound. Each has its own consent (ADR 0036), so a
 * resident says yes per category to what one request shows a partner. The
 * compound names sub-categories under them (`partner_subcategories`). The
 * database repeats the list as CHECKs (`partner_subcategories_category`,
 * `partner_services_category`); a unit test keeps them in step.
 */
export const PARTNER_CATEGORIES = [
  // Gas and water cylinders.
  'gas_water',
  // The pharmacy, open late or not.
  'pharmacy',
  // Groceries delivered.
  'grocery',
  // Cleaning, pest control, air conditioning.
  'home_services',
  // Laundry and carpets.
  'laundry',
  'gardening',
  // A barber or a salon at home.
  'beauty_at_home',
  // Appliances and phones.
  'repair',
  'pets',
  // Setting up for an event.
  'events',
  'moving_storage',
  'car_services',
  'elderly_care',
] as const;
export type PartnerCategory = (typeof PARTNER_CATEGORIES)[number];

export function isPartnerCategory(value: string): value is PartnerCategory {
  return (PARTNER_CATEGORIES as readonly string[]).includes(value);
}
