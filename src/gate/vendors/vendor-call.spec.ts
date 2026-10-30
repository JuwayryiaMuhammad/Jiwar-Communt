import { AppException } from '../../core/common/errors';
import { callVendor, DriverError } from './vendor-call';

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as AppException;
  }
  throw new Error('expected a failure');
}

describe('callVendor', () => {
  it('answers what the driver answered', async () => {
    await expect(
      callVendor('face', 1000, () => Promise.resolve(42)),
    ).resolves.toBe(42);
  });

  it.each(['timeout', 'unavailable', 'rejected', 'bad_response'] as const)(
    'a driver %s is 503 VENDOR_UNAVAILABLE {service}, nothing of the vendor’s',
    async (kind) => {
      const e = await failure(
        callVendor('id_scan', 1000, () =>
          Promise.reject(new DriverError(kind)),
        ),
      );
      expect(e).toBeInstanceOf(AppException);
      expect(e.getStatus()).toBe(503);
      expect(e.getResponse()).toMatchObject({
        code: 'VENDOR_UNAVAILABLE',
        params: { service: 'id_scan' },
      });
      expect((e.getResponse() as { params: unknown }).params).toEqual({
        service: 'id_scan',
      });
    },
  );

  it('an off driver says so', async () => {
    const e = await failure(
      callVendor('call', 1000, () => Promise.reject(new DriverError('off'))),
    );
    expect(e.getResponse()).toMatchObject({
      params: { service: 'call', reason: 'off' },
    });
  });

  it('a call that outlasts the timeout is aborted and unavailable', async () => {
    let aborted = false;
    const e = await failure(
      callVendor(
        'alarm',
        20,
        (signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve('late');
            });
          }),
      ),
    );
    expect(e.getStatus()).toBe(503);
    expect(aborted).toBe(true);
  });

  it('anything but a driver error is not the vendor’s: it passes through', async () => {
    const bug = new TypeError('a bug');
    await expect(
      callVendor('face', 1000, () => Promise.reject(bug)),
    ).rejects.toBe(bug);
  });
});
