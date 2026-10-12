import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { ESCALATION_SWEEP } from '../../src/management/requests/escalation.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  managementHelpers,
  type ManagementSetUp,
  type Who,
} from '../setup/management';

const HOUR = 3_600_000;

/**
 * ADR 0039 (the rule of ADR 0038): a request is escalated only when its
 * response is overdue, and at most once per cycle. A cycle starts when the
 * request is opened or reopened; its clock stops at the first staff
 * response.
 *
 * Nothing here waits or measures time: the sweep is run with the instant a
 * test names, taken from the request's own due time, and every assertion is
 * on rows — how many escalations a cycle has, never how long anything took.
 */
describe('Management requests — escalation', () => {
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

  const row = (id: string) =>
    m.x.asManager(s.c, () =>
      m.x.prisma.tenant.managementRequest.findUniqueOrThrow({ where: { id } }),
    );
  const escalations = (id: string) =>
    m.x.asManager(s.c, () =>
      m.x.prisma.tenant.managementRequestEscalation.findMany({
        where: { requestId: id },
        orderBy: { cycle: 'asc' },
      }),
    );
  const staff = (id: string, action: string, body?: object, who = handler) =>
    m.http('post', `/management/requests/${id}/${action}`, who.token, body);
  const mine = (id: string, action: string, body?: object) =>
    m.http('post', `/management-requests/${id}/${action}`, s.owner.token, body);
  /** The instant `ms` after the request's cycle is due. */
  const afterDue = async (id: string, ms = 0) =>
    new Date((await row(id)).responseDueAt.getTime() + ms);
  const run = (now: Date) => sweep.run(ESCALATION_SWEEP, now);

  it('only when overdue: not a millisecond before the due time, and from it on', async () => {
    const { id } = await m.open(s.c, s.owner);
    await run(await afterDue(id, -1));
    expect(await escalations(id)).toEqual([]);
    expect((await row(id)).escalatedAt).toBeNull();

    const now = await afterDue(id);
    await run(now);
    const request = await row(id);
    expect(await escalations(id)).toEqual([
      {
        id: expect.any(String) as string,
        tenantId: s.c.tenantId,
        requestId: id,
        cycle: 1,
        dueAt: request.responseDueAt,
        createdAt: now,
      },
    ]);
    expect(request.escalatedAt).toEqual(now);
    // The resident's ordering is not moved by an escalation.
    expect(request.lastActivityAt).toEqual(request.createdAt);
    expect(request.status).toBe('open');
  });

  it('at most once per cycle: later runs, and two runs at once, add nothing', async () => {
    const { id } = await m.open(s.c, s.owner);
    const now = await afterDue(id, HOUR);
    await Promise.all([run(now), run(now)]);
    await run(new Date(now.getTime() + HOUR));
    await run(new Date(now.getTime() + 100 * HOUR));
    const rows = await escalations(id);
    expect(rows.map((e) => e.cycle)).toEqual([1]);
    expect((await row(id)).escalatedAt).toEqual(rows[0].createdAt);
    const audits = await m.x.asManager(s.c, () =>
      m.x.prisma.tenant.auditLog.findMany({
        where: { action: 'management_request.escalated', targetId: id },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'system', actorId: null });
  });

  it.each([
    ['a reply', (id: string) => staff(id, 'messages', { body: 'On it' })],
    [
      'the official reply',
      (id: string) => staff(id, 'messages', { body: 'Done', official: true }),
    ],
    ['taking it in hand', (id: string) => staff(id, 'start')],
  ])(
    'the clock stops at the first staff response (%s): never escalated after',
    async (_what, respond) => {
      const { id } = await m.open(s.c, s.owner);
      const res = await respond(id);
      expect(res.status).toBeLessThan(300);
      expect((await row(id)).firstResponseAt).not.toBeNull();
      await run(await afterDue(id, 1000 * HOUR));
      expect(await escalations(id)).toEqual([]);
    },
  );

  it('a staff note is not a response, and the author’s own message is not either', async () => {
    const { id } = await m.open(s.c, s.owner);
    await staff(id, 'messages', { body: 'Looks hard', internal: true }).expect(
      201,
    );
    await mine(id, 'messages', { body: 'Anyone there?' }).expect(201);
    await staff(id, 'assign', { assigneeId: handler.id }, s.manager).expect(
      204,
    );
    expect((await row(id)).firstResponseAt).toBeNull();
    await run(await afterDue(id));
    expect((await escalations(id)).map((e) => e.cycle)).toEqual([1]);
  });

  it('a request opened on behalf waits for a response like any other', async () => {
    const res = await m
      .http('post', '/management/requests', s.manager.token, {
        type: 'general',
        topicId: await m.topicId(s.c),
        authorAccountId: s.owner.id,
        reasonCode: 'resident_phone_call',
        body: 'Asked by phone',
      })
      .expect(201);
    const { id } = res.body as { id: string };
    await run(await afterDue(id));
    expect((await escalations(id)).map((e) => e.cycle)).toEqual([1]);
  });

  it('a closed or withdrawn request is never escalated, however late', async () => {
    const closed = await m.open(s.c, s.owner);
    await staff(closed.id, 'close', { reasonCode: 'duplicate' }).expect(204);
    const withdrawn = await m.open(s.c, s.owner);
    await mine(withdrawn.id, 'withdraw').expect(204);
    await run(await afterDue(closed.id, 1000 * HOUR));
    expect(await escalations(closed.id)).toEqual([]);
    expect(await escalations(withdrawn.id)).toEqual([]);
  });

  it('a response after the escalation keeps the escalation, and adds none', async () => {
    const { id } = await m.open(s.c, s.owner);
    const now = await afterDue(id);
    await run(now);
    await staff(id, 'messages', { body: 'Sorry for the wait' }).expect(201);
    await run(new Date(now.getTime() + 1000 * HOUR));
    expect((await escalations(id)).map((e) => e.cycle)).toEqual([1]);
    expect((await row(id)).escalatedAt).toEqual(now);
  });

  it('a reopened request starts a new cycle that can be escalated once more', async () => {
    const { id } = await m.open(s.c, s.owner);
    await run(await afterDue(id));
    await staff(id, 'close', { reasonCode: 'resolved' }).expect(204);
    await mine(id, 'reopen', { body: 'Not resolved' }).expect(204);
    const reopened = await row(id);
    expect(reopened).toMatchObject({ cycle: 2, escalatedAt: null });

    // The old cycle's due time has long passed: the new one's has not.
    await run(new Date(reopened.responseDueAt.getTime() - 1));
    expect((await escalations(id)).map((e) => e.cycle)).toEqual([1]);

    const now = await afterDue(id);
    await run(now);
    await run(new Date(now.getTime() + HOUR));
    const rows = await escalations(id);
    expect(rows.map((e) => [e.cycle, e.createdAt])).toEqual([
      [1, rows[0].createdAt],
      [2, now],
    ]);
    expect(rows[1].dueAt).toEqual(reopened.responseDueAt);
    expect((await row(id)).escalatedAt).toEqual(now);
  });

  it('a cycle that was answered in time is never escalated, and its reopening counts from its own start', async () => {
    const { id } = await m.open(s.c, s.owner);
    await staff(id, 'messages', { body: 'Answer', official: true }).expect(201);
    await staff(id, 'close', { reasonCode: 'resolved' }).expect(204);
    await mine(id, 'reopen', { body: 'One more' }).expect(204);
    await staff(id, 'messages', { body: 'Second answer' }).expect(201);
    await run(await afterDue(id, 1000 * HOUR));
    expect(await escalations(id)).toEqual([]);
  });

  it('each topic’s target decides when: a shorter one is overdue first', async () => {
    const fast = await m.open(s.c, s.owner, {
      topicId: await m.topicId(s.c, 'security_gate'),
    });
    const slow = await m.open(s.c, s.owner, {
      topicId: await m.topicId(s.c, 'facilities'),
    });
    const [fastRow, slowRow] = [await row(fast.id), await row(slow.id)];
    expect(
      fastRow.responseDueAt.getTime() - fastRow.cycleStartedAt.getTime(),
    ).toBe(24 * HOUR);
    expect(
      slowRow.responseDueAt.getTime() - slowRow.cycleStartedAt.getTime(),
    ).toBe(72 * HOUR);
    await run(await afterDue(fast.id));
    expect((await escalations(fast.id)).map((e) => e.cycle)).toEqual([1]);
    expect(await escalations(slow.id)).toEqual([]);
  });

  it('staff see overdue and escalated in the inbox and on the request; the author sees neither', async () => {
    // Overdue by the database's own clock: the cycle is written into the past.
    const { id } = await m.open(s.c, s.owner);
    const late = await m.x.asManager(s.c, () =>
      m.x.prisma.tenant.managementRequest.update({
        where: { id },
        data: {
          cycleStartedAt: new Date(Date.now() - 50 * HOUR),
          responseDueAt: new Date(Date.now() - 2 * HOUR),
        },
      }),
    );
    const ids = async (query: string) =>
      (
        (
          await m
            .http(
              'get',
              `/management/requests?${query}&limit=100`,
              handler.token,
            )
            .expect(200)
        ).body as { data: { id: string }[] }
      ).data.map((r) => r.id);
    expect(await ids('overdue=true')).toContain(id);
    expect(await ids('escalated=true')).not.toContain(id);

    const now = new Date();
    await run(now);
    expect(await ids('escalated=true')).toContain(id);
    const detail = await m
      .http('get', `/management/requests/${id}`, handler.token)
      .expect(200);
    expect(detail.body).toMatchObject({
      overdue: true,
      escalatedAt: now.toISOString(),
      escalations: [
        {
          cycle: 1,
          dueAt: late.responseDueAt.toISOString(),
          escalatedAt: now.toISOString(),
        },
      ],
    });
    const mineView = await m
      .http('get', `/management-requests/${id}`, s.owner.token)
      .expect(200);
    for (const key of ['overdue', 'escalatedAt', 'escalations'])
      expect(mineView.body).not.toHaveProperty(key);

    // A response ends "overdue"; "escalated" stays for the cycle.
    await staff(id, 'start').expect(204);
    expect(await ids('overdue=true')).not.toContain(id);
    expect(await ids('escalated=true')).toContain(id);
  });
});
