import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

/**
 * ADR 0038: a unit's ticket may say which room. Optional, never on a
 * common area, and read by everyone who reads the ticket.
 */
describe('Maintenance — where in the unit', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let categoryId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    categoryId = await d.categoryId(s.c, 'plumbing');
  }, 90_000);

  afterAll(() => h.close());

  const open = (body: object) =>
    d.http('post', '/tickets', s.owner.token, {
      categoryId,
      description: 'A leak',
      ...body,
    });

  it('is stored, and every view of the ticket carries it', async () => {
    const res = await open({
      unitId: s.unit.id,
      unitLocation: 'kitchen',
    }).expect(201);
    const { id } = res.body as { id: string };
    expect((await d.ticketRow(s.c, id)).unitLocation).toBe('kitchen');
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: s.techs[0].id,
      })
      .expect(204);

    const views: [string, string][] = [
      ['/tickets', s.owner.token],
      ['/technician/tickets', s.techs[0].token],
      ['/maintenance/tickets', s.supervisor.token],
    ];
    for (const [base, token] of views) {
      const detail = await d.http('get', `${base}/${id}`, token).expect(200);
      expect(detail.body).toMatchObject({ unitLocation: 'kitchen' });
      const list = await d.http('get', base, token).expect(200);
      expect(
        (list.body as { data: { id: string }[] }).data.find((t) => t.id === id),
      ).toMatchObject({ unitLocation: 'kitchen' });
    }
  });

  it('is optional: a ticket without it reads null', async () => {
    const res = await open({ unitId: s.unit.id }).expect(201);
    const { id } = res.body as { id: string };
    const detail = await d
      .http('get', `/tickets/${id}`, s.owner.token)
      .expect(200);
    expect(detail.body).toMatchObject({ unitLocation: null });
  });

  it('a common area has no rooms', async () => {
    const res = await open({
      commonArea: 'Lobby',
      unitLocation: 'kitchen',
    }).expect(400);
    expect((res.body as { fields: unknown[] }).fields).toEqual([
      { field: 'unitLocation', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });

  it('dispatch gives it when opening a ticket for a resident', async () => {
    const res = await d
      .http('post', '/maintenance/tickets', s.supervisor.token, {
        unitId: s.unit.id,
        unitLocation: 'balcony',
        categoryId,
        description: 'Called in',
        reporterAccountId: s.owner.id,
      })
      .expect(201);
    expect(
      (await d.ticketRow(s.c, (res.body as { id: string }).id)).unitLocation,
    ).toBe('balcony');
  });
});
