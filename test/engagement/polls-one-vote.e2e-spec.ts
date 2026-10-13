import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0040: one vote per unit, whatever arrives at once. A unit's ballot is
 * filed under one reference in the poll's ballot box, and every vote takes
 * the box's row lock: these races run for real, then the box is counted.
 */
describe('Community life — one vote per unit under concurrency', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;
  let member: Who & { memberId: string };
  let others: { unitId: string; who: Who }[];

  const ROUNDS = 3;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
    member = await e.family(s.c, s.home.id, s.owner);
    await e.grantVote(s.c, s.owner, member.memberId);
    others = await e.voters(s.c, 8);
  }, 180_000);

  afterAll(() => h.close());

  /** The ballots in the box, as the database holds them. */
  const box = async (pollId: string) => {
    const row = await e.x.asManager(s.c, () =>
      e.x.prisma.tenant.pollBallotBox.findUniqueOrThrow({
        where: { tenantId_pollId: { tenantId: s.c.tenantId, pollId } },
      }),
    );
    return row.ballots as Record<string, string[]>;
  };

  it('two members of one household voting at once: one ballot, holding one of the two choices', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await e.poll(s.manager);
      const [yes, no] = await e.optionIds(s.manager, id);
      const results = await Promise.all([
        e.vote(s.owner, id, [yes]),
        e.vote(member, id, [no]),
      ]);
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      const ballots = await box(id);
      expect(Object.keys(ballots)).toHaveLength(1);
      const [choice] = Object.values(ballots);
      expect([[yes], [no]]).toContainEqual(choice);
      // Exactly one of the two was the first vote; the other changed it.
      const audit = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.auditLog.findMany({
          where: { action: 'poll.vote_cast', targetId: id },
        }),
      );
      expect(
        audit.map((r) => (r.metadata as { changed: boolean }).changed).sort(),
      ).toEqual([false, true]);
    }
  });

  it('the same person voting ten times at once: one ballot', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await e.poll(s.manager);
      const [yes, no] = await e.optionIds(s.manager, id);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          e.vote(s.owner, id, [i % 2 ? yes : no]),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(Object.keys(await box(id))).toHaveLength(1);
    }
  });

  it('many units at once: one ballot each, none lost, and the counts add up', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await e.poll(s.manager);
      const [yes, no] = await e.optionIds(s.manager, id);
      const results = await Promise.all([
        ...others.map((v, i) => e.vote(v.who, id, [i % 2 ? yes : no])),
        e.vote(s.owner, id, [yes]),
        e.vote(member, id, [yes]),
      ]);
      expect(results.every((r) => r.status === 201)).toBe(true);
      const ballots = await box(id);
      // Eight other units and the home: nine ballots for ten requests.
      expect(Object.keys(ballots)).toHaveLength(others.length + 1);
      const view = await e.pollForStaff(s.manager, id);
      expect(view.turnout).toBe(others.length + 1);
      expect(view.options.map((o) => o.votes)).toEqual([
        others.length / 2 + 1,
        others.length / 2,
      ]);
    }
  });

  it('the same Idempotency-Key sent twice at once casts one vote and answers both', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await e.poll(s.manager);
      const [yes] = await e.optionIds(s.manager, id);
      const key = { 'Idempotency-Key': `race-${id}` };
      const results = await Promise.all([
        e.vote(s.owner, id, [yes], {}, key),
        e.vote(s.owner, id, [yes], {}, key),
      ]);
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      const audit = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.auditLog.count({
          where: { action: 'poll.vote_cast', targetId: id },
        }),
      );
      expect(audit).toBe(1);
    }
  });
});
