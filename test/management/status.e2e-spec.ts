import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { AUTO_CLOSE_SWEEP } from '../../src/management/requests/lifecycle.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  managementHelpers,
  type ManagementSetUp,
  type Who,
} from '../setup/management';

const DAY = 86_400_000;

/**
 * ADR 0039: open → in_progress → answered → closed. Staff take a request
 * in hand and close it; the author withdraws it, or reopens it within
 * seven days into a new cycle; an answered request nobody replies to
 * closes itself after the compound's `autoCloseDays`.
 *
 * Time is never waited for: the sweep is run with the `now` a test names,
 * and "a week ago" is written on the row.
 */
describe('Management requests — status, reopening and auto-close', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof managementHelpers>;
  let s: ManagementSetUp;
  let handler: Who;
  let sweep: SweepRunner;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = managementHelpers(h);
    s = await m.setUp();
    handler = await m.handler(s.c);
    sweep = h.moduleRef.get(SweepRunner);
  }, 120_000);

  afterAll(() => h.close());

  const row = (id: string, c = s.c) =>
    m.x.asManager(c, () =>
      m.x.prisma.tenant.managementRequest.findUniqueOrThrow({ where: { id } }),
    );
  const staff = (id: string, action: string, body?: object, who = handler) =>
    m.http('post', `/management/requests/${id}/${action}`, who.token, body);
  const mine = (id: string, action: string, body?: object, who = s.owner) =>
    m.http('post', `/management-requests/${id}/${action}`, who.token, body);
  const answer = (id: string, who = handler) =>
    staff(
      id,
      'messages',
      { body: 'Here is the answer', official: true },
      who,
    ).expect(201);
  const refused = (res: { body: unknown }, status: string) =>
    expect(res.body).toMatchObject({
      code: 'MANAGEMENT_REQUEST_INVALID_TRANSITION',
      params: { status },
    });

  describe('taking in hand', () => {
    it('start moves an open request to in_progress and counts as the response; once', async () => {
      const { id } = await m.open(s.c, s.owner);
      await staff(id, 'start').expect(204);
      const started = await row(id);
      expect(started.status).toBe('in_progress');
      expect(started.firstResponseAt).toEqual(started.lastActivityAt);
      refused(await staff(id, 'start').expect(409), 'in_progress');
      expect((await row(id)).firstResponseAt).toEqual(started.firstResponseAt);
    });

    it('a resident cannot start, close or reply as staff', async () => {
      const { id } = await m.open(s.c, s.owner);
      await staff(id, 'start', undefined, s.owner).expect(403);
      await staff(id, 'close', { reasonCode: 'resolved' }, s.owner).expect(403);
      expect((await row(id)).status).toBe('open');
    });
  });

  describe('closing', () => {
    it('staff close from any live status, with a reason from the list', async () => {
      for (const prepare of [
        () => Promise.resolve(),
        async (id: string) => void (await staff(id, 'start').expect(204)),
        async (id: string) => void (await answer(id)),
      ]) {
        const { id } = await m.open(s.c, s.owner);
        await prepare(id);
        await staff(id, 'close', { reasonCode: 'duplicate' }).expect(204);
        const closed = await row(id);
        expect(closed).toMatchObject({
          status: 'closed',
          closeReason: 'duplicate',
          closedBySide: 'staff',
        });
        expect(closed.closedAt).toEqual(closed.lastActivityAt);
        refused(
          await staff(id, 'close', { reasonCode: 'resolved' }).expect(409),
          'closed',
        );
      }
    });

    it('the reason is required and closed: the system’s own codes are not staff’s to give', async () => {
      const { id } = await m.open(s.c, s.owner);
      for (const reasonCode of [
        'auto_closed',
        'withdrawn_by_author',
        'bored',
      ]) {
        const res = await staff(id, 'close', { reasonCode }).expect(400);
        expect(res.body).toMatchObject({
          fields: [
            {
              field: 'reasonCode',
              code: 'INVALID_REASON_CODE',
              params: {
                allowed: [
                  'resolved',
                  'duplicate',
                  'not_for_management',
                  'other',
                ],
              },
            },
          ],
        });
      }
      await staff(id, 'close', {}).expect(400);
      expect((await row(id)).status).toBe('open');
    });

    it('the author sees why it closed and until when it can be reopened', async () => {
      const { id } = await m.open(s.c, s.owner);
      await staff(id, 'close', { reasonCode: 'not_for_management' }).expect(
        204,
      );
      const res = await m
        .http('get', `/management-requests/${id}`, s.owner.token)
        .expect(200);
      const body = res.body as {
        closedAt: string;
        reopenUntil: string;
        closeReason: string;
        responseDueAt: string | null;
      };
      expect(body).toMatchObject({
        status: 'closed',
        closeReason: 'not_for_management',
        responseDueAt: null,
      });
      expect(
        new Date(body.reopenUntil).getTime() -
          new Date(body.closedAt).getTime(),
      ).toBe(7 * DAY);
    });
  });

  describe('withdrawing', () => {
    it('the author withdraws from any live status: closed, by the resident, with the system’s reason', async () => {
      for (const prepare of [
        () => Promise.resolve(),
        async (id: string) => void (await staff(id, 'start').expect(204)),
        async (id: string) => void (await answer(id)),
      ]) {
        const { id } = await m.open(s.c, s.owner);
        await prepare(id);
        await mine(id, 'withdraw').expect(204);
        expect(await row(id)).toMatchObject({
          status: 'closed',
          closeReason: 'withdrawn_by_author',
          closedBySide: 'resident',
        });
        refused(await mine(id, 'withdraw').expect(409), 'closed');
      }
    });

    it('only the author: anyone else finds no such request, and staff have no such route', async () => {
      const { id } = await m.open(s.c, s.owner);
      const other = await m.setUp();
      await mine(id, 'withdraw', undefined, other.owner).expect(404);
      await mine(id, 'withdraw', undefined, handler).expect(403);
      expect((await row(id)).status).toBe('open');
    });
  });

  describe('reopening', () => {
    const closed = async (how: 'staff' | 'withdrawn' = 'staff') => {
      const { id } = await m.open(s.c, s.owner);
      await staff(id, 'assign', { assigneeId: handler.id }, s.manager).expect(
        204,
      );
      await answer(id);
      if (how === 'staff')
        await staff(id, 'close', { reasonCode: 'resolved' }).expect(204);
      else await mine(id, 'withdraw').expect(204);
      return id;
    };

    it.each(['staff', 'withdrawn'] as const)(
      'a request closed by %s reopens into a new cycle: open, a fresh clock, the same handler',
      async (how) => {
        const id = await closed(how);
        const before = await row(id);
        await mine(id, 'reopen', { body: 'It happened again' }).expect(204);
        const after = await row(id);
        expect(after).toMatchObject({
          status: 'open',
          cycle: 2,
          firstResponseAt: null,
          escalatedAt: null,
          answeredAt: null,
          closedAt: null,
          closeReason: null,
          closedBySide: null,
          assigneeId: handler.id,
        });
        expect(after.cycleStartedAt.getTime()).toBeGreaterThan(
          before.cycleStartedAt.getTime(),
        );
        // The general topic's 48 hours, from the reopening.
        expect(
          after.responseDueAt.getTime() - after.cycleStartedAt.getTime(),
        ).toBe(48 * 3_600_000);
        expect(after.lastActivityAt).toEqual(after.cycleStartedAt);
        // Why is a message, in the new cycle.
        const thread = await m.x.asManager(s.c, () =>
          m.x.prisma.tenant.managementRequestMessage.findMany({
            where: { requestId: id },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { body: true, cycle: true, senderSide: true },
          }),
        );
        expect(thread.at(-1)).toEqual({
          body: 'It happened again',
          cycle: 2,
          senderSide: 'resident',
        });
        // And the new cycle is answered like the first.
        await answer(id);
        const answered = await row(id);
        expect(answered.status).toBe('answered');
        expect(answered.firstResponseAt).not.toBeNull();
      },
    );

    it('the new cycle takes the topic’s target as it is now', async () => {
      const id = await closed();
      const topicId = await m.topicId(s.c);
      await m
        .http(
          'patch',
          `/management/request-topics/${topicId}`,
          s.manager.token,
          {
            targetResponseHours: 5,
          },
        )
        .expect(200);
      // The closed cycle keeps the due time it had.
      const before = await row(id);
      expect(
        before.responseDueAt.getTime() - before.cycleStartedAt.getTime(),
      ).toBe(48 * 3_600_000);
      await mine(id, 'reopen', { body: 'Again' }).expect(204);
      const after = await row(id);
      expect(
        after.responseDueAt.getTime() - after.cycleStartedAt.getTime(),
      ).toBe(5 * 3_600_000);
      await m
        .http(
          'patch',
          `/management/request-topics/${topicId}`,
          s.manager.token,
          {
            targetResponseHours: 48,
          },
        )
        .expect(200);
    });

    it('seven days from the close, to the instant; after that it is too late', async () => {
      const id = await closed();
      const setClosedAt = (closedAt: Date) =>
        m.x.asManager(s.c, () =>
          m.x.prisma.tenant.managementRequest.update({
            where: { id },
            data: { closedAt },
          }),
        );
      // A second past the window.
      await setClosedAt(new Date(Date.now() - 7 * DAY - 1000));
      const res = await mine(id, 'reopen', { body: 'Too late' }).expect(409);
      expect(res.body).toMatchObject({
        code: 'MANAGEMENT_REQUEST_REOPEN_WINDOW_PASSED',
        params: { reopenDays: 7 },
      });
      expect((await row(id)).status).toBe('closed');
      // An hour inside it.
      await setClosedAt(new Date(Date.now() - 7 * DAY + 3_600_000));
      await mine(id, 'reopen', { body: 'Just in time' }).expect(204);
      expect((await row(id)).status).toBe('open');
    });

    it('needs its reason, a closed request, and its author', async () => {
      const id = await closed();
      const empty = await mine(id, 'reopen', { body: '  ' }).expect(400);
      expect(empty.body).toMatchObject({
        fields: [{ field: 'body', code: 'INVALID_LENGTH' }],
      });
      const other = await m.setUp();
      await mine(id, 'reopen', { body: 'Not mine' }, other.owner).expect(404);
      await mine(id, 'reopen', { body: 'As staff' }, handler).expect(403);
      expect((await row(id)).status).toBe('closed');
      const live = await m.open(s.c, s.owner);
      refused(
        await mine(live.id, 'reopen', { body: 'Not closed' }).expect(409),
        'open',
      );
    });
  });

  describe('auto-close', () => {
    const answeredAt = async (id: string) => (await row(id)).answeredAt!;

    it('an answered request closes itself after the compound’s days, not a moment before', async () => {
      const { id } = await m.open(s.c, s.owner);
      await answer(id);
      const at = await answeredAt(id);
      // The default: seven days.
      await sweep.run(AUTO_CLOSE_SWEEP, new Date(at.getTime() + 7 * DAY - 1));
      expect((await row(id)).status).toBe('answered');
      const now = new Date(at.getTime() + 7 * DAY);
      await sweep.run(AUTO_CLOSE_SWEEP, now);
      expect(await row(id)).toMatchObject({
        status: 'closed',
        closeReason: 'auto_closed',
        closedBySide: 'system',
        closedAt: now,
        lastActivityAt: now,
      });
    });

    it('run again, and on two instances at once, it closes a request once', async () => {
      const { id } = await m.open(s.c, s.owner);
      await answer(id);
      const now = new Date((await answeredAt(id)).getTime() + 8 * DAY);
      await Promise.all([
        sweep.run(AUTO_CLOSE_SWEEP, now),
        sweep.run(AUTO_CLOSE_SWEEP, now),
      ]);
      await sweep.run(AUTO_CLOSE_SWEEP, new Date(now.getTime() + DAY));
      expect((await row(id)).closedAt).toEqual(now);
      const audits = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.auditLog.findMany({
          where: { action: 'management_request.auto_closed', targetId: id },
        }),
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorType: 'system', actorId: null });
    });

    it('the author’s reply stops it: only an answered request waits', async () => {
      const { id } = await m.open(s.c, s.owner);
      await answer(id);
      const at = await answeredAt(id);
      await mine(id, 'messages', { body: 'One more thing' }).expect(201);
      await sweep.run(AUTO_CLOSE_SWEEP, new Date(at.getTime() + 30 * DAY));
      expect((await row(id)).status).toBe('in_progress');
      // Open and in-progress requests never close by themselves.
      const waiting = await m.open(s.c, s.owner);
      await sweep.run(AUTO_CLOSE_SWEEP, new Date(Date.now() + 365 * DAY));
      expect((await row(waiting.id)).status).toBe('open');
    });

    it('a new official reply starts the wait over', async () => {
      const { id } = await m.open(s.c, s.owner);
      await answer(id);
      const first = await answeredAt(id);
      await answer(id, s.manager);
      const second = await answeredAt(id);
      expect(second.getTime()).toBeGreaterThan(first.getTime());
      await sweep.run(
        AUTO_CLOSE_SWEEP,
        new Date(second.getTime() + 7 * DAY - 1),
      );
      expect((await row(id)).status).toBe('answered');
    });

    it('each compound waits its own days', async () => {
      const other = await m.setUp();
      await m
        .http('patch', '/management/request-settings', other.manager.token, {
          autoCloseDays: 2,
        })
        .expect(200);
      const theirs = await m.open(other.c, other.owner);
      await m
        .http(
          'post',
          `/management/requests/${theirs.id}/messages`,
          other.manager.token,
          { body: 'Answer', official: true },
        )
        .expect(201);
      const ours = await m.open(s.c, s.owner);
      await answer(ours.id);
      const base = Math.max(
        (await row(theirs.id, other.c)).answeredAt!.getTime(),
        (await answeredAt(ours.id)).getTime(),
      );
      await sweep.run(AUTO_CLOSE_SWEEP, new Date(base + 3 * DAY));
      expect((await row(theirs.id, other.c)).status).toBe('closed');
      expect((await row(ours.id)).status).toBe('answered');
    });

    it('an auto-closed request reopens within seven days like any other', async () => {
      const { id } = await m.open(s.c, s.owner);
      await answer(id);
      // Closed "now" by the sweep's own clock, so the window is open.
      await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementRequest.update({
          where: { id },
          data: { answeredAt: new Date(Date.now() - 8 * DAY) },
        }),
      );
      await sweep.run(AUTO_CLOSE_SWEEP, new Date());
      expect((await row(id)).closeReason).toBe('auto_closed');
      await mine(id, 'reopen', { body: 'I was away' }).expect(204);
      expect(await row(id)).toMatchObject({ status: 'open', cycle: 2 });
    });
  });
});
