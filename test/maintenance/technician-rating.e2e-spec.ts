import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

/**
 * ADR 0038: a confirmation rates the service (`rating`, as in 5.1) and,
 * optionally, the technician who did the work. The technician rated is
 * named on the row; dispatch sees it; the technician never sees ratings.
 */
describe('Maintenance — the technician’s rating', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(2);
  }, 90_000);

  afterAll(() => h.close());

  const tech = () => s.techs[0];

  /** A ticket the first technician completed, waiting for the reporter. */
  async function completed(): Promise<string> {
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech().id,
      })
      .expect(204);
    for (const verb of ['start', 'complete'])
      await d
        .http('post', `/technician/tickets/${id}/${verb}`, tech().token)
        .expect(204);
    return id;
  }

  const confirm = (id: string, body: object) =>
    d.http('post', `/tickets/${id}/confirm`, s.owner.token, body);

  const feedback = (id: string) =>
    d.inTenant(s.c, (tx) =>
      tx.ticketFeedback.findFirstOrThrow({ where: { ticketId: id } }),
    );

  it('both ratings: the technician who did the work is named on the row; dispatch sees it', async () => {
    const id = await completed();
    await confirm(id, {
      rating: 4,
      technicianRating: 5,
      comment: 'Polite',
    }).expect(204);
    expect(await feedback(id)).toMatchObject({
      kind: 'confirmed',
      rating: 4,
      technicianRating: 5,
      ratedTechnicianId: tech().id,
    });
    const detail = await d
      .http('get', `/maintenance/tickets/${id}`, s.supervisor.token)
      .expect(200);
    expect(
      (detail.body as { feedback: Record<string, unknown>[] }).feedback[0],
    ).toMatchObject({
      rating: 4,
      technicianRating: 5,
      ratedTechnician: { id: tech().id },
    });
  });

  it('the 5.1 payload still works: one rating, the technician’s is null', async () => {
    const id = await completed();
    await confirm(id, { rating: 3 }).expect(204);
    expect(await feedback(id)).toMatchObject({
      rating: 3,
      technicianRating: null,
      ratedTechnicianId: null,
    });
  });

  it('1 to 5, whole numbers', async () => {
    const id = await completed();
    for (const technicianRating of [0, 6, 4.5, '5'])
      expect(
        (
          (await confirm(id, { rating: 4, technicianRating }).expect(400))
            .body as { fields: unknown[] }
        ).fields,
      ).toEqual([
        {
          field: 'technicianRating',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 5 },
        },
      ]);
    // Nothing was written.
    expect((await d.ticketRow(s.c, id)).status).toBe('completed');
  });

  it('never reaches the technician', async () => {
    const id = await completed();
    // Still theirs to see while completed: confirm, then read as them.
    const before = await d
      .http('get', `/technician/tickets/${id}`, tech().token)
      .expect(200);
    expect(JSON.stringify(before.body)).not.toMatch(/rating/i);
    await confirm(id, { rating: 2, technicianRating: 1 }).expect(204);
    const after = await d
      .http('get', `/technician/tickets/${id}`, tech().token)
      .expect(200);
    expect(after.body).toMatchObject({ status: 'closed' });
    expect(JSON.stringify(after.body)).not.toMatch(/rating/i);
  });

  it('stays with who did the work after a reopen goes to someone else', async () => {
    const id = await completed();
    await confirm(id, { rating: 5, technicianRating: 4 }).expect(204);
    await d
      .http('post', `/tickets/${id}/reopen`, s.owner.token, {
        reasonCode: 'problem_returned',
        reason: 'Leaking again',
      })
      .expect(204);
    // The first reopen goes back to who did the work; then someone else.
    expect(await d.ticketRow(s.c, id)).toMatchObject({
      status: 'assigned',
      technicianId: tech().id,
    });
    await d
      .http('post', `/maintenance/tickets/${id}/reassign`, s.supervisor.token, {
        technicianId: s.techs[1].id,
        reasonCode: 'workload',
      })
      .expect(204);
    expect(await d.ticketRow(s.c, id)).toMatchObject({
      technicianId: s.techs[1].id,
    });
    expect(
      await d.inTenant(s.c, (tx) =>
        tx.ticketFeedback.findFirstOrThrow({
          where: { ticketId: id, kind: 'confirmed' },
        }),
      ),
    ).toMatchObject({ technicianRating: 4, ratedTechnicianId: tech().id });
  });
});
