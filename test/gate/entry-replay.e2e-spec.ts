import { newId } from '../../src/core/common/uuid';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { gateCompletionHelpers } from '../setup/gate-completion';

/**
 * ADR 0028's client id on an entry, retried under an Idempotency-Key of
 * its own (the offline queue's retry, ADR 0057): the same entry, never a
 * 500, and the key then replays it.
 */
describe('Gate — an entry retried by its id under another key', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Entry Replay Court');
  }, 180_000);

  afterAll(() => h.close());

  it('answers the entry it recorded, and the new key replays it', async () => {
    const pass = await g.pass(s.alice, s.home.id, { partySize: 2 });
    const id = newId();
    const send = (key: string) =>
      g.http(
        'post',
        '/gate/entries',
        s.guard.token,
        {
          id,
          subjectType: 'visitor_pass',
          subjectId: pass.id,
          direction: 'in',
        },
        { 'Idempotency-Key': key },
      );
    const first = await send(`entry-${id}-a`);
    expect(first.status).toBe(201);
    const retry = await send(`entry-${id}-b`);
    expect([retry.status, retry.body]).toEqual([201, first.body]);
    const replay = await send(`entry-${id}-b`);
    expect([replay.status, replay.headers['idempotent-replayed']]).toEqual([
      201,
      'true',
    ]);
    expect(replay.body).toEqual(first.body);
    // One person in, once.
    const entries = await g.inTx(s.c, (tx) =>
      tx.gateEntry.count({ where: { subjectId: pass.id } }),
    );
    expect(entries).toBe(1);
  });
});
