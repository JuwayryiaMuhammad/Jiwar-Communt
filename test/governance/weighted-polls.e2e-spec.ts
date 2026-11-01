import { CONTEST_CLOSE_SWEEP } from '../../src/governance/contests/contest-sweeps';
import { auditReaders } from '../setup/audit';
import {
  governanceHelpers,
  shiftContest,
  type PollBody,
  type Who,
} from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

interface SharesBody {
  items: { unitId: string; unitCode: string; share: string | null }[];
  total: string;
  missing: number;
}

interface WeightedPollBody extends PollBody {
  weighting: string;
  electorateWeight: string | null;
  turnoutWeight: string | null;
  options: (PollBody['options'][number] & { weight: string | null })[];
}

/**
 * ADR 0075: the units' ownership shares, and a poll weighted by them —
 * never secret, its electors weighed when voting opens (a unit with no
 * share weighs 0), quorum and threshold reckoned on the weights, the
 * counts kept beside them; one weighted by unit is as it always was.
 */
describe('Governance — polls weighted by ownership share', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;
  let chair: Who & { unitId: string };
  const o = (i: number) => s.owners[i];

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    // Four owners, a unit each; the first three sit.
    s = await g.setUp(4);
    chair = o(0);
    await g.appoint(s.manager, s.owners.slice(0, 3));
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const fields = (res: { body: unknown }) =>
    (res.body as { fields: { field: string; code: string }[] }).fields.map(
      (f) => [f.field, f.code],
    );
  const putShares = (shares: { unitId: string; share: string | null }[]) =>
    g.http('put', '/staff/governance/unit-shares', s.manager.token, {
      shares,
    });
  const shares = async (as: Who): Promise<SharesBody> =>
    (await g.http('get', '/staff/governance/unit-shares', as.token).expect(200))
      .body as SharesBody;
  const pollAs = async (as: Who, id: string): Promise<WeightedPollBody> =>
    (await g.pollAs(as, id)) as WeightedPollBody;
  const close = async (p: PollBody) => {
    await shiftContest(await g.contestOf(s.c, p.id), -80);
    await g.sweep(CONTEST_CLOSE_SWEEP);
  };

  describe('the shares', () => {
    it('the manager records and clears them; each change audited with the share it replaced', async () => {
      const body = (
        await putShares([
          { unitId: o(0).unitId, share: '60' },
          { unitId: o(1).unitId, share: '10.25' },
        ]).expect(200)
      ).body as SharesBody;
      const of = (b: SharesBody, unitId: string) =>
        b.items.find((i) => i.unitId === unitId)?.share;
      expect(of(body, o(0).unitId)).toBe('60.0000');
      expect(of(body, o(1).unitId)).toBe('10.2500');
      expect(of(body, o(2).unitId)).toBeNull();
      expect(body.total).toBe('70.2500');
      expect(body.missing).toBe(2);
      await putShares([
        { unitId: o(1).unitId, share: '10' },
        { unitId: o(0).unitId, share: '60.0000' },
      ]).expect(200);
      const changes = (
        await read.tenant(s.c.tenantId, {
          action: 'governance_unit_share.changed',
          targetId: o(1).unitId,
        })
      ).map((e) => e.changes);
      expect(changes).toEqual([
        { share: { from: null, to: '10.2500' } },
        { share: { from: '10.2500', to: '10.0000' } },
      ]);
      // Rewriting the same value is no change, and not audited.
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'governance_unit_share.changed',
          targetId: o(0).unitId,
        }),
      ).toHaveLength(1);
      await putShares([{ unitId: o(3).unitId, share: '5' }]).expect(200);
      await putShares([{ unitId: o(3).unitId, share: null }]).expect(200);
      expect(of(await shares(s.manager), o(3).unitId)).toBeNull();
    });

    it('a share is above 0 and at most 100, four decimals at most, a unit named once and in the compound', async () => {
      // In the pattern, out of range: INVALID_NUMBER.
      for (const share of ['0', '0.0000', '100.0001', '101'])
        expect(
          fields(await putShares([{ unitId: o(0).unitId, share }]).expect(400)),
        ).toEqual([['shares.0.share', 'INVALID_NUMBER']]);
      // Not a share as written: INVALID_FORMAT.
      for (const share of ['1.23456', '-1', '1e2', '1000'])
        expect(
          fields(await putShares([{ unitId: o(0).unitId, share }]).expect(400)),
        ).toEqual([['shares.0.share', 'INVALID_FORMAT']]);
      expect(
        fields(
          await putShares([
            { unitId: o(0).unitId, share: '1' },
            { unitId: o(0).unitId, share: '2' },
          ]).expect(400),
        ),
      ).toEqual([['shares.1.unitId', 'DUPLICATE_VALUE']]);
      const other = await g.x.compound('Another Court');
      const foreign = await g.unit(other, 'A');
      expect(
        fields(
          await putShares([{ unitId: foreign.id, share: '1' }]).expect(400),
        ),
      ).toEqual([['shares.0.unitId', 'INVALID_VALUE']]);
      await putShares([{ unitId: o(0).unitId, share: '100' }]).expect(200);
      await putShares([{ unitId: o(0).unitId, share: '60' }]).expect(200);
    });

    it('the sitting board reads them; an owner off the board may not, and only the manager writes', async () => {
      expect((await shares(chair)).total).toBe('70.0000');
      await g
        .http('get', '/staff/governance/unit-shares', o(3).token)
        .expect(403);
      await g
        .http('put', '/staff/governance/unit-shares', chair.token, {
          shares: [{ unitId: o(0).unitId, share: '1' }],
        })
        .expect(403);
    });
  });

  describe('a poll weighted by share', () => {
    it('is never secret', async () => {
      const res = await g
        .http('post', '/governance/polls', chair.token, {
          kind: 'yes_no',
          titleEn: 'Weighted',
          bodyEn: 'By share.',
          secret: true,
          weighting: 'share',
          quorumPct: 50,
          thresholdPct: 50,
          closesAt: inHours(48),
        })
        .expect(400);
      expect(fields(res)).toEqual([['weighting', 'FIELD_NOT_ALLOWED']]);
    });

    it('weighs each elector by the share at the open; the result goes by the weights, the counts kept beside them', async () => {
      // Shares: o(0) 60, o(1) 10, o(2) and o(3) none (they weigh 0).
      const p = (await g.poll(chair, {
        secret: false,
        weighting: 'share',
        quorumPct: 50,
        thresholdPct: 50,
      })) as WeightedPollBody;
      expect(p).toMatchObject({
        weighting: 'share',
        secret: false,
        electorate: 4,
        electorateWeight: '70.0000',
        turnoutWeight: null,
      });
      // A share changed after the open does not reach the poll.
      await putShares([{ unitId: o(2).unitId, share: '90' }]).expect(200);
      const no = g.option(p, 'no');
      const yes = g.option(p, 'yes');
      // Three units say no, by count a majority; the one with 60 says yes.
      await g.castVote(o(0), p.id, o(0).unitId, [yes]).expect(201);
      for (const i of [1, 2, 3])
        await g.castVote(o(i), p.id, o(i).unitId, [no]).expect(201);
      await close(p);
      const done = await pollAs(o(3), p.id);
      expect(done).toMatchObject({
        status: 'closed',
        result: 'passed',
        electorateWeight: '70.0000',
        turnoutWeight: '70.0000',
      });
      const opt = (key: string) => done.options.find((x) => x.key === key)!;
      expect(opt('yes')).toMatchObject({ votes: 1, weight: '60.0000' });
      expect(opt('no')).toMatchObject({ votes: 3, weight: '10.0000' });
      expect(opt('abstain')).toMatchObject({ votes: 0, weight: '0.0000' });
      const closed = (
        await read.tenant(s.c.tenantId, {
          action: 'governance_poll.closed',
          targetId: p.id,
        })
      )[0];
      expect(closed.metadata).toEqual({
        result: 'passed',
        turnout: 4,
        electorate: 4,
        weighting: 'share',
        turnoutWeight: '70.0000',
      });
      await putShares([{ unitId: o(2).unitId, share: null }]).expect(200);
    });

    it('meets its quorum by weight: most units voting is not enough when their shares are not', async () => {
      const p = await g.poll(s.manager, {
        secret: false,
        weighting: 'share',
        quorumPct: 50,
        thresholdPct: 50,
      });
      // o(1) (10), o(2) and o(3) (0): three of four units, 10 of 70.
      for (const i of [1, 2, 3])
        await g
          .castVote(o(i), p.id, o(i).unitId, [g.option(p, 'yes')])
          .expect(201);
      await close(p);
      expect(await pollAs(o(1), p.id)).toMatchObject({
        result: 'no_quorum',
        turnoutWeight: '10.0000',
      });
    });

    it('with no share recorded at all, it never meets its quorum', async () => {
      await putShares([
        { unitId: o(0).unitId, share: null },
        { unitId: o(1).unitId, share: null },
      ]).expect(200);
      const p = await g.poll(chair, {
        secret: false,
        weighting: 'share',
        quorumPct: 1,
        thresholdPct: 50,
      });
      expect(await pollAs(chair, p.id)).toMatchObject({
        electorateWeight: '0.0000',
      });
      for (const i of [0, 1, 2, 3])
        await g
          .castVote(o(i), p.id, o(i).unitId, [g.option(p, 'yes')])
          .expect(201);
      await close(p);
      expect(await pollAs(chair, p.id)).toMatchObject({ result: 'no_quorum' });
      await putShares([
        { unitId: o(0).unitId, share: '60' },
        { unitId: o(1).unitId, share: '10' },
      ]).expect(200);
    });

    it('a poll weighted by unit is as it always was: no weights anywhere', async () => {
      const p = (await g.poll(chair, { secret: false })) as WeightedPollBody;
      expect(p).toMatchObject({
        weighting: 'unit',
        electorateWeight: null,
      });
      await g
        .castVote(o(0), p.id, o(0).unitId, [g.option(p, 'no')])
        .expect(201);
      for (const i of [1, 2])
        await g
          .castVote(o(i), p.id, o(i).unitId, [g.option(p, 'yes')])
          .expect(201);
      await close(p);
      const done = await pollAs(chair, p.id);
      expect(done).toMatchObject({ result: 'passed', turnoutWeight: null });
      expect(done.options.every((x) => x.weight === null)).toBe(true);
      const opened = (
        await read.tenant(s.c.tenantId, {
          action: 'governance_poll.opened',
          targetId: p.id,
        })
      )[0];
      expect(opened.metadata).toEqual({ electorate: 4, ballot: 'open' });
    });

    it('the database holds the rule too: a poll weighted by share on a secret contest is refused', async () => {
      const p = await g.poll(chair);
      const contestId = await g.contestOf(s.c, p.id);
      await expect(
        g.inTx(
          s.c,
          (tx) =>
            tx.$executeRaw`
            UPDATE governance_polls SET weighting = 'share'
             WHERE contest_id = ${contestId}::uuid`,
        ),
      ).rejects.toThrow();
      await expect(
        g.inTx(
          s.c,
          (tx) =>
            tx.$executeRaw`
            UPDATE governance_electors SET weight = 1
             WHERE contest_id = ${contestId}::uuid`,
        ),
      ).rejects.toThrow();
    });
  });
});
