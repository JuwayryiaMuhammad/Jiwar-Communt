import { day } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitHelpers, type Who } from '../setup/permits';

interface Item {
  type: string;
  id: string;
  number: string | null;
  status: string;
  unitId: string | null;
}

/**
 * The resident's lists (ADR 0058) carry ADR 0063's inspection requests and
 * works completion inspections, each with its own route's visibility, and
 * the search finds them by their references.
 */
describe('Resident items — inspections', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const http = (
    method: 'get' | 'post',
    path: string,
    who: Who,
    body?: object,
  ) =>
    h
      .http()
      [method](`${API}${path}`)
      .set('Authorization', `Bearer ${who.token}`)
      .send(body);
  const listed = async (who: Who, path: string) =>
    ((await http('get', path, who).expect(200)).body as { data: Item[] }).data;

  it('an inspection request: listed for the unit’s owners, found by IR-, never for a tenant', async () => {
    const s = await p.setUp('Inspection Items Court');
    await http('post', `/units/${s.home.id}/closed-mode`, s.alice, {
      closed: true,
    }).expect(204);
    const asked = (
      await http('post', `/units/${s.home.id}/inspection-requests`, s.alice, {
        preferredOn: day(3),
      }).expect(201)
    ).body as { id: string; reference: string };
    expect(asked.reference).toMatch(/^IR-\d{6}$/);

    const mine = await listed(s.alice, '/me/requests');
    expect(mine.find((i) => i.id === asked.id)).toMatchObject({
      type: 'inspection_request',
      number: asked.reference,
      status: 'open',
      unitId: s.home.id,
    });
    const found = await listed(
      s.alice,
      `/me/search?q=${encodeURIComponent(asked.reference)}`,
    );
    expect(found.map((i) => i.id)).toContain(asked.id);

    const t = await p.x.resident(s.c, [s.home.id], 'tenant');
    const tenant = await p.who(s.c, t.id, 'resident');
    expect(
      (await listed(tenant, '/me/requests')).map((i) => i.id),
    ).not.toContain(asked.id);
  });

  it('a works inspection: listed for the permit’s requester, found by its certificate once passed', async () => {
    const s = await p.setUp('Works Items Court');
    const permit = await p.works(s.alice, s.home.id);
    await p.approve(s.manager, permit.id);
    const asked = (
      await http(
        'post',
        `/permits/${permit.id}/completion-inspection`,
        s.alice,
      ).expect(201)
    ).body as { id: string };
    expect(
      (await listed(s.alice, '/me/requests')).find((i) => i.id === asked.id),
    ).toMatchObject({
      type: 'works_inspection',
      status: 'asked',
      number: null,
    });

    const passed = (
      await http(
        'post',
        `/staff/permit-inspections/${asked.id}/decide`,
        s.manager,
        {
          outcome: 'passed',
          photoFileIds: [
            await fileHelpers(h).ready(
              s.manager.token,
              'works_inspection_photo',
            ),
          ],
        },
      ).expect(200)
    ).body as { certificateNumber: string };
    const found = await listed(
      s.alice,
      `/me/search?q=${encodeURIComponent(passed.certificateNumber)}`,
    );
    expect(found.find((i) => i.id === asked.id)).toMatchObject({
      type: 'works_inspection',
      status: 'passed',
      number: passed.certificateNumber,
    });
    // Another account of the unit never lists someone else's round.
    const member = await p.family(s.c, s.home.id, s.alice);
    expect(
      (await listed(member, '/me/requests')).map((i) => i.id),
    ).not.toContain(asked.id);
  });
});
