import { newId } from '../../src/core/common/uuid';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

/**
 * ADR 0032: ticket creation (both routes) and message posts honour
 * `Idempotency-Key` (ADR 0028). A retry replays the first answer and writes
 * once — one ticket or message, one round of notices; the same key for
 * another body is 409 IDEMPOTENCY_CONFLICT.
 */
describe('Maintenance — idempotent writes', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let dispatchers: string[];

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    dispatchers = [s.c.managerId, s.supervisor.id].sort();
  }, 90_000);

  afterAll(() => h.close());

  const key = () => `k-${newId()}`;

  const post = (path: string, token: string, body: object, k: string) =>
    d.http('post', path, token, body).set('Idempotency-Key', k);

  /**
   * Sends twice with one key, then once with that key and another body.
   * `written` (notices, say) is the same after the first send as at the end.
   */
  async function replayed(
    path: string,
    token: string,
    body: object,
    other: object,
    written: () => Promise<number> = () => Promise.resolve(0),
  ): Promise<{ id: string }> {
    const k = key();
    const first = await post(path, token, body, k).expect(201);
    const once = await written();
    const again = await post(path, token, body, k).expect(201);
    expect(again.body).toEqual(first.body);
    const conflict = await post(path, token, other, k).expect(409);
    expect((conflict.body as { code: string }).code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(await written()).toBe(once);
    return first.body as { id: string };
  }

  const notices = (ticketId: string, kind: string) =>
    d.inTenant(s.c, async (tx) =>
      (await tx.notification.findMany({ where: { targetId: ticketId, kind } }))
        .map((n) => n.accountId)
        .sort(),
    );

  const ticketBody = async (description: string, extra: object = {}) => ({
    unitId: s.unit.id,
    categoryId: await d.categoryId(s.c, 'general'),
    description,
    ...extra,
  });

  it('POST /tickets: one ticket, one emergency notice per dispatcher', async () => {
    const description = `Idempotent ${newId()}`;
    const created = await replayed(
      '/tickets',
      s.owner.token,
      await ticketBody(description, { priority: 'emergency' }),
      await ticketBody(`${description} again`, { priority: 'emergency' }),
    );
    const rows = await d.inTenant(s.c, (tx) =>
      tx.ticket.findMany({
        where: { description: { startsWith: description } },
      }),
    );
    expect(rows.map((t) => t.id)).toEqual([created.id]);
    expect(await notices(created.id, 'ticket.emergency')).toEqual(dispatchers);
  });

  it('POST /maintenance/tickets (on behalf): one ticket, the reporter told once', async () => {
    const description = `On behalf ${newId()}`;
    const created = await replayed(
      '/maintenance/tickets',
      s.supervisor.token,
      await ticketBody(description, { reporterAccountId: s.owner.id }),
      await ticketBody(`${description} again`, {
        reporterAccountId: s.owner.id,
      }),
    );
    const rows = await d.inTenant(s.c, (tx) =>
      tx.ticket.findMany({
        where: { description: { startsWith: description } },
      }),
    );
    expect(rows.map((t) => t.id)).toEqual([created.id]);
    expect(await notices(created.id, 'ticket.opened_on_behalf')).toEqual([
      s.owner.id,
    ]);
  });

  it('message posts, on each route: one message, one notice per reader', async () => {
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: s.techs[0].id,
      })
      .expect(204);
    for (const [path, token] of [
      [`/tickets/${id}/messages`, s.owner.token],
      [`/technician/tickets/${id}/messages`, s.techs[0].token],
      [`/maintenance/tickets/${id}/messages`, s.supervisor.token],
    ] as const) {
      const body = `Once ${newId()}`;
      const before = (await notices(id, 'ticket.message')).length;
      const count = async () => (await notices(id, 'ticket.message')).length;
      const posted = await replayed(
        path,
        token,
        { body },
        { body: `${body}!` },
        count,
      );
      const rows = await d.inTenant(s.c, (tx) =>
        tx.ticketMessage.findMany({
          where: { ticketId: id, body: { startsWith: body } },
        }),
      );
      expect(rows.map((m) => m.id)).toEqual([posted.id]);
      // The readers were told by the first post, and only by it.
      expect(await count()).toBeGreaterThan(before);
    }
  });
});
