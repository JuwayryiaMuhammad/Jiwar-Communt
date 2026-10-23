import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { NOTIFICATION_KINDS } from '../../src/core/notifications/kinds';
import { ESCALATION_SWEEP } from '../../src/management/requests/escalation.service';
import { AUTO_CLOSE_SWEEP } from '../../src/management/requests/lifecycle.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  managementHelpers,
  type ManagementSetUp,
  type Who,
} from '../setup/management';

// eslint-disable-next-line no-restricted-syntax -- a real 24 h: auto-close and escalation are in ms
const DAY = 86_400_000;
/** Planted in everything anyone types: no notification may carry it. */
const MARKER = 'NOTICE-FREE-TEXT';

/**
 * ADR 0039: who is told what. Every notification of a request is an inbox
 * row of category `management`, never critical, whose params are the
 * request number and the topic's key and nothing else.
 */
describe('Management requests — notifications', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof managementHelpers>;
  let s: ManagementSetUp;
  let handler: Who;
  let second: Who;
  let sweep: SweepRunner;
  let topicId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = managementHelpers(h);
    s = await m.setUp();
    handler = await m.handler(s.c);
    second = await m.handler(s.c);
    sweep = h.moduleRef.get(SweepRunner);
    topicId = await m.topicId(s.c, 'billing_fees');
  }, 120_000);

  afterAll(() => h.close());

  /** The request's notifications as [kind, recipient], oldest first. */
  const told = async (id: string) =>
    (
      await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.notification.findMany({
          where: { targetId: id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      )
    ).map((n) => [n.kind, n.accountId] as const);
  /** What was told since `before` (a previous `told`), sorted. */
  const since = async (id: string, before: readonly unknown[]) =>
    (await told(id))
      .slice(before.length)
      .map(([kind, to]) => `${kind} → ${name(to)}`)
      .sort();
  const name = (id: string) =>
    id === s.owner.id
      ? 'author'
      : id === s.manager.id
        ? 'manager'
        : id === handler.id
          ? 'handler'
          : id === second.id
            ? 'second'
            : id;
  const staff = (id: string, action: string, body?: object, who = handler) =>
    m.http('post', `/management/requests/${id}/${action}`, who.token, body);
  const mine = (id: string, action: string, body?: object) =>
    m.http('post', `/management-requests/${id}/${action}`, s.owner.token, body);
  const open = async () =>
    (await m.open(s.c, s.owner, { topicId, body: `${MARKER} my bill` })).id;

  it('a new request is told to everyone who handles requests, never to its author', async () => {
    const id = await open();
    expect(await since(id, [])).toEqual([
      'management_request.created → handler',
      'management_request.created → manager',
      'management_request.created → second',
    ]);
  });

  it('opened on behalf: the author is told it was opened for them; the other handlers of the new request; never the one who opened it', async () => {
    const res = await m
      .http('post', '/management/requests', s.manager.token, {
        type: 'general',
        topicId,
        authorAccountId: s.owner.id,
        reasonCode: 'resident_phone_call',
        body: `${MARKER} asked by phone`,
      })
      .expect(201);
    expect(await since((res.body as { id: string }).id, [])).toEqual([
      'management_request.created → handler',
      'management_request.created → second',
      'management_request.opened_for_you → author',
    ]);
  });

  it('assigning tells the assignee, unless they took it themselves', async () => {
    const id = await open();
    let before = await told(id);
    await staff(id, 'assign', { assigneeId: handler.id }, s.manager).expect(
      204,
    );
    expect(await since(id, before)).toEqual([
      'management_request.assigned → handler',
    ]);
    before = await told(id);
    await staff(id, 'assign', { assigneeId: second.id }, second).expect(204);
    await staff(id, 'assign', { assigneeId: null }, second).expect(204);
    expect(await since(id, before)).toEqual([]);
  });

  it('the conversation: a reply tells the author; the author’s message tells the assignee, or every handler while unassigned; a note tells nobody', async () => {
    const id = await open();
    let before = await told(id);
    await mine(id, 'messages', { body: `${MARKER} hello?` }).expect(201);
    expect(await since(id, before)).toEqual([
      'management_request.resident_replied → handler',
      'management_request.resident_replied → manager',
      'management_request.resident_replied → second',
    ]);

    before = await told(id);
    await staff(id, 'messages', { body: `${MARKER} on it` }).expect(201);
    expect(await since(id, before)).toEqual([
      'management_request.replied → author',
    ]);

    before = await told(id);
    await staff(id, 'messages', {
      body: `${MARKER} note`,
      internal: true,
    }).expect(201);
    expect(await since(id, before)).toEqual([]);

    await staff(id, 'assign', { assigneeId: second.id }, s.manager).expect(204);
    before = await told(id);
    await mine(id, 'messages', { body: `${MARKER} thanks` }).expect(201);
    expect(await since(id, before)).toEqual([
      'management_request.resident_replied → second',
    ]);

    // The official reply is one notice, not two.
    before = await told(id);
    await staff(id, 'messages', {
      body: `${MARKER} answer`,
      official: true,
    }).expect(201);
    expect(await since(id, before)).toEqual([
      'management_request.replied → author',
    ]);
  });

  it('status: taking in hand and closing tell the author; withdrawing tells the assignee, or nobody; reopening tells whoever handles it', async () => {
    const id = await open();
    let before = await told(id);
    await staff(id, 'start').expect(204);
    expect(await since(id, before)).toEqual([
      'management_request.status_changed → author',
    ]);

    before = await told(id);
    await staff(id, 'close', { reasonCode: 'resolved' }).expect(204);
    expect(await since(id, before)).toEqual([
      'management_request.status_changed → author',
    ]);

    before = await told(id);
    await mine(id, 'reopen', { body: `${MARKER} not resolved` }).expect(204);
    expect(await since(id, before)).toEqual([
      'management_request.reopened → handler',
      'management_request.reopened → manager',
      'management_request.reopened → second',
    ]);

    // Unassigned: a withdrawal tells nobody.
    before = await told(id);
    await mine(id, 'withdraw').expect(204);
    expect(await since(id, before)).toEqual([]);

    await mine(id, 'reopen', { body: `${MARKER} again` }).expect(204);
    await staff(id, 'assign', { assigneeId: handler.id }, s.manager).expect(
      204,
    );
    before = await told(id);
    await mine(id, 'withdraw').expect(204);
    expect(await since(id, before)).toEqual([
      'management_request.withdrawn → handler',
    ]);
    // Reopened while assigned: the assignee alone.
    before = await told(id);
    await mine(id, 'reopen', { body: `${MARKER} once more` }).expect(204);
    expect(await since(id, before)).toEqual([
      'management_request.reopened → handler',
    ]);
  });

  it('the sweeps: auto-close tells the author; escalation tells whoever holds requests.manage, once', async () => {
    const answered = await open();
    await staff(answered, 'messages', {
      body: 'Answer',
      official: true,
    }).expect(201);
    let before = await told(answered);
    await sweep.run(AUTO_CLOSE_SWEEP, new Date(Date.now() + 8 * DAY));
    expect(await since(answered, before)).toEqual([
      'management_request.auto_closed → author',
    ]);

    const waiting = await open();
    before = await told(waiting);
    const due = (
      await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementRequest.findUniqueOrThrow({
          where: { id: waiting },
        }),
      )
    ).responseDueAt;
    await sweep.run(ESCALATION_SWEEP, due);
    await sweep.run(ESCALATION_SWEEP, new Date(due.getTime() + DAY));
    // The handlers do not hold requests.manage: only the manager is told.
    expect(await since(waiting, before)).toEqual([
      'management_request.escalated → manager',
    ]);
  });

  it('appointments: each side is told what the other did', async () => {
    const slots = (await m.slots(s.owner, 31)).map((x) => x.startsAt);
    const res = await m.book(s.c, s.owner, slots[0], topicId).expect(201);
    const { id } = res.body as { id: string };
    // Booked with the request: the "new request" notice covers it.
    expect(await since(id, [])).toEqual([
      'management_request.created → handler',
      'management_request.created → manager',
      'management_request.created → second',
    ]);
    const step = async (act: () => Promise<unknown>) => {
      const before = await told(id);
      await act();
      return since(id, before);
    };
    await staff(id, 'assign', { assigneeId: handler.id }, s.manager).expect(
      204,
    );

    expect(
      await step(() =>
        staff(id, 'appointment/propose', {
          startsAt: slots[1],
          mode: 'phone',
        }).expect(201),
      ),
    ).toEqual(['management_appointment.countered → author']);
    expect(
      await step(() => mine(id, 'appointment/accept').expect(204)),
    ).toEqual(['management_appointment.accepted → handler']);
    expect(
      await step(() =>
        mine(id, 'appointment', {
          startsAt: slots[2],
          mode: 'in_person',
        }).expect(201),
      ),
    ).toEqual(['management_appointment.requested → handler']);
    expect(
      await step(() => staff(id, 'appointment/confirm').expect(204)),
    ).toEqual(['management_appointment.confirmed → author']);
    expect(
      await step(() =>
        staff(id, 'appointment/cancel', { reasonCode: 'office_closed' }).expect(
          204,
        ),
      ),
    ).toEqual(['management_appointment.cancelled → author']);
    // No live appointment left: a slot from staff is a proposal, not a counter.
    expect(
      await step(() =>
        staff(id, 'appointment/propose', {
          startsAt: slots[3],
          mode: 'in_person',
        }).expect(201),
      ),
    ).toEqual(['management_appointment.proposed → author']);
    expect(
      await step(() =>
        mine(id, 'appointment/cancel', { reasonCode: 'cannot_attend' }).expect(
          204,
        ),
      ),
    ).toEqual(['management_appointment.cancelled_by_resident → handler']);
  });

  it('a rating tells nobody', async () => {
    const id = await open();
    await staff(id, 'close', { reasonCode: 'resolved' }).expect(204);
    const before = await told(id);
    await mine(id, 'rating', { rating: 1, comment: `${MARKER} slow` }).expect(
      201,
    );
    expect(await since(id, before)).toEqual([]);
  });

  it('an account that is not active is not told', async () => {
    const gone = await m.handler(s.c);
    await m.x.asManager(s.c, () =>
      m.x.prisma.tenant.account.update({
        where: { id: gone.id },
        data: { status: 'frozen' },
      }),
    );
    const id = await open();
    expect((await told(id)).map(([, to]) => to)).not.toContain(gone.id);
  });

  it('every notice is of category management, never critical, and says the request number and the topic key — nothing anyone typed', async () => {
    const rows = await m.x.asManager(s.c, () =>
      m.x.prisma.tenant.notification.findMany({
        where: { targetType: 'management_request' },
      }),
    );
    expect(rows.length).toBeGreaterThan(30);
    const kinds = new Set(rows.map((r) => r.kind));
    // Every kind of the phase was sent above.
    const all = Object.entries(NOTIFICATION_KINDS)
      .filter(([, spec]) => spec.category === 'management')
      .map(([kind]) => kind);
    expect([...kinds].sort()).toEqual(all.sort());
    expect(all).toHaveLength(17);
    for (const kind of all) {
      const spec = NOTIFICATION_KINDS[kind as keyof typeof NOTIFICATION_KINDS];
      expect(spec).toMatchObject({
        category: 'management',
        critical: false,
        priority: 'normal',
        target: 'management_request',
      });
      expect(Object.keys(spec.params).sort()).toEqual([
        'requestNumber',
        'topicKey',
      ]);
    }
    for (const row of rows) {
      expect(row.priority).toBe('normal');
      expect(row.params).toEqual({
        requestNumber: expect.stringMatching(/^MR-\d{6}$/) as string,
        topicKey: 'billing_fees',
      });
    }
    expect(JSON.stringify(rows)).not.toContain(MARKER);
  });

  it('the author reads theirs in the inbox, and only theirs', async () => {
    const res = await m
      .http('get', '/me/notifications?limit=100', s.owner.token)
      .expect(200);
    const { data } = res.body as {
      data: { kind: string; targetType: string; params: object }[];
    };
    const kinds = new Set(data.map((n) => n.kind));
    expect(kinds).toContain('management_request.replied');
    expect(kinds).not.toContain('management_request.created');
    expect(kinds).not.toContain('management_request.escalated');
    expect(JSON.stringify(data)).not.toContain(MARKER);
  });
});
