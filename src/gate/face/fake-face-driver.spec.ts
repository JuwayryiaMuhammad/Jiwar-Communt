import { ConfigService } from '@nestjs/config';
import { FACE_DRIVER, OffFaceDriver } from './face-driver';
import { faceDriverProvider } from './face-driver.provider';
import { FakeFaceDriver } from './fake-face-driver';

const image = (n: number) => ({
  bytes: Buffer.alloc(16, n),
  contentType: 'image/png',
});
const signal = () => new AbortController().signal;

describe('FakeFaceDriver', () => {
  it('enrols idempotently by the enrolment, matches the same face in the same compound only', async () => {
    const d = new FakeFaceDriver();
    const one = await d.enroll(
      { tenantId: 't1', enrollmentId: 'e1', image: image(1) },
      signal(),
    );
    expect(
      await d.enroll(
        { tenantId: 't1', enrollmentId: 'e1', image: image(1) },
        signal(),
      ),
    ).toEqual(one);
    await d.enroll(
      { tenantId: 't2', enrollmentId: 'e2', image: image(1) },
      signal(),
    );
    expect(
      await d.search({ tenantId: 't1', image: image(1) }, signal()),
    ).toEqual({ templateRefs: [one.templateRef] });
    expect(
      await d.search({ tenantId: 't1', image: image(2) }, signal()),
    ).toEqual({ templateRefs: [] });
    await d.remove({ tenantId: 't1', enrollmentId: 'e1' }, signal());
    expect(d.templates('t1')).toEqual([]);
    expect(d.templates('t2')).toHaveLength(1);
    expect(d.calls.map((c) => c.op)).toEqual([
      'enroll',
      'enroll',
      'enroll',
      'search',
      'search',
      'remove',
    ]);
  });

  it('fails the next call as scripted, and holds one until released', async () => {
    const d = new FakeFaceDriver();
    d.failNext('rejected');
    await expect(
      d.search({ tenantId: 't', image: image(1) }, signal()),
    ).rejects.toMatchObject({ kind: 'rejected' });
    d.hold();
    let done = false;
    const held = d
      .search({ tenantId: 't', image: image(1) }, signal())
      .then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    d.release();
    await held;
    expect(done).toBe(true);
  });

  it('an aborted call times out', async () => {
    const d = new FakeFaceDriver();
    const c = new AbortController();
    c.abort();
    await expect(
      d.search({ tenantId: 't', image: image(1) }, c.signal),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('faceDriverProvider', () => {
  const build = (env: Record<string, string | undefined>) =>
    (
      faceDriverProvider as {
        useFactory: (c: ConfigService) => unknown;
        provide: symbol;
      }
    ).useFactory({ get: (k: string) => env[k] } as unknown as ConfigService);

  it('runs the fake or off, as the deployment chose', () => {
    expect((faceDriverProvider as { provide: symbol }).provide).toBe(
      FACE_DRIVER,
    );
    expect(build({ NODE_ENV: 'test' })).toBeInstanceOf(FakeFaceDriver);
    expect(
      build({ NODE_ENV: 'development', GATE_FACE_DRIVER: 'off' }),
    ).toBeInstanceOf(OffFaceDriver);
    expect(build({ NODE_ENV: 'production' })).toBeInstanceOf(OffFaceDriver);
  });

  it('off answers every call as off', async () => {
    const d = new OffFaceDriver();
    await expect(d.search()).rejects.toMatchObject({ kind: 'off' });
    await expect(d.enroll()).rejects.toMatchObject({ kind: 'off' });
    await expect(d.remove()).rejects.toMatchObject({ kind: 'off' });
  });
});
