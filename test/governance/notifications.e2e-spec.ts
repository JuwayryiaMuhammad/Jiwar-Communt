import {
  CONTEST_CLOSE_SWEEP,
  CONTEST_REMIND_SWEEP,
} from '../../src/governance/contests/contest-sweeps';
import { governanceHelpers, shiftContest, type Who } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const HOUR = 3_600_000;

/**
 * ADR 0051: who hears of a poll — its electors when it opens, those whose
 * unit has not voted a day before it closes (once), its electors and the
 * board at its result — in generic words, with no title and no choice.
 */
describe('Governance — notifications', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;
  let tenant: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    s = await g.setUp(4);
    await g.appoint(s.manager, s.owners.slice(0, 3));
    const rented = await g.unit(s.c, 'B');
    await g.landlord(s.c, rented.id);
    tenant = await g.tenant(s.c, rented.id);
  }, 180_000);

  afterAll(() => h.close());

  const told = async (who: Who, kind: string, targetId: string) =>
    (await g.notifications(s.c, who.id, kind)).filter(
      (n) => n.targetId === targetId,
    );

  it('voting opened: every elector, nobody else', async () => {
    const p = await g.poll(s.manager);
    for (const o of s.owners)
      expect(await told(o, 'governance_poll.opened', p.id)).toHaveLength(1);
    expect(await told(tenant, 'governance_poll.opened', p.id)).toEqual([]);
    expect(await told(s.manager, 'governance_poll.opened', p.id)).toEqual([]);
    const [n] = await told(s.owners[0], 'governance_poll.opened', p.id);
    expect(n.params).toEqual({});
  });

  it('a day before the close, once, to the electors whose unit has not voted', async () => {
    const p = await g.poll(s.manager, {
      closesAt: new Date(Date.now() + 48 * HOUR).toISOString(),
    });
    await g
      .castVote(s.owners[0], p.id, s.owners[0].unitId, [g.option(p, 'yes')])
      .expect(201);
    const at = new Date(Date.now() + 30 * HOUR);
    await g.sweep(CONTEST_REMIND_SWEEP, at);
    await g.sweep(CONTEST_REMIND_SWEEP, at);
    expect(
      await told(s.owners[0], 'governance_poll.closing_soon', p.id),
    ).toEqual([]);
    for (const o of s.owners.slice(1))
      expect(await told(o, 'governance_poll.closing_soon', p.id)).toHaveLength(
        1,
      );
  });

  it('no reminder for a poll that ran less than a day', async () => {
    const p = await g.poll(s.manager, {
      closesAt: new Date(Date.now() + 10 * HOUR).toISOString(),
    });
    await g.sweep(CONTEST_REMIND_SWEEP, new Date(Date.now() + 2 * HOUR));
    for (const o of s.owners)
      expect(await told(o, 'governance_poll.closing_soon', p.id)).toEqual([]);
  });

  it('the result: its electors and the board, the result’s code alone', async () => {
    // Five units vote (four homes and the rented one): one is 20 %.
    const p = await g.poll(s.manager, { quorumPct: 20 });
    await g
      .castVote(s.owners[3], p.id, s.owners[3].unitId, [g.option(p, 'yes')])
      .expect(201);
    await shiftContest(await g.contestOf(s.c, p.id), -80);
    await g.sweep(CONTEST_CLOSE_SWEEP);
    for (const o of s.owners) {
      const [n] = await told(o, 'governance_poll.result', p.id);
      expect(n.params).toEqual({ result: 'passed' });
    }
    expect(await told(tenant, 'governance_poll.result', p.id)).toEqual([]);
  });
});
