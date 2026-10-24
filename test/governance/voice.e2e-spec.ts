import { boardAppealHelpers } from '../setup/board-appeals';
import { today } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface ProposalBody {
  id: string;
  status: string;
  declineReason: string | null;
  decisionNote: string | null;
}

/**
 * ADR 0059: the owners' voice. An owner proposes a matter for the board's
 * agenda (three open at most), decided once by a sitting member; objects
 * to a published decision once per unit they own, within the objection
 * days, answered once by the board; and reads how an approved request is
 * followed up.
 */
describe('Governance — the owners’ voice', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof boardAppealHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardAppealHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = boardAppealHelpers(h);
    // o(0), o(1), o(2) sit; o(3)…o(7) own a unit each.
    s = await a.setUp(8, 3);
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const propose = (as: { token: string }, title = 'Solar panels') =>
    a.http('post', '/governance/agenda-proposals', as.token, {
      title,
      body: 'Panels on the roofs would cut the shared bill.',
    });
  const decide = (by: { token: string }, id: string, body: object) =>
    a.http('post', `/board/agenda-proposals/${id}/decide`, by.token, body);
  const publish = async () =>
    (
      (
        await a
          .http('post', '/governance/publications', o(0).token, {
            kind: 'decision',
            decidedOn: today(),
            titleEn: 'The gym closes at 22:00',
            bodyEn: 'From next month.',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  const object = (
    as: { token: string },
    publicationId: string,
    unitId: string,
  ) =>
    a.http(
      'post',
      `/governance/publications/${publicationId}/objections`,
      as.token,
      {
        unitId,
        grounds: 'Many of us train after work.',
      },
    );

  describe('agenda proposals', () => {
    it('an owner proposes; three open at most; a sitting member decides once, a decline with its code', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++)
        ids.push(
          (
            (await propose(o(3), `Matter ${i}`).expect(201))
              .body as ProposalBody
          ).id,
        );
      expect((await propose(o(3)).expect(409)).body).toMatchObject({
        code: 'AGENDA_PROPOSAL_LIMIT',
        params: { max: 3 },
      });
      expect(
        code(await decide(o(0), ids[0], { outcome: 'declined' }).expect(400)),
      ).toBe('REASON_REQUIRED');
      const declined = (
        await decide(o(0), ids[0], {
          outcome: 'declined',
          reasonCode: 'not_now',
          note: 'Next year’s budget.',
        }).expect(200)
      ).body as ProposalBody;
      expect(declined).toMatchObject({
        status: 'declined',
        declineReason: 'not_now',
        decisionNote: 'Next year’s budget.',
      });
      expect(
        code(await decide(o(1), ids[0], { outcome: 'accepted' }).expect(409)),
      ).toBe('AGENDA_PROPOSAL_NOT_OPEN');
      await decide(o(1), ids[1], { outcome: 'accepted' }).expect(200);
      expect(
        (await a.notifications(s.c, o(3).id, 'governance_agenda.decided')).map(
          (n) => n.params,
        ),
      ).toEqual(
        expect.arrayContaining([
          { outcome: 'declined' },
          { outcome: 'accepted' },
        ]),
      );
      // Two decided: room again.
      await propose(o(3)).expect(201);
    });

    it('its proposer’s alone among the owners; not the manager’s to decide', async () => {
      const mine = (await propose(o(4)).expect(201)).body as ProposalBody;
      expect(
        code(
          await a
            .http('get', `/governance/agenda-proposals/${mine.id}`, o(5).token)
            .expect(404),
        ),
      ).toBe('AGENDA_PROPOSAL_NOT_FOUND');
      await decide(s.manager, mine.id, { outcome: 'accepted' }).expect(403);
      await a
        .http('get', `/board/agenda-proposals/${mine.id}`, o(2).token)
        .expect(200);
      await a
        .http(
          'post',
          `/governance/agenda-proposals/${mine.id}/withdraw`,
          o(4).token,
        )
        .expect(200);
    });

    it('two at once for the last place: one of them (×3)', async () => {
      for (let i = 0; i < 3; i++) {
        const owner = o(5);
        const open = (
          (
            await a
              .http('get', '/governance/agenda-proposals', owner.token)
              .expect(200)
          ).body as { data: ProposalBody[] }
        ).data.filter((p) => p.status === 'open');
        for (const p of open)
          await a
            .http(
              'post',
              `/governance/agenda-proposals/${p.id}/withdraw`,
              owner.token,
            )
            .expect(200);
        await propose(owner).expect(201);
        await propose(owner).expect(201);
        const results = await Promise.all([propose(owner), propose(owner)]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      }
    });
  });

  describe('objections', () => {
    it('once per unit an owner owns; the board sees how many and why, never whose; answered once, every objector told', async () => {
      const publicationId = await publish();
      await object(o(3), publicationId, o(3).unitId).expect(201);
      expect(
        code(await object(o(3), publicationId, o(3).unitId).expect(409)),
      ).toBe('OBJECTION_EXISTS');
      // Not a unit of theirs.
      expect(
        code(await object(o(4), publicationId, o(3).unitId).expect(403)),
      ).toBe('OBJECTION_NOT_ALLOWED');
      await object(o(4), publicationId, o(4).unitId).expect(201);
      const board = (
        await a
          .http(
            'get',
            `/board/publications/${publicationId}/objections`,
            o(0).token,
          )
          .expect(200)
      ).body as { count: number; grounds: unknown[]; answer: unknown };
      expect(board).toMatchObject({ count: 2, answer: null });
      expect(JSON.stringify(board)).not.toContain(o(3).id);
      expect(JSON.stringify(board)).not.toContain(o(3).unitId);
      await a
        .http(
          'post',
          `/board/publications/${publicationId}/objections/answer`,
          o(1).token,
          {
            body: 'The hours follow the neighbours’ complaints.',
          },
        )
        .expect(201);
      for (const who of [o(3), o(4)])
        expect(
          await a.notifications(s.c, who.id, 'governance_objection.answered'),
        ).toHaveLength(1);
      expect(
        code(
          await a
            .http(
              'post',
              `/board/publications/${publicationId}/objections/answer`,
              o(0).token,
              {
                body: 'Again.',
              },
            )
            .expect(409),
        ),
      ).toBe('OBJECTIONS_ANSWERED');
      // Answered: the decision takes no more.
      expect(
        (await object(o(5), publicationId, o(5).unitId).expect(409)).body,
      ).toMatchObject({
        code: 'OBJECTION_NOT_OPEN',
        params: { reason: 'answered' },
      });
      const mine = (
        await a.http('get', '/governance/objections', o(3).token).expect(200)
      ).body as { answer: { body: string } | null }[];
      expect(mine[0].answer?.body).toBe(
        'The hours follow the neighbours’ complaints.',
      );
      // The owners' view of the decision says so.
      const list = (
        await a.http('get', '/governance/publications', o(6).token).expect(200)
      ).body as {
        data: { id: string; objections: { answered: boolean } | null }[];
      };
      expect(
        list.data.find((p) => p.id === publicationId)?.objections,
      ).toMatchObject({
        answered: true,
      });
    });

    it('two owners of one unit at once: one objection (×3)', async () => {
      for (let i = 0; i < 3; i++) {
        const unit = await a.unit(s.c, 'A');
        const first = await a.owner(s.c, unit.id);
        const second = await a.owner(s.c, unit.id);
        const publicationId = await publish();
        const results = await Promise.all([
          object(first, publicationId, unit.id),
          object(second, publicationId, unit.id),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      }
    });
  });

  describe('the follow-up of an approved request', () => {
    it('in progress as it moves, then final once; the board and the staff read each step', async () => {
      const r = await a.raise(s.manager);
      const m = await a.motion(o(0), r.id);
      await a.vote(o(0), m.id, 'for').expect(201);
      await a.vote(o(1), m.id, 'for').expect(201);
      const step = (body: object) =>
        a.http(
          'post',
          `/staff/governance/approvals/${r.id}/progress`,
          s.manager.token,
          body,
        );
      await step({ status: 'in_progress', note: 'Quotes asked.' }).expect(200);
      await step({ status: 'in_progress', note: 'Contractor booked.' }).expect(
        200,
      );
      const done = (
        await step({ status: 'implemented', note: 'Repaired.' }).expect(200)
      ).body as {
        implementation: { note: string } | null;
        progress: { status: string; note: string }[];
      };
      expect(done.implementation).toMatchObject({ note: 'Repaired.' });
      expect(done.progress.map((p) => p.status)).toEqual([
        'in_progress',
        'in_progress',
        'implemented',
      ]);
      expect(code(await step({ status: 'in_progress' }).expect(409))).toBe(
        'APPROVAL_PROGRESS_FINAL',
      );
      await a
        .http(
          'post',
          `/staff/governance/approvals/${r.id}/implemented`,
          s.manager.token,
          {},
        )
        .expect(409);
    });
  });
});
