import { auditReaders } from '../setup/audit';
import { boardMatterHelpers, type Who } from '../setup/board-matters';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const ROUNDS = 5;
const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

/**
 * ADR 0075, the races of a meeting. A hold takes the term and its seats
 * shared, then the meeting for update, so:
 * - two holds at once: one records it, once (one attendance row per seat,
 *   one audit row); the other is refused;
 * - a seat ended while the meeting is held: the attendance is the board's
 *   either before or after it, and the stored count says which;
 * - an action item marked done while it is cancelled: one of the two.
 */
describe('Governance — board meetings, concurrently (ADR 0075)', () => {
  let h: HttpHarness;
  let b: ReturnType<typeof boardMatterHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardMatterHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    b = boardMatterHelpers(h);
    // Eight owners; the first six sit, on eight seats.
    s = await b.setUp(8, 6);
    read = auditReaders(h);
  }, 300_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const seatOf = (who: Who) =>
    s.term.members.find((m) => m.accountId === who.id)!.id;
  const schedule = async (by: Who) =>
    (
      (
        await b
          .http('post', '/board/meetings', by.token, {
            kind: 'regular',
            title: 'A meeting',
            scheduledAt: inHours(24),
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  const hold = (by: Who, id: string, present: string[]) =>
    b.http('post', `/board/meetings/${id}/hold`, by.token, {
      presentMemberIds: present,
    });
  const meetingRow = (id: string) =>
    b.inTx(s.c, (tx) => tx.boardMeeting.findUniqueOrThrow({ where: { id } }));
  const attendance = (id: string) =>
    b.inTx(s.c, (tx) =>
      tx.boardMeetingAttendance.findMany({ where: { meetingId: id } }),
    );

  it('two holds at once: one records it, once; the other is refused', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await schedule(o(0));
      const [one, two] = await Promise.all([
        hold(o(0), id, [seatOf(o(0)), seatOf(o(1))]),
        hold(o(1), id, [seatOf(o(2))]),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      expect(code([one, two].find((x) => x.status === 409)!)).toBe(
        'BOARD_MEETING_NOT_SCHEDULED',
      );
      const row = await meetingRow(id);
      const rows = await attendance(id);
      expect(rows).toHaveLength(row.seatedCount!);
      expect(rows.filter((r) => r.present)).toHaveLength(row.presentCount!);
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'board_meeting.held',
          targetId: id,
        }),
      ).toHaveLength(1);
    }
  });

  it('a seat ended while the meeting is held: the attendance is the board before or after, and says which', async () => {
    // Rounds end o(5), then o(4), then o(3): six seats, then five, four.
    for (const leaving of [o(5), o(4), o(3)]) {
      const id = await schedule(o(0));
      const seat = seatOf(leaving);
      const [held, ended] = await Promise.all([
        hold(o(0), id, [seatOf(o(0))]),
        b.http(
          'post',
          `/staff/governance/board/members/${seat}/end`,
          s.manager.token,
          { reasonCode: 'resigned' },
        ),
      ]);
      // The leaving member was not marked present: either order holds.
      expect(held.status).toBe(200);
      expect(ended.status).toBe(200);
      const row = await meetingRow(id);
      const rows = await attendance(id);
      expect(rows).toHaveLength(row.seatedCount!);
      const counted = rows.some((r) => r.memberId === seat);
      const seatRow = await b.inTx(s.c, (tx) =>
        tx.boardMember.findUniqueOrThrow({ where: { id: seat } }),
      );
      // Counted only if the hold went first: dated no later than the end.
      if (counted)
        expect(row.heldAt!.getTime()).toBeLessThanOrEqual(
          seatRow.endedAt!.getTime(),
        );
      else
        expect(row.heldAt!.getTime()).toBeGreaterThanOrEqual(
          seatRow.endedAt!.getTime(),
        );
    }
  });

  it('an action item marked done while it is cancelled: one of the two, once', async () => {
    const id = await schedule(o(0));
    await hold(o(0), id, [seatOf(o(0)), seatOf(o(1))]).expect(200);
    for (let round = 0; round < ROUNDS; round++) {
      const action = (
        (
          await b
            .http('post', `/board/meetings/${id}/actions`, o(0).token, {
              title: `Item ${round}`,
              ownerAccountId: o(1).id,
              dueOn: day(7),
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      const [done, cancelled] = await Promise.all([
        b.http('post', `/board/meeting-actions/${action}/done`, o(1).token, {}),
        b.http('post', `/board/meeting-actions/${action}/cancel`, o(2).token, {
          reasonCode: 'not_needed',
        }),
      ]);
      expect([done.status, cancelled.status].sort()).toEqual([200, 409]);
      const row = await b.inTx(s.c, (tx) =>
        tx.boardMeetingAction.findUniqueOrThrow({ where: { id: action } }),
      );
      expect(row.status).toBe(done.status === 200 ? 'done' : 'cancelled');
      const audited = [
        ...(await read.tenant(s.c.tenantId, {
          action: 'board_meeting_action.done',
          targetId: action,
        })),
        ...(await read.tenant(s.c.tenantId, {
          action: 'board_meeting_action.cancelled',
          targetId: action,
        })),
      ];
      expect(audited).toHaveLength(1);
    }
  });
});
