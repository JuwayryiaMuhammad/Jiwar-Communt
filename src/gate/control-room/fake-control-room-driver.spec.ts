import { ConfigService } from '@nestjs/config';
import {
  CONTROL_ROOM_DRIVER,
  OffControlRoomDriver,
} from './control-room-driver';
import { controlRoomDriverProvider } from './control-room-driver.provider';
import { FakeControlRoomDriver } from './fake-control-room-driver';

const event = (eventId: string) => ({
  eventId,
  kind: 'lockdown_started',
  severity: 'high' as const,
  sourceType: 'lockdown',
  sourceId: 's',
  gateId: null,
  placeId: null,
  occurredAt: new Date(0),
});
const signal = () => new AbortController().signal;

describe('FakeControlRoomDriver', () => {
  it('keeps what it received by event id, and how many times', async () => {
    const d = new FakeControlRoomDriver();
    await d.deliver({ tenantId: 't', event: event('e1') }, signal());
    await d.deliver({ tenantId: 't', event: event('e1') }, signal());
    expect(d.received.get('e1')?.times).toBe(2);
    d.failNext('rejected');
    await expect(
      d.deliver({ tenantId: 't', event: event('e2') }, signal()),
    ).rejects.toMatchObject({ kind: 'rejected' });
    expect(d.received.has('e2')).toBe(false);
  });
});

describe('controlRoomDriverProvider', () => {
  const build = (env: Record<string, string | undefined>) =>
    (
      controlRoomDriverProvider as {
        useFactory: (c: ConfigService) => unknown;
      }
    ).useFactory({ get: (k: string) => env[k] } as unknown as ConfigService);

  it('runs the fake or off; off delivers nothing', async () => {
    expect((controlRoomDriverProvider as { provide: symbol }).provide).toBe(
      CONTROL_ROOM_DRIVER,
    );
    expect(build({ NODE_ENV: 'test' })).toBeInstanceOf(FakeControlRoomDriver);
    expect(
      build({ NODE_ENV: 'test', CONTROL_ROOM_DRIVER: 'off' }),
    ).toBeInstanceOf(OffControlRoomDriver);
    await expect(new OffControlRoomDriver().deliver()).rejects.toMatchObject({
      kind: 'off',
    });
  });
});
