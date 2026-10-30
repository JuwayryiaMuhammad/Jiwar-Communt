/**
 * The guard vendor adapters (ADR 0068) and the env variable choosing each
 * one's driver. `fake` is a scriptable driver in the code, for development
 * and tests; `off` answers every call as unavailable. A real vendor's
 * driver is added with its contract.
 */
export const VENDOR_DRIVER_CHOICES = ['fake', 'off'] as const;
export type VendorDriverChoice = (typeof VENDOR_DRIVER_CHOICES)[number];

export const VENDOR_DRIVER_VARS = {
  face: 'GATE_FACE_DRIVER',
  id_scan: 'GATE_ID_SCAN_DRIVER',
  call: 'GATE_CALL_DRIVER',
  alarm: 'GATE_ALARM_DRIVER',
  control_room: 'CONTROL_ROOM_DRIVER',
} as const;
export type VendorService = keyof typeof VENDOR_DRIVER_VARS;

type VendorEnv = { NODE_ENV: 'development' | 'test' | 'production' } & {
  [K in (typeof VENDOR_DRIVER_VARS)[VendorService]]?: VendorDriverChoice;
};

/**
 * The driver a service runs: as set, or — unset — the fake outside
 * production and off in production. The env schema refuses `fake` in
 * production, so a fake never runs where real residents are.
 */
export function vendorDriver(
  env: VendorEnv,
  service: VendorService,
): VendorDriverChoice {
  return (
    env[VENDOR_DRIVER_VARS[service]] ??
    (env.NODE_ENV === 'production' ? 'off' : 'fake')
  );
}
