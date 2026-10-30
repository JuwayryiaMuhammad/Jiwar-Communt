import { ConfigService } from '@nestjs/config';
import { FakeIdScanDriver, SAMPLE_READING } from './fake-id-scan-driver';
import { ID_SCAN_DRIVER, OffIdScanDriver } from './id-scan-driver';
import { idScanDriverProvider } from './id-scan-driver.provider';

const input = {
  tenantId: 't',
  image: { bytes: Buffer.alloc(4), contentType: 'image/png' },
};
const signal = () => new AbortController().signal;

describe('FakeIdScanDriver', () => {
  it('reads the sample card, or what was scripted, in order', async () => {
    const d = new FakeIdScanDriver();
    const other = { ...SAMPLE_READING, number: 'P123' };
    d.script(other);
    expect(await d.read(input, signal())).toEqual(other);
    expect(await d.read(input, signal())).toEqual(SAMPLE_READING);
    expect(d.calls).toBe(2);
  });

  it('fails as scripted; an aborted read times out', async () => {
    const d = new FakeIdScanDriver();
    d.failNext('bad_response');
    await expect(d.read(input, signal())).rejects.toMatchObject({
      kind: 'bad_response',
    });
    const c = new AbortController();
    c.abort();
    await expect(d.read(input, c.signal)).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});

describe('idScanDriverProvider', () => {
  const build = (env: Record<string, string | undefined>) =>
    (
      idScanDriverProvider as { useFactory: (c: ConfigService) => unknown }
    ).useFactory({ get: (k: string) => env[k] } as unknown as ConfigService);

  it('runs the fake or off, as the deployment chose; off is off', async () => {
    expect((idScanDriverProvider as { provide: symbol }).provide).toBe(
      ID_SCAN_DRIVER,
    );
    expect(build({ NODE_ENV: 'test' })).toBeInstanceOf(FakeIdScanDriver);
    expect(build({ NODE_ENV: 'production' })).toBeInstanceOf(OffIdScanDriver);
    await expect(new OffIdScanDriver().read()).rejects.toMatchObject({
      kind: 'off',
    });
  });
});
