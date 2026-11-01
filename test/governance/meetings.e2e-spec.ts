import { BOARD_ACTIONS_SWEEP } from '../../src/governance/meetings/meetings.service';
import { boardMatterHelpers } from '../setup/board-matters';
import { day, daysLater, today } from '../setup/compound-clock';
import { superuserSql, type Who } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

interface ActionBody {
  id: string;
  meetingId: string;
  meetingReference: string;
  title: string;
  ownerAccountId: string;
  dueOn: string;
  status: string;
  overdue: boolean;
  doneNote: string | null;
  cancelReason: string | null;
}

interface MeetingBody {
  id: string;
  reference: string;
  termId: string;
  kind: string;
  title: string;
  location: string | null;
  scheduledAt: string;
  status: string;
  seated: number | null;
  present: number | null;
  quorate: boolean | null;
  minutesPublicationId: string | null;
  cancelReason: string | null;
  agenda: {
    position: number;
    kind: string;
    subjectId: string | null;
    reference: string | null;
    subjectStatus: string | null;
    title: string | null;
  }[];
  attendance: { memberId: string; accountId: string; present: boolean }[];
  actions: ActionBody[];
  followUp: ActionBody[];
}

/**
 * ADR 0075: board meetings — scheduled by a sitting member or the manager
 * for the board that sits, with an agenda of the board's open matters or
 * items of its own; changed while scheduled; held once (who of the seats
 * sitting then was there, and the quorum) or cancelled once; then its
 * minutes, linked once, and its action items: an owner, a due day, done or
 * cancelled once, the owner told, and told again once when it runs late.
 */
describe('Governance — board meetings', () => {
  let h: HttpHarness;
  let b: ReturnType<typeof boardMatterHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardMatterHelpers>['setUp']>>;
  const o = (i: number) => s.owners[i];
  /** The seat of o(i), by the term's members. */
  const seatOf = (i: number) =>
    s.term.members.find((m) => m.accountId === o(i).id)!.id;

  beforeAll(async () => {
    h = await createHttpHarness();
    b = boardMatterHelpers(h);
    // Five owners; o(0), o(1) and o(2) sit (o(0) chairs) on five seats.
    s = await b.setUp(5, 3);
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code: string }).code;
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: { field: string; code: string }[] }).fields.map(
      (f) => [f.field, f.code],
    );
  const schedule = (by: Who, body: Record<string, unknown> = {}) =>
    b.http('post', '/board/meetings', by.token, {
      kind: 'regular',
      title: 'The October meeting',
      location: 'The club house',
      scheduledAt: inHours(48),
      ...body,
    });
  const scheduled = async (by: Who, body: Record<string, unknown> = {}) =>
    (await schedule(by, body).expect(201)).body as MeetingBody;
  const hold = (by: Who, id: string, presentMemberIds: string[]) =>
    b.http('post', `/board/meetings/${id}/hold`, by.token, {
      presentMemberIds,
    });
  const read = async (as: Who, id: string): Promise<MeetingBody> =>
    (await b.http('get', `/board/meetings/${id}`, as.token).expect(200))
      .body as MeetingBody;
  const addAction = (by: Who, id: string, body: Record<string, unknown>) =>
    b.http('post', `/board/meetings/${id}/actions`, by.token, {
      title: 'Ask three firms for a quote',
      ownerAccountId: o(1).id,
      dueOn: day(14),
      ...body,
    });

  describe('scheduling', () => {
    it('a sitting member or the manager schedules one; the other sitting members are told; an owner off the board may not', async () => {
      const m = await scheduled(o(0));
      expect(m).toMatchObject({
        status: 'scheduled',
        kind: 'regular',
        termId: s.term.id,
        agenda: [],
        attendance: [],
      });
      expect(m.reference).toMatch(/^BM-\d{4}$/);
      for (const i of [1, 2])
        expect(
          await b.notifications(s.c, o(i).id, 'board_meeting.scheduled'),
        ).toHaveLength(1);
      expect(
        await b.notifications(s.c, o(0).id, 'board_meeting.scheduled'),
      ).toEqual([]);
      await scheduled(s.manager);
      await schedule(o(3)).expect(403);
    });

    it('its agenda names pending requests, pending appeals and open proposals, each once, or words of its own', async () => {
      const request = await b.raise(s.manager);
      const proposal = (
        (
          await b
            .http('post', '/governance/agenda-proposals', o(4).token, {
              title: 'A bench by the pool',
              body: 'Shade for the parents.',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      const m = await scheduled(o(1), {
        agenda: [
          { kind: 'approval_request', subjectId: request.id },
          { kind: 'agenda_proposal', subjectId: proposal },
          { kind: 'other', title: 'The gardener’s contract' },
        ],
      });
      expect(m.agenda).toEqual([
        {
          position: 1,
          kind: 'approval_request',
          subjectId: request.id,
          reference: expect.stringMatching(/^AR-\d{4}$/) as string,
          subjectStatus: 'pending',
          title: null,
        },
        {
          position: 2,
          kind: 'agenda_proposal',
          subjectId: proposal,
          reference: null,
          subjectStatus: 'open',
          title: 'A bench by the pool',
        },
        {
          position: 3,
          kind: 'other',
          subjectId: null,
          reference: null,
          subjectStatus: null,
          title: 'The gardener’s contract',
        },
      ]);
      expect(
        fields(
          await schedule(o(1), {
            agenda: [
              { kind: 'approval_request', subjectId: request.id },
              { kind: 'approval_request', subjectId: request.id },
              { kind: 'other' },
              { kind: 'board_appeal' },
              { kind: 'other', subjectId: request.id, title: 'x' },
              { kind: 'agenda_proposal', subjectId: proposal, title: 'y' },
            ],
          }).expect(400),
        ),
      ).toEqual([
        ['agenda.1.subjectId', 'DUPLICATE_VALUE'],
        ['agenda.2.title', 'FIELD_REQUIRED'],
        ['agenda.3.subjectId', 'FIELD_REQUIRED'],
        ['agenda.4.subjectId', 'FIELD_NOT_ALLOWED'],
        ['agenda.5.title', 'FIELD_NOT_ALLOWED'],
      ]);
      // A matter no longer before the board: refused.
      await b
        .http(
          'post',
          `/staff/governance/approvals/${request.id}/withdraw`,
          s.manager.token,
          { reasonCode: 'no_longer_needed' },
        )
        .expect(200);
      expect(
        fields(
          await schedule(o(1), {
            agenda: [{ kind: 'approval_request', subjectId: request.id }],
          }).expect(400),
        ),
      ).toEqual([['agenda.0.subjectId', 'INVALID_VALUE']]);
      // The meeting still shows it, as it stands now.
      expect((await read(o(1), m.id)).agenda[0].subjectStatus).toBe(
        'withdrawn',
      );
    });

    it('up to 30 days back and a year ahead', async () => {
      for (const at of [daysLater(-31), daysLater(367)])
        expect(
          fields(
            await schedule(o(0), { scheduledAt: at.toISOString() }).expect(400),
          ),
        ).toEqual([['scheduledAt', 'INVALID_VALUE']]);
      await scheduled(o(0), {
        scheduledAt: daysLater(-2).toISOString(),
      });
    });

    it('while scheduled it changes, its agenda replaced as a whole; then never', async () => {
      const m = await scheduled(o(0), {
        agenda: [{ kind: 'other', title: 'First' }],
      });
      const changed = (
        await b
          .http('patch', `/board/meetings/${m.id}`, o(2).token, {
            kind: 'extraordinary',
            location: null,
            agenda: [
              { kind: 'other', title: 'Second' },
              { kind: 'other', title: 'Third' },
            ],
          })
          .expect(200)
      ).body as MeetingBody;
      expect(changed).toMatchObject({
        kind: 'extraordinary',
        location: null,
        title: 'The October meeting',
      });
      expect(changed.agenda.map((i) => i.title)).toEqual(['Second', 'Third']);
      await hold(o(0), m.id, [seatOf(0)]).expect(200);
      const res = await b
        .http('patch', `/board/meetings/${m.id}`, o(0).token, {
          title: 'Too late',
        })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'BOARD_MEETING_NOT_SCHEDULED',
        params: { status: 'held' },
      });
      // The database holds the agenda once held.
      await expect(
        b.inTx(s.c, (tx) =>
          tx.boardMeetingAgendaItem.deleteMany({ where: { meetingId: m.id } }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('holding and cancelling', () => {
    it('held once: every seat sitting recorded, present or not, and the quorum', async () => {
      const m = await scheduled(o(0));
      expect(
        fields(await hold(o(0), m.id, [s.manager.id]).expect(400)),
      ).toEqual([['presentMemberIds.0', 'INVALID_VALUE']]);
      const held = (await hold(o(0), m.id, [seatOf(0), seatOf(2)]).expect(200))
        .body as MeetingBody;
      expect(held).toMatchObject({
        status: 'held',
        seated: 3,
        present: 2,
        quorate: true,
      });
      expect(
        held.attendance
          .map((a) => [a.accountId, a.present])
          .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      ).toEqual(
        [
          [o(0).id, true],
          [o(1).id, false],
          [o(2).id, true],
        ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
      expect(code(await hold(o(1), m.id, [seatOf(1)]).expect(409))).toBe(
        'BOARD_MEETING_NOT_SCHEDULED',
      );
      const thin = await scheduled(o(0));
      expect(
        (
          (await hold(s.manager, thin.id, [seatOf(0)]).expect(200))
            .body as MeetingBody
        ).quorate,
      ).toBe(false);
    });

    it('cancelled once, with its code; the other sitting members told', async () => {
      const m = await scheduled(o(0));
      await b
        .http('post', `/board/meetings/${m.id}/cancel`, o(1).token, {
          reasonCode: 'nope',
        })
        .expect(400);
      const done = (
        await b
          .http('post', `/board/meetings/${m.id}/cancel`, o(1).token, {
            reasonCode: 'postponed',
          })
          .expect(200)
      ).body as MeetingBody;
      expect(done).toMatchObject({
        status: 'cancelled',
        cancelReason: 'postponed',
      });
      const told = await b.notifications(
        s.c,
        o(2).id,
        'board_meeting.cancelled',
      );
      expect(told.map((n) => [n.targetId, n.params])).toContainEqual([
        m.id,
        { reason: 'postponed' },
      ]);
      expect(
        code(
          await b
            .http('post', `/board/meetings/${m.id}/cancel`, o(1).token, {
              reasonCode: 'other',
            })
            .expect(409),
        ),
      ).toBe('BOARD_MEETING_NOT_SCHEDULED');
      await hold(o(0), m.id, []).expect(409);
    });
  });

  describe('minutes and action items', () => {
    let meeting: MeetingBody;

    beforeAll(async () => {
      meeting = await scheduled(o(0));
      await hold(o(0), meeting.id, [seatOf(0), seatOf(1)]).expect(200);
    });

    const publish = async (kind: string) =>
      (
        (
          await b
            .http('post', '/governance/publications', o(0).token, {
              kind,
              decidedOn: today(),
              titleEn: 'The October minutes',
              bodyEn: 'Present: three. Decided: a quote.',
            })
            .expect(201)
        ).body as { id: string }
      ).id;

    it('the minutes: a `minutes` publication of the same board, linked once, after it was held', async () => {
      const pending = await scheduled(o(0));
      const minutes = await publish('minutes');
      expect(
        code(
          await b
            .http('post', `/board/meetings/${pending.id}/minutes`, o(0).token, {
              publicationId: minutes,
            })
            .expect(409),
        ),
      ).toBe('BOARD_MEETING_NOT_HELD');
      const decision = await publish('decision');
      expect(
        fields(
          await b
            .http('post', `/board/meetings/${meeting.id}/minutes`, o(0).token, {
              publicationId: decision,
            })
            .expect(400),
        ),
      ).toEqual([['publicationId', 'INVALID_VALUE']]);
      const linked = (
        await b
          .http('post', `/board/meetings/${meeting.id}/minutes`, o(1).token, {
            publicationId: minutes,
          })
          .expect(200)
      ).body as MeetingBody;
      expect(linked.minutesPublicationId).toBe(minutes);
      const again = await b
        .http('post', `/board/meetings/${meeting.id}/minutes`, o(1).token, {
          publicationId: await publish('minutes'),
        })
        .expect(409);
      expect(again.body).toMatchObject({
        code: 'BOARD_MEETING_MINUTES_LINKED',
        params: { publicationId: minutes },
      });
    });

    it('an action item: its owner a sitting member or the manager, due today to a year ahead; the owner told', async () => {
      const pending = await scheduled(o(0));
      expect(code(await addAction(o(0), pending.id, {}).expect(409))).toBe(
        'BOARD_MEETING_NOT_HELD',
      );
      expect(
        fields(
          await addAction(o(0), meeting.id, { ownerAccountId: o(3).id }).expect(
            400,
          ),
        ),
      ).toEqual([['ownerAccountId', 'INVALID_VALUE']]);
      for (const dueOn of [day(-1), day(367)])
        expect(
          fields(await addAction(o(0), meeting.id, { dueOn }).expect(400)),
        ).toEqual([['dueOn', 'DAY_OUT_OF_RANGE']]);
      const a = (await addAction(o(0), meeting.id, {}).expect(201))
        .body as ActionBody;
      expect(a).toMatchObject({
        status: 'open',
        ownerAccountId: o(1).id,
        dueOn: day(14),
        overdue: false,
        meetingReference: meeting.reference,
      });
      expect(
        (
          await b.notifications(s.c, o(1).id, 'board_meeting_action.assigned')
        ).map((n) => n.targetId),
      ).toEqual([a.id]);
      // The manager may own one; writing one for oneself tells nobody.
      await addAction(s.manager, meeting.id, {
        ownerAccountId: s.manager.id,
      }).expect(201);
      expect(
        await b.notifications(
          s.c,
          s.manager.id,
          'board_meeting_action.assigned',
        ),
      ).toEqual([]);
    });

    it('done once by its owner, with a note; cancelled once by the board with its code', async () => {
      const a = (await addAction(o(0), meeting.id, {}).expect(201))
        .body as ActionBody;
      const done = (
        await b
          .http('post', `/board/meeting-actions/${a.id}/done`, o(1).token, {
            note: 'Three quotes in.',
          })
          .expect(200)
      ).body as ActionBody;
      expect(done).toMatchObject({
        status: 'done',
        doneNote: 'Three quotes in.',
      });
      expect(
        code(
          await b
            .http('post', `/board/meeting-actions/${a.id}/done`, o(1).token, {})
            .expect(409),
        ),
      ).toBe('BOARD_MEETING_ACTION_CLOSED');
      const c = (await addAction(o(0), meeting.id, {}).expect(201))
        .body as ActionBody;
      const cancelled = (
        await b
          .http('post', `/board/meeting-actions/${c.id}/cancel`, o(2).token, {
            reasonCode: 'superseded',
          })
          .expect(200)
      ).body as ActionBody;
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        cancelReason: 'superseded',
      });
      const mine = (
        await b
          .http(
            'get',
            '/board/meeting-actions?mine=true&status=open',
            o(1).token,
          )
          .expect(200)
      ).body as { data: ActionBody[] };
      expect(mine.data.every((x) => x.ownerAccountId === o(1).id)).toBe(true);
      expect(mine.data.map((x) => x.id)).not.toContain(a.id);
    });

    it('an open item past its day tells its owner once; a later meeting of the same board lists it to follow up', async () => {
      const a = (await addAction(o(0), meeting.id, {}).expect(201))
        .body as ActionBody;
      await superuserSql(
        `UPDATE board_meeting_actions SET due_on = due_on - 30 WHERE id = $1`,
        [a.id],
      );
      await b.sweep(BOARD_ACTIONS_SWEEP);
      await b.sweep(BOARD_ACTIONS_SWEEP);
      expect(
        (
          await b.notifications(s.c, o(1).id, 'board_meeting_action.overdue')
        ).map((n) => n.targetId),
      ).toEqual([a.id]);
      const next = await scheduled(o(0), { scheduledAt: inHours(72) });
      const view = await read(o(2), next.id);
      expect(view.followUp.map((x) => x.id)).toContain(a.id);
      expect(view.followUp.find((x) => x.id === a.id)).toMatchObject({
        overdue: true,
      });
    });
  });

  describe('who reads', () => {
    it('the board and the manager; never an owner off the board', async () => {
      const m = await scheduled(o(0));
      await read(s.manager, m.id);
      await b.http('get', `/board/meetings/${m.id}`, o(3).token).expect(403);
      await b.http('get', '/board/meetings', o(3).token).expect(403);
      const listed = (
        await b
          .http('get', '/board/meetings?status=scheduled', o(1).token)
          .expect(200)
      ).body as { data: MeetingBody[] };
      expect(listed.data.every((x) => x.status === 'scheduled')).toBe(true);
    });
  });
});
