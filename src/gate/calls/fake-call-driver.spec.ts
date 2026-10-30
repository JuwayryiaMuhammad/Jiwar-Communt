import { ConfigService } from '@nestjs/config';
import { CALL_DRIVER, OffCallDriver } from './call-driver';
import { callDriverProvider } from './call-driver.provider';
import {
  FAKE_CALL_SIGNATURE_HEADER,
  FakeCallDriver,
  signFakeCallEvent,
} from './fake-call-driver';

const signal = () => new AbortController().signal;

/** What `f` throws (it must throw). */
function thrown(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

describe('FakeCallDriver', () => {
  it('opens a room per call, gives tokens while it is open, and closes it', async () => {
    const d = new FakeCallDriver();
    const { roomRef } = await d.openRoom(
      { tenantId: 't', callId: 'c1' },
      signal(),
    );
    const p = { kind: 'guard' as const, ref: 'c1:guard' };
    const one = await d.joinToken(
      { tenantId: 't', roomRef, participant: p },
      signal(),
    );
    const two = await d.joinToken(
      { tenantId: 't', roomRef, participant: p },
      signal(),
    );
    expect(one.token).not.toBe(two.token);
    await d.closeRoom({ tenantId: 't', roomRef }, signal());
    await expect(
      d.joinToken({ tenantId: 't', roomRef, participant: p }, signal()),
    ).rejects.toMatchObject({ kind: 'rejected' });
    expect(d.rooms.get(roomRef)?.joined).toEqual([p, p]);
  });

  it('reads an event it signed; refuses another', () => {
    const d = new FakeCallDriver();
    const body = {
      eventId: 'e1',
      roomRef: 'r1',
      kind: 'room_closed',
      at: '2027-01-05T10:00:00Z',
    };
    expect(
      d.parseEvent(
        { [FAKE_CALL_SIGNATURE_HEADER]: signFakeCallEvent(body) },
        body,
      ),
    ).toMatchObject({ eventId: 'e1', kind: 'room_closed' });
    expect(
      thrown(() =>
        d.parseEvent({ [FAKE_CALL_SIGNATURE_HEADER]: 'a'.repeat(64) }, body),
      ),
    ).toMatchObject({ kind: 'rejected' });
  });
});

describe('callDriverProvider', () => {
  it('runs the fake or off', async () => {
    const build = (env: Record<string, string | undefined>) =>
      (
        callDriverProvider as { useFactory: (c: ConfigService) => unknown }
      ).useFactory({ get: (k: string) => env[k] } as unknown as ConfigService);
    expect((callDriverProvider as { provide: symbol }).provide).toBe(
      CALL_DRIVER,
    );
    expect(build({ NODE_ENV: 'test' })).toBeInstanceOf(FakeCallDriver);
    expect(build({ NODE_ENV: 'production' })).toBeInstanceOf(OffCallDriver);
    await expect(new OffCallDriver().openRoom()).rejects.toMatchObject({
      kind: 'off',
    });
  });
});
