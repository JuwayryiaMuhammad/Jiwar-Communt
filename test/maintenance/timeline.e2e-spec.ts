import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

interface Entry {
  from: string | null;
  to: string;
  at: string;
  reasonCode: string | null;
  cycle: number;
  by: string;
}

/**
 * A resident's timeline of a ticket (ADR 0058): every status change, oldest
 * first, with its time and the side that made it — never a name or an id.
 */
describe('Maintenance — the resident’s timeline', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const tech = () => s.techs[0];
  const timeline = async (id: string, token = s.owner.token) =>
    (
      (await d.http('get', `/tickets/${id}/timeline`, token).expect(200))
        .body as {
        data: Entry[];
      }
    ).data;

  it('each change with its time and side, oldest first, no names', async () => {
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech().id,
      })
      .expect(204);
    await d
      .http('post', `/technician/tickets/${id}/en-route`, tech().token)
      .expect(204);
    await d
      .http('post', `/technician/tickets/${id}/start`, tech().token)
      .expect(204);
    await d
      .http('post', `/technician/tickets/${id}/hold`, tech().token, {
        holdReason: 'awaiting_parts',
      })
      .expect(204);

    const entries = await timeline(id);
    expect(entries.map((e) => [e.from, e.to, e.by])).toEqual([
      [null, 'new', 'you'],
      ['new', 'assigned', 'management'],
      ['assigned', 'en_route', 'technician'],
      ['en_route', 'in_progress', 'technician'],
      ['in_progress', 'on_hold', 'technician'],
    ]);
    expect(entries[4].reasonCode).toBe('awaiting_parts');
    expect(entries.every((e) => e.cycle === 1)).toBe(true);
    const times = entries.map((e) => new Date(e.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const text = JSON.stringify(entries);
    for (const someone of [tech().id, s.supervisor.id, s.owner.id])
      expect(text).not.toContain(someone);
    for (const e of entries)
      expect(Object.keys(e).sort()).toEqual(
        ['at', 'by', 'cycle', 'from', 'reasonCode', 'to'].sort(),
      );
  });

  it('the household is "household"; another unit’s resident reads nothing', async () => {
    const tenant = await d.x.resident(s.c, [s.unit.id], 'tenant');
    const t = await d.who(s.c, tenant.id, 'resident');
    const res = await d
      .http('post', '/tickets', t.token, {
        unitId: s.unit.id,
        categoryId: await d.categoryId(s.c, 'general'),
        description: 'Timeline fixture',
      })
      .expect(201);
    const id = (res.body as { id: string }).id;
    // The unit's primary sees the household's ticket.
    expect((await timeline(id)).map((e) => e.by)).toEqual(['household']);
    expect((await timeline(id, t.token)).map((e) => e.by)).toEqual(['you']);

    const elsewhere = await d.x.unit(s.c);
    const neighbour = await d.x.resident(s.c, [elsewhere.id]);
    const n = await d.who(s.c, neighbour.id, 'resident');
    const refused = await d
      .http('get', `/tickets/${id}/timeline`, n.token)
      .expect(404);
    expect((refused.body as { code: string }).code).toBe('TICKET_NOT_FOUND');
  });
});
