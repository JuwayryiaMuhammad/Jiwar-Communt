import { eraseNow } from '../setup/erasure';
import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0040 with ADR 0023 and 0036: what a personal-data export holds of a
 * person's community life (their suggestions, their answers to events, and
 * "voted: yes or no" for their units), and what an erasure takes away (their
 * words, their supports, their answers) and leaves (the suggestion and all
 * the staff wrote; the unit's ballot, still counted).
 */
describe('Community life — export and erasure', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;
  let neighbour: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
    neighbour = await e.owner(s.c, (await e.unit(s.c, 'A')).id);
  }, 120_000);

  afterAll(() => h.close());

  /**
   * A second owner of a unit: not its primary, so they can be erased. With
   * the email an export's step-up needs.
   */
  async function resident(unitId: string) {
    const p = await e.x.resident(s.c, [unitId]);
    return { ...p, ...(await e.who(s.c, p.id, 'resident')) };
  }

  async function exportOf(p: Who & { email: string }) {
    await stepUp(h, p.token, p.email);
    const asked = await h
      .http()
      .post(`${API}/me/data-exports`)
      .set('Authorization', `Bearer ${p.token}`)
      .send({})
      .expect(201);
    await buildExports(h);
    const dl = await h
      .http()
      .get(
        `${API}/me/data-exports/${(asked.body as { id: string }).id}/download`,
      )
      .set('Authorization', `Bearer ${p.token}`)
      .expect(200);
    return readArchive((dl.body as { url: string }).url);
  }

  describe('the personal-data export', () => {
    it('holds the account’s suggestions with the staff’s answers, its supports, its answers to events and "voted: yes or no" — nothing of anyone else, and no choice', async () => {
      const unit = await e.unit(s.c, 'A');
      const primary = await e.owner(s.c, unit.id);
      const p = await resident(unit.id);

      const own = await e.suggestion(s.c, p, { body: 'EXPORT-MY-SUGGESTION' });
      await e
        .move(s.manager, own, 'planned', 'EXPORT-STAFF-ANSWER')
        .expect(204);
      await e
        .publish(s.manager, own, {
          titleEn: 'EXPORT-PUBLIC-TITLE',
          textEn: 'EXPORT-PUBLIC-TEXT',
        })
        .expect(204);
      const theirs = await e.suggestion(s.c, neighbour, {
        body: 'EXPORT-OTHER-PERSON',
      });
      await e.publish(s.manager, theirs).expect(204);
      await e
        .http('put', `/suggestion-board/${theirs}/support`, p.token)
        .expect(204);

      const eventId = await e.event(s.manager, { titleEn: 'EXPORT-EVENT' });
      await e.rsvp(p, eventId, { response: 'going', guests: 1 }).expect(204);
      await e.rsvp(neighbour, eventId).expect(204);

      // The unit voted (its primary did); another poll it did not vote in.
      const voted = await e.poll(s.manager, { questionEn: 'EXPORT-POLL-ONE?' });
      const [yes] = await e.optionIds(s.manager, voted);
      await e.vote(primary, voted, [yes]).expect(201);
      const silent = await e.poll(s.manager, {
        questionEn: 'EXPORT-POLL-TWO?',
      });
      const closed = await e.poll(s.manager, {
        questionEn: 'EXPORT-POLL-THREE?',
      });
      const [closedYes] = await e.optionIds(s.manager, closed);
      await e.vote(primary, closed, [closedYes]).expect(201);
      await e
        .http('post', `/community/polls/${closed}/close`, s.manager.token)
        .expect(204);

      const archive = await exportOf(p);
      expect(archive.names.filter((n) => n.startsWith('community/'))).toEqual([
        'community/event-answers.json',
        'community/poll-votes.json',
        'community/suggestion-supports.json',
        'community/suggestions.json',
      ]);

      const suggestions = JSON.parse(
        archive.text('community/suggestions.json'),
      ) as {
        id: string;
        body: string;
        status: string;
        response: string;
        publicSummary: { titleEn: string };
        updates: { status: string; response: string }[];
      }[];
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toMatchObject({
        id: own,
        body: 'EXPORT-MY-SUGGESTION',
        status: 'planned',
        response: 'EXPORT-STAFF-ANSWER',
        publicSummary: { titleEn: 'EXPORT-PUBLIC-TITLE' },
        updates: [{ status: 'planned', response: 'EXPORT-STAFF-ANSWER' }],
      });
      expect(
        JSON.parse(archive.text('community/suggestion-supports.json')),
      ).toEqual([{ suggestionId: theirs }]);
      expect(
        JSON.parse(archive.text('community/event-answers.json')),
      ).toMatchObject([
        {
          eventId,
          titleEn: 'EXPORT-EVENT',
          unitId: unit.id,
          response: 'going',
          guests: 1,
        },
      ]);

      const votes = JSON.parse(archive.text('community/poll-votes.json')) as {
        pollId: string;
        unitId: string;
        voted: boolean;
      }[];
      const mine = votes.filter((v) =>
        [voted, silent, closed].includes(v.pollId),
      );
      expect(
        mine
          .map((v) => [v.pollId, v.unitId, v.voted])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual(
        [
          [voted, unit.id, true],
          [silent, unit.id, false],
          [closed, unit.id, true],
        ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
      // "Voted: yes or no", and nothing else: the keys say so, and no option
      // id of any poll is anywhere in the archive.
      expect(Object.keys(votes[0]).sort()).toEqual([
        'closesAt',
        'pollId',
        'questionAr',
        'questionEn',
        'unitId',
        'voted',
      ]);
      expect(archive.all).not.toContain(yes);
      expect(archive.all).not.toContain(closedYes);
      // Nobody else's words, and nobody else's answer to the event.
      expect(archive.all).not.toContain('EXPORT-OTHER-PERSON');
      expect(archive.all).not.toContain(neighbour.id);
    });
  });

  describe('erasure', () => {
    it('clears the author’s words and nothing else: the suggestion stays with the staff’s answer, its summary stays on the board', async () => {
      const unit = await e.unit(s.c, 'A');
      await e.owner(s.c, unit.id);
      const p = await resident(unit.id);
      const id = await e.suggestion(s.c, p, { body: 'ERASE-MY-WORDS' });
      await e.move(s.manager, id, 'planned', 'ERASE-STAFF-ANSWER').expect(204);
      await e
        .publish(s.manager, id, {
          titleEn: 'ERASE-PUBLIC-TITLE',
          textEn: 'ERASE-PUBLIC-TEXT',
        })
        .expect(204);
      await e
        .http('put', `/suggestion-board/${id}/support`, neighbour.token)
        .expect(204);

      await eraseNow(h, s.c, p.id);

      const row = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.suggestion.findUniqueOrThrow({ where: { id } }),
      );
      expect(row.body).toBeNull();
      expect(row.erasedAt).not.toBeNull();
      expect(row).toMatchObject({
        authorId: p.id,
        status: 'planned',
        response: 'ERASE-STAFF-ANSWER',
        publicTitleEn: 'ERASE-PUBLIC-TITLE',
        publicTextEn: 'ERASE-PUBLIC-TEXT',
      });
      // The staff's view says so; the board is untouched, support and all.
      const inbox = (
        await e
          .http('get', `/community/suggestions/${id}`, s.manager.token)
          .expect(200)
      ).body as { body: null; erased: boolean; response: string };
      expect(inbox).toMatchObject({
        body: null,
        erased: true,
        response: 'ERASE-STAFF-ANSWER',
      });
      const board = (
        (
          await e
            .http('get', '/suggestion-board?limit=100', neighbour.token)
            .expect(200)
        ).body as { data: { id: string; supports: number; summary: object }[] }
      ).data.find((b) => b.id === id)!;
      expect(board).toMatchObject({
        supports: 1,
        summary: { titleEn: 'ERASE-PUBLIC-TITLE' },
      });
      // Nothing of the words is left anywhere the suggestion is stored.
      const everything = await e.inTx(s.c, (tx) =>
        tx.$queryRawUnsafe<{ row: string }[]>(
          `SELECT row_to_json(x)::text AS row FROM suggestions x WHERE id = $1::uuid
           UNION ALL
           SELECT row_to_json(u)::text FROM suggestion_updates u WHERE suggestion_id = $1::uuid`,
          id,
        ),
      );
      expect(JSON.stringify(everything)).not.toContain('ERASE-MY-WORDS');
      // The staff may still move and answer it; the erased author is told nothing.
      await e.move(s.manager, id, 'done').expect(204);
      expect(
        (
          await e.notifications(
            s.c,
            p.id,
            'community_suggestion.status_changed',
          )
        ).length,
      ).toBe(0);
    });

    it('deletes the supports the account gave and its answers to events, freeing their seats', async () => {
      const unit = await e.unit(s.c, 'A');
      await e.owner(s.c, unit.id);
      const p = await resident(unit.id);
      const suggestionId = await e.suggestion(s.c, neighbour);
      await e.publish(s.manager, suggestionId).expect(204);
      await e
        .http('put', `/suggestion-board/${suggestionId}/support`, p.token)
        .expect(204);
      const eventId = await e.event(s.manager, { capacity: 3 });
      await e.rsvp(p, eventId, { response: 'going', guests: 2 }).expect(204);
      await e.rsvp(neighbour, eventId).expect(409);

      await eraseNow(h, s.c, p.id);

      const left = await e.x.asManager(s.c, async () => ({
        supports: await e.x.prisma.tenant.suggestionSupport.count({
          where: { accountId: p.id },
        }),
        rsvps: await e.x.prisma.tenant.eventRsvp.count({
          where: { accountId: p.id },
        }),
      }));
      expect(left).toEqual({ supports: 0, rsvps: 0 });
      // The seats are free again.
      await e
        .rsvp(neighbour, eventId, { response: 'going', guests: 2 })
        .expect(204);
      const attendees = (
        await e
          .http(
            'get',
            `/community/events/${eventId}/attendees`,
            s.manager.token,
          )
          .expect(200)
      ).body as { data: { accountId: string }[] };
      expect(attendees.data.map((a) => a.accountId)).toEqual([neighbour.id]);
    });

    it('leaves a unit’s ballot where it is: no account was ever stored with it, and it is still counted', async () => {
      const unit = await e.unit(s.c, 'A');
      const primary = await e.owner(s.c, unit.id);
      // The member who cast the vote is the one erased.
      const member = await e.family(s.c, unit.id, primary);
      await e.grantVote(s.c, primary, member.memberId);
      const id = await e.poll(s.manager);
      const [yes] = await e.optionIds(s.manager, id);
      await e.vote(member, id, [yes]).expect(201);

      await eraseNow(h, s.c, member.id);

      // The primary still finds the unit's ballot as it was cast.
      expect((await e.pollAs(primary, id)).units).toEqual([
        { unitId: unit.id, mayVote: true, voted: true, choice: [yes] },
      ]);
      await e
        .http('post', `/community/polls/${id}/close`, s.manager.token)
        .expect(204);
      const closed = await e.pollForStaff(s.manager, id);
      expect({
        turnout: closed.turnout,
        votes: closed.options.map((o) => o.votes),
      }).toEqual({ turnout: 1, votes: [1, 0] });
      // No table of the polls ever held the account.
      const polls = await e.inTx(s.c, (tx) =>
        tx.$queryRawUnsafe<{ row: string }[]>(
          `SELECT row_to_json(p)::text AS row FROM polls p WHERE id = $1::uuid
           UNION ALL
           SELECT row_to_json(x)::text FROM poll_participations x WHERE poll_id = $1::uuid`,
          id,
        ),
      );
      expect(JSON.stringify(polls)).not.toContain(member.id);
    });

    it('an announcement’s read marks name nobody, so an erasure has nothing to take from them', async () => {
      const unit = await e.unit(s.c, 'A');
      await e.owner(s.c, unit.id);
      const p = await resident(unit.id);
      const id = await e.announcement(s.manager);
      await e.http('post', `/announcements/${id}/read`, p.token).expect(204);
      const counts = async () =>
        (
          await e
            .http(
              'get',
              `/community/announcements/${id}/reads`,
              s.manager.token,
            )
            .expect(200)
        ).body as { accounts: number; units: number };
      expect(await counts()).toMatchObject({ accounts: 1, units: 1 });
      await eraseNow(h, s.c, p.id);
      // Still a count of one: it was never a row about the account.
      expect(await counts()).toMatchObject({ accounts: 1, units: 1 });
    });
  });
});
