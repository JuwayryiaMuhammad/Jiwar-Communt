import { ConfigService } from '@nestjs/config';
import { ALARM_DRIVER, OffAlarmDriver } from './alarm-driver';
import { alarmDriverProvider } from './alarm-driver.provider';
import {
  FAKE_ALARM_SIGNATURE_HEADER,
  FakeAlarmDriver,
  signFakeAlarm,
} from './fake-alarm-driver';

const body = {
  eventId: 'e1',
  deviceRef: 'd1',
  kind: 'panic',
  at: '2027-01-05T10:00:00+02:00',
};
const signed = (b: unknown, signature = signFakeAlarm(b)) => ({
  [FAKE_ALARM_SIGNATURE_HEADER]: signature,
});

/** What `f` throws (it must throw). */
function thrown(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

describe('FakeAlarmDriver', () => {
  const d = new FakeAlarmDriver();

  it('reads a call it signed', () => {
    expect(d.parseEvent(signed(body), body)).toEqual({
      eventId: 'e1',
      deviceRef: 'd1',
      kind: 'panic',
      at: new Date('2027-01-05T08:00:00Z'),
    });
  });

  it.each([
    ['no signature', {}, body],
    ['another body’s signature', signed({ ...body, kind: 'fall' }), body],
    ['a malformed signature', signed(body, 'zz'), body],
  ])('refuses %s', (_, headers, b) => {
    expect(thrown(() => d.parseEvent(headers, b))).toMatchObject({
      kind: 'rejected',
    });
  });

  it.each([
    ['an unknown kind', { ...body, kind: 'sneeze' }],
    ['an instant without an offset', { ...body, at: '2027-01-05T10:00:00' }],
    ['no event id', { ...body, eventId: 7 }],
    ['not an object', null],
  ])('refuses a signed body with %s', (_, b) => {
    expect(thrown(() => d.parseEvent(signed(b), b))).toMatchObject({
      kind: 'rejected',
    });
  });
});

describe('alarmDriverProvider', () => {
  const build = (env: Record<string, string | undefined>) =>
    (
      alarmDriverProvider as { useFactory: (c: ConfigService) => unknown }
    ).useFactory({ get: (k: string) => env[k] } as unknown as ConfigService);

  it('runs the fake or off', () => {
    expect((alarmDriverProvider as { provide: symbol }).provide).toBe(
      ALARM_DRIVER,
    );
    expect(build({ NODE_ENV: 'test' })).toBeInstanceOf(FakeAlarmDriver);
    expect(build({ NODE_ENV: 'production' })).toBeInstanceOf(OffAlarmDriver);
    expect(thrown(() => new OffAlarmDriver().parseEvent())).toMatchObject({
      kind: 'off',
    });
  });
});
