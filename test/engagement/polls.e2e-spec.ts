import { POLL_CLOSE_SWEEP } from '../../src/engagement/polls/polls.service';
import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0040: consultative polls — who casts a unit's vote, what a vote may
 * be, who sees the counts and when, and how a poll ends.
 */
describe('Community life — polls', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;
  /** Five more homes with their owners: enough to pass the threshold. */
  let others: { unitId: string; who: Who }[];

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
    others = await e.voters(s.c, 5);
  }, 180_000);

  afterAll(() => h.close());

  const fieldsOf = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;
  const backdate = (id: string, data: object) =>
    e.x.asManager(s.c, () =>
      e.x.prisma.tenant.poll.update({ where: { id }, data }),
    );
  const votes = (p: { options: { votes: number | null }[] }) =>
    p.options.map((o) => o.votes);

  describe('writing', () => {
    it('a question in English, Arabic or both, with two to ten options in the same languages', async () => {
      const post = (body: object) =>
        e.http('post', '/community/polls', s.manager.token, {
          closesAt: e.at(24),
          ...body,
        });
      await post({
        questionEn: 'Paint?',
        questionAr: 'طلاء؟',
        options: [
          { labelEn: 'Yes', labelAr: 'نعم' },
          { labelEn: 'No', labelAr: 'لا' },
        ],
      }).expect(201);
      expect(
        fieldsOf(
          await post({
            questionEn: 'Paint?',
            options: [{ labelEn: 'Yes' }, { labelAr: 'لا' }],
          }).expect(400),
        ),
      ).toEqual([
        { field: 'options.1.labelEn', code: 'FIELD_REQUIRED' },
        { field: 'options.1.labelAr', code: 'FIELD_NOT_ALLOWED' },
      ]);
      expect(
        fieldsOf(
          await post({
            options: [{ labelEn: 'Yes' }, { labelEn: 'No' }],
          }).expect(400),
        ),
      ).toEqual([{ field: 'questionEn', code: 'FIELD_REQUIRED' }]);
      expect(
        fieldsOf(
          await post({
            questionEn: 'Paint?',
            options: [{ labelEn: 'Yes' }, { labelEn: 'No' }],
            closesAt: e.at(-1),
          }).expect(400),
        ),
      ).toEqual([{ field: 'closesAt', code: 'ENDS_BEFORE_START' }]);
    });

    it('before it opens anything changes and residents do not see it; once open only its closing time does', async () => {
      const id = await e.poll(s.manager, { opensAt: e.at(2) });
      expect((await e.pollForStaff(s.manager, id)).status).toBe('scheduled');
      await e.http('get', `/polls/${id}`, s.owner.token).expect(404);
      await e
        .http('patch', `/community/polls/${id}`, s.manager.token, {
          questionEn: 'Repaint the gate green?',
          multiple: true,
          options: [
            { labelEn: 'Green' },
            { labelEn: 'Grey' },
            { labelEn: 'No' },
          ],
        })
        .expect(204);
      expect((await e.pollForStaff(s.manager, id)).options).toHaveLength(3);

      await backdate(id, { opensAt: e.at(-1) });
      expect((await e.pollAs(s.owner, id)).status).toBe('open');
      const res = await e
        .http('patch', `/community/polls/${id}`, s.manager.token, {
          questionEn: 'Something else?',
        })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'POLL_INVALID_STATE',
        params: { status: 'open' },
      });
      await e
        .http('patch', `/community/polls/${id}`, s.manager.token, {
          closesAt: e.at(100),
        })
        .expect(204);
      expect(
        fieldsOf(
          await e
            .http('patch', `/community/polls/${id}`, s.manager.token, {
              closesAt: e.at(-1),
            })
            .expect(400),
        ),
      ).toEqual([{ field: 'closesAt', code: 'ENDS_BEFORE_START' }]);
    });
  });

  describe('who casts a unit’s vote', () => {
    it('the primary; a member only with polls_vote; the vote is the unit’s, whoever casts it', async () => {
      const member = await e.family(s.c, s.home.id, s.owner);
      const id = await e.poll(s.manager);
      const [yes, no] = await e.optionIds(s.manager, id);

      const before = await e.pollAs(member, id);
      expect(before.units).toEqual([
        { unitId: s.home.id, mayVote: false, voted: false, choice: null },
      ]);
      const refused = await e.vote(member, id, [yes]).expect(403);
      expect((refused.body as { code: string }).code).toBe(
        'POLL_VOTE_NOT_ALLOWED',
      );

      await e.vote(s.owner, id, [yes]).expect(201);
      // The member sees that the unit voted, not what.
      expect((await e.pollAs(member, id)).units).toEqual([
        { unitId: s.home.id, mayVote: false, voted: true, choice: null },
      ]);

      await e.grantVote(s.c, s.owner, member.memberId);
      const granted = await e.pollAs(member, id);
      expect(granted.units).toEqual([
        { unitId: s.home.id, mayVote: true, voted: true, choice: [yes] },
      ]);
      // The member changes the unit's vote: still one ballot.
      await e.vote(member, id, [no]).expect(201);
      expect((await e.pollAs(s.owner, id)).units![0].choice).toEqual([no]);
      await e
        .http('post', `/community/polls/${id}/close`, s.manager.token)
        .expect(204);
      const closed = await e.pollForStaff(s.manager, id);
      expect({ turnout: closed.turnout, votes: votes(closed) }).toEqual({
        turnout: 1,
        votes: [0, 1],
      });
    });

    it('a poll put to the owners: the owner votes, landlords included; the tenant who lives there does not see it', async () => {
      const rented = await e.unit(s.c, 'A');
      const landlord = await e.landlord(s.c, rented.id);
      const tenant = await e.tenant(s.c, rented.id);
      const id = await e.poll(s.manager, { audience: { occupancy: 'owners' } });
      const [yes] = await e.optionIds(s.manager, id);
      await e.http('get', `/polls/${id}`, tenant.token).expect(404);
      await e.vote(tenant, id, [yes]).expect(404);
      await e.vote(landlord, id, [yes]).expect(201);
      expect((await e.pollAs(landlord, id)).units).toEqual([
        { unitId: rented.id, mayVote: true, voted: true, choice: [yes] },
      ]);
    });

    it('a poll put to everyone: in a rented unit its tenant (the primary) votes, the landlord sees it and does not; an empty unit’s owner votes', async () => {
      const rented = await e.unit(s.c, 'A');
      const landlord = await e.landlord(s.c, rented.id);
      const tenant = await e.tenant(s.c, rented.id);
      const empty = await e.unit(s.c, 'A');
      const absentee = await e.landlord(s.c, empty.id);
      const id = await e.poll(s.manager);
      const [yes] = await e.optionIds(s.manager, id);
      expect((await e.pollAs(landlord, id)).units![0].mayVote).toBe(false);
      await e.vote(landlord, id, [yes]).expect(403);
      await e.vote(tenant, id, [yes]).expect(201);
      // Nobody lives in the other unit: its owner is its voice.
      expect((await e.pollAs(absentee, id)).units![0].mayVote).toBe(true);
      await e.vote(absentee, id, [yes]).expect(201);
    });

    it('someone who votes for several units says which, and each unit has its own ballot', async () => {
      const [first, second] = [await e.unit(s.c, 'A'), await e.unit(s.c, 'A')];
      const both = await e.who(
        s.c,
        (await e.x.resident(s.c, [first.id, second.id])).id,
        'resident',
      );
      const id = await e.poll(s.manager);
      const [yes, no] = await e.optionIds(s.manager, id);
      expect(fieldsOf(await e.vote(both, id, [yes]).expect(400))).toEqual([
        { field: 'unitId', code: 'FIELD_REQUIRED' },
      ]);
      expect(
        fieldsOf(
          await e.vote(both, id, [yes], { unitId: s.home.id }).expect(400),
        ),
      ).toEqual([{ field: 'unitId', code: 'INVALID_VALUE' }]);
      await e.vote(both, id, [yes], { unitId: first.id }).expect(201);
      await e.vote(both, id, [no], { unitId: second.id }).expect(201);
      const mine = (await e.pollAs(both, id)).units!;
      expect(
        mine
          .map((u) => [u.unitId, u.choice])
          .sort((p, q) => String(p[0]).localeCompare(String(q[0]))),
      ).toEqual(
        [
          [first.id, [yes]],
          [second.id, [no]],
        ].sort((p, q) => String(p[0]).localeCompare(String(q[0]))),
      );
    });
  });

  describe('a choice', () => {
    it('one option, or several when the poll allows it; each of the poll’s own, once', async () => {
      const single = await e.poll(s.manager);
      const [yes, no] = await e.optionIds(s.manager, single);
      expect(
        fieldsOf(await e.vote(s.owner, single, [yes, no]).expect(400)),
      ).toEqual([
        {
          field: 'optionIds',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1 },
        },
      ]);
      const other = await e.poll(s.manager);
      const [foreign] = await e.optionIds(s.manager, other);
      expect(
        fieldsOf(await e.vote(s.owner, single, [foreign]).expect(400)),
      ).toEqual([{ field: 'optionIds.0', code: 'INVALID_VALUE' }]);

      const multiple = await e.poll(s.manager, {
        multiple: true,
        options: [{ labelEn: 'A' }, { labelEn: 'B' }, { labelEn: 'C' }],
      });
      const [a, b, c] = await e.optionIds(s.manager, multiple);
      // Stored in the options' order, whatever order they were picked in.
      await e.vote(s.owner, multiple, [c, a]).expect(201);
      expect((await e.pollAs(s.owner, multiple)).units![0].choice).toEqual([
        a,
        c,
      ]);
      await e.vote(s.owner, multiple, [b]).expect(201);
      expect((await e.pollAs(s.owner, multiple)).units![0].choice).toEqual([b]);
    });

    it('an Idempotency-Key replays the vote without casting it again, and holds nothing of the choice', async () => {
      const id = await e.poll(s.manager);
      const [yes, no] = await e.optionIds(s.manager, id);
      const key = { 'Idempotency-Key': `vote-${id}` };
      const first = await e.vote(s.owner, id, [yes], {}, key).expect(201);
      expect(first.body).toEqual({ pollId: id });
      await e.vote(s.owner, id, [no]).expect(201);
      // The first request, retried late: replayed, and the newer vote stands.
      const replay = await e.vote(s.owner, id, [yes], {}, key).expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual({ pollId: id });
      expect((await e.pollAs(s.owner, id)).units![0].choice).toEqual([no]);
      // The stored key carries no trace of either choice.
      const rows = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.idempotencyKey.findMany({
          where: { resourceType: 'poll_vote', resourceId: id },
        }),
      );
      expect(rows).toHaveLength(1);
      const stored = JSON.stringify(rows);
      expect(stored).not.toContain(yes);
      expect(stored).not.toContain(no);
      // The same key with another choice is the same request to the store.
      await e.vote(s.owner, id, [no], {}, key).expect(201);
    });
  });

  describe('who sees the counts', () => {
    it('nobody while fewer than five units voted; from five on, the staff and the units that voted', async () => {
      const id = await e.poll(s.manager);
      const [yes, no] = await e.optionIds(s.manager, id);
      for (const v of others.slice(0, 3))
        await e.vote(v.who, id, [yes]).expect(201);
      await e.vote(s.owner, id, [no]).expect(201);
      // Four units: withheld from the staff and from a unit that voted.
      for (const view of [
        await e.pollForStaff(s.manager, id),
        await e.pollAs(s.owner, id),
      ])
        expect({
          hidden: view.resultsHidden,
          turnout: view.turnout,
          votes: votes(view),
        }).toEqual({ hidden: 'few_votes', turnout: null, votes: [null, null] });

      await e.vote(others[3].who, id, [yes]).expect(201);
      // Five: shown to the staff and to those who voted.
      for (const view of [
        await e.pollForStaff(s.manager, id),
        await e.pollAs(s.owner, id),
      ])
        expect({
          hidden: view.resultsHidden,
          turnout: view.turnout,
          votes: votes(view),
        }).toEqual({ hidden: null, turnout: 5, votes: [4, 1] });
      // A unit that has not voted still sees nothing.
      expect(await e.pollAs(others[4].who, id)).toMatchObject({
        resultsHidden: 'not_voted',
        turnout: null,
      });
      expect(votes(await e.pollAs(others[4].who, id))).toEqual([null, null]);
      expect(
        (
          await e
            .http('get', `/community/polls/${id}/audience`, s.manager.token)
            .expect(200)
        ).body,
      ).toEqual({ units: expect.any(Number) as number });
    });

    it('once closed, everyone sees everything, even a poll with one vote; no choice is told any more', async () => {
      const id = await e.poll(s.manager);
      const [yes] = await e.optionIds(s.manager, id);
      await e.vote(s.owner, id, [yes]).expect(201);
      await e
        .http('post', `/community/polls/${id}/close`, s.manager.token)
        .expect(204);
      for (const view of [
        await e.pollForStaff(s.manager, id),
        await e.pollAs(s.owner, id),
        await e.pollAs(others[0].who, id),
      ])
        expect({
          status: view.status,
          hidden: view.resultsHidden,
          turnout: view.turnout,
          votes: votes(view),
        }).toEqual({
          status: 'closed',
          hidden: null,
          turnout: 1,
          votes: [1, 0],
        });
      expect((await e.pollAs(s.owner, id)).units).toEqual([
        { unitId: s.home.id, mayVote: true, voted: true, choice: null },
      ]);
      expect((await e.pollAs(others[0].who, id)).units![0].voted).toBe(false);
    });
  });

  describe('the end', () => {
    it('a poll closes at its time by itself: a late vote is refused at once, and the sweep writes the counts', async () => {
      const id = await e.poll(s.manager);
      const [yes, no] = await e.optionIds(s.manager, id);
      await e.vote(s.owner, id, [yes]).expect(201);
      await backdate(id, { opensAt: e.at(-3), closesAt: e.at(-0.01) });
      // Not swept yet, and already closed to a vote and open to its results.
      const late = await e.vote(others[0].who, id, [no]).expect(409);
      expect(late.body).toMatchObject({
        code: 'POLL_INVALID_STATE',
        params: { status: 'closed' },
      });
      expect(votes(await e.pollAs(others[0].who, id))).toEqual([1, 0]);

      expect(await e.sweep(POLL_CLOSE_SWEEP)).toBeGreaterThanOrEqual(1);
      const row = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.poll.findUniqueOrThrow({
          where: { id },
          include: {
            options: { orderBy: { position: 'asc' } },
            ballotBox: true,
          },
        }),
      );
      expect(row.closedAt).not.toBeNull();
      expect(row.ballotSalt).toBeNull();
      expect(row.ballotBox).toBeNull();
      expect(row.finalTurnout).toBe(1);
      expect(row.options.map((o) => o.finalCount)).toEqual([1, 0]);
      // Swept twice, closed once.
      const closedBefore = row.closedAt;
      await e.sweep(POLL_CLOSE_SWEEP);
      expect(
        (
          await e.x.asManager(s.c, () =>
            e.x.prisma.tenant.poll.findUniqueOrThrow({ where: { id } }),
          )
        ).closedAt,
      ).toEqual(closedBefore);
      expect(votes(await e.pollForStaff(s.manager, id))).toEqual([1, 0]);
    });

    it('cancelling ends it with no result: the ballots are destroyed as at a close, and nothing is counted', async () => {
      const id = await e.poll(s.manager);
      const [yes] = await e.optionIds(s.manager, id);
      for (const v of others) await e.vote(v.who, id, [yes]).expect(201);
      await e
        .http('post', `/community/polls/${id}/cancel`, s.manager.token)
        .expect(204);
      for (const view of [
        await e.pollForStaff(s.manager, id),
        await e.pollAs(others[0].who, id),
      ])
        expect({
          status: view.status,
          hidden: view.resultsHidden,
          turnout: view.turnout,
          votes: votes(view),
        }).toEqual({
          status: 'cancelled',
          hidden: 'cancelled',
          turnout: null,
          votes: [null, null],
        });
      const row = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.poll.findUniqueOrThrow({
          where: { id },
          include: { options: true, ballotBox: true, participations: true },
        }),
      );
      expect(row.ballotSalt).toBeNull();
      expect(row.ballotBox).toBeNull();
      expect(row.finalTurnout).toBeNull();
      expect(row.options.map((o) => o.finalCount)).toEqual([null, null]);
      expect(row.participations).toEqual([]);
      await e.vote(others[0].who, id, [yes]).expect(409);
      for (const action of ['close', 'cancel'])
        expect(
          (
            await e
              .http('post', `/community/polls/${id}/${action}`, s.manager.token)
              .expect(409)
          ).body,
        ).toMatchObject({ params: { status: 'cancelled' } });
    });

    it('a poll that has not opened cannot be closed, only cancelled', async () => {
      const id = await e.poll(s.manager, { opensAt: e.at(2) });
      expect(
        (
          await e
            .http('post', `/community/polls/${id}/close`, s.manager.token)
            .expect(409)
        ).body,
      ).toMatchObject({ params: { status: 'scheduled' } });
      await e
        .http('post', `/community/polls/${id}/cancel`, s.manager.token)
        .expect(204);
    });
  });
});
