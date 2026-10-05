import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0034: a dispatcher corrects a ticket's category. The technician keeps
 * the ticket and is told, the dispatch engine does not run, and the
 * reporter sees the new category.
 */
describe('Maintenance — changing a ticket’s category', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
  }, 60_000);

  afterAll(() => h.close());

  const change = (
    id: string,
    categoryId: string,
    reasonCode = 'misclassified',
  ) =>
    d.http('post', `/maintenance/tickets/${id}/category`, s.supervisor.token, {
      categoryId,
      reasonCode,
    });

  async function assigned(): Promise<string> {
    const id = await d.openTicket(s, { category: 'general' });
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: s.techs[0].id,
      })
      .expect(204);
    return id;
  }

  const kinds = (accountId: string, ticketId: string) =>
    d.inTenant(s.c, async (tx) =>
      (
        await tx.notification.findMany({
          where: { accountId, targetId: ticketId },
          orderBy: { createdAt: 'asc' },
        })
      ).map((n) => ({ kind: n.kind, params: n.params })),
    );

  it('the technician keeps the ticket and is told; the engine does not run; the reporter sees it', async () => {
    const id = await assigned();
    const plumbing = await d.categoryId(s.c, 'plumbing');
    const attemptsBefore = await d.inTenant(s.c, (tx) =>
      tx.ticketDispatchAttempt.count({ where: { ticketId: id } }),
    );
    await change(id, plumbing).expect(204);
    const row = await d.ticketRow(s.c, id);
    expect(row).toMatchObject({
      categoryId: plumbing,
      status: 'assigned',
      technicianId: s.techs[0].id,
    });
    expect(
      await d.inTenant(s.c, (tx) =>
        tx.ticketDispatchAttempt.count({ where: { ticketId: id } }),
      ),
    ).toBe(attemptsBefore);
    expect(await kinds(s.techs[0].id, id)).toContainEqual({
      kind: 'ticket.category_changed',
      params: expect.objectContaining({ categoryKey: 'plumbing' }) as object,
    });
    const seen = await d
      .http('get', `/tickets/${id}`, s.owner.token)
      .expect(200);
    expect((seen.body as { category: { key: string } }).category.key).toBe(
      'plumbing',
    );
  });

  it('refuses the same category, a retired one, an unknown code and a closed ticket', async () => {
    const id = await assigned();
    const general = await d.categoryId(s.c, 'general');
    const same = await change(id, general).expect(400);
    expect((same.body as { fields: unknown[] }).fields).toEqual([
      { field: 'categoryId', code: 'SAME_AS_CURRENT' },
    ]);
    const retired = await d
      .http('post', '/maintenance/categories', s.manager.token, {
        key: 'retired_one',
        nameAr: 'قديم',
        nameEn: 'Old',
      })
      .expect(201);
    const retiredId = (retired.body as { id: string }).id;
    await d
      .http('patch', `/maintenance/categories/${retiredId}`, s.manager.token, {
        active: false,
      })
      .expect(200);
    const gone = await change(id, retiredId).expect(404);
    expect((gone.body as { code: string }).code).toBe(
      'TICKET_CATEGORY_NOT_FOUND',
    );
    const plumbing = await d.categoryId(s.c, 'plumbing');
    const bad = await change(id, plumbing, 'because').expect(400);
    expect((bad.body as { fields: { code: string }[] }).fields[0].code).toBe(
      'INVALID_REASON_CODE',
    );
    await d
      .http('post', `/maintenance/tickets/${id}/cancel`, s.supervisor.token, {
        reasonCode: 'duplicate',
      })
      .expect(204);
    const closed = await change(id, plumbing).expect(409);
    expect((closed.body as { code: string }).code).toBe(
      'TICKET_INVALID_TRANSITION',
    );
  });

  it('a common-area ticket only takes a category that allows a common area', async () => {
    const created = await d
      .http('post', '/maintenance/tickets', s.supervisor.token, {
        commonArea: 'Lobby',
        categoryId: await d.categoryId(s.c, 'general'),
        description: 'Common area fixture',
        reporterAccountId: s.owner.id,
      })
      .expect(201);
    const indoors = await d
      .http('post', '/maintenance/categories', s.manager.token, {
        key: 'indoors_only',
        nameAr: 'داخلي',
        nameEn: 'Indoors',
        commonAreaAllowed: false,
      })
      .expect(201);
    const res = await change(
      (created.body as { id: string }).id,
      (indoors.body as { id: string }).id,
    ).expect(400);
    expect((res.body as { fields: unknown[] }).fields).toEqual([
      { field: 'categoryId', code: 'CATEGORY_NOT_FOR_COMMON_AREA' },
    ]);
  });

  it('is a dispatcher’s: a technician and a resident are refused', async () => {
    const id = await assigned();
    const plumbing = await d.categoryId(s.c, 'plumbing');
    await d
      .http('post', `/maintenance/tickets/${id}/category`, s.techs[0].token, {
        categoryId: plumbing,
        reasonCode: 'misclassified',
      })
      .expect(403);
    await d
      .http('post', `/maintenance/tickets/${id}/category`, s.owner.token, {
        categoryId: plumbing,
        reasonCode: 'misclassified',
      })
      .expect(403);
  });
});
