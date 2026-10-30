import { vendorDriver, VENDOR_DRIVER_VARS } from './vendor-drivers';

describe('vendorDriver', () => {
  const services = Object.keys(
    VENDOR_DRIVER_VARS,
  ) as (keyof typeof VENDOR_DRIVER_VARS)[];

  it.each(services)('%s: unset is the fake outside production', (service) => {
    expect(vendorDriver({ NODE_ENV: 'development' }, service)).toBe('fake');
    expect(vendorDriver({ NODE_ENV: 'test' }, service)).toBe('fake');
  });

  it.each(services)('%s: unset is off in production', (service) => {
    expect(vendorDriver({ NODE_ENV: 'production' }, service)).toBe('off');
  });

  it.each(services)('%s: as set, by its own variable only', (service) => {
    const env = {
      NODE_ENV: 'development' as const,
      [VENDOR_DRIVER_VARS[service]]: 'off' as const,
    };
    expect(vendorDriver(env, service)).toBe('off');
    for (const other of services.filter((s) => s !== service))
      expect(vendorDriver(env, other)).toBe('fake');
  });
});
