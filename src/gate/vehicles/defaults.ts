/** The CHECK vehicle_settings_ranges, and the defaults of its columns. */
export const VEHICLE_SETTING_RANGES = {
  maxVehiclesPerUnit: { min: 1, max: 20, default: 4 },
  visitorParkingMaxHours: { min: 1, max: 24, default: 12 },
  maxActiveVisitorParkingBookings: { min: 1, max: 20, default: 3 },
} as const;
export type VehicleSettingName = keyof typeof VEHICLE_SETTING_RANGES;
