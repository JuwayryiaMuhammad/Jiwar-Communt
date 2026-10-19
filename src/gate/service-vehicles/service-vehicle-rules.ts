/** What a service vehicle is (ADR 0056): a closed list. */
export const SERVICE_VEHICLE_KINDS = [
  'tanker',
  'waste',
  'delivery',
  'other',
] as const;
export type ServiceVehicleKind = (typeof SERVICE_VEHICLE_KINDS)[number];

/** The company's name, as the driver gives it: at most this long. */
export const COMPANY_MAX = 120;
