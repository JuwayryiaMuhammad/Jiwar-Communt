import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  readinessHelpers,
  type ItemRead,
  type ReadinessSetUp,
} from '../setup/readiness';
import { dateColumn } from '../../src/maintenance/schedules/local-dates';

interface Campaign {
  item: ItemRead;
  inspections: {
    inspectionId: string;
    assetId: string | null;
    commonAreaId: string | null;
    status: string;
  }[];
  spawned: string[];
}

/**
 * ADR 0067: an inspection campaign schedules one inspection per target —
 * an asset of the compound's or a common area — due on its item's day,
 * through the inspections' own path; a target once per campaign; the item
 * done by nobody when its last inspection is submitted or cancelled, and
 * not called off while one is open.
 */
describe('Readiness — inspection campaigns', () => {
  let h: HttpHarness;
  let r: ReturnType<typeof readinessHelpers>;
  let s: ReadinessSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    r = readinessHelpers(h);
    s = await r.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const campaign = async (body: object = {}) => {
    const p = await r.program(s);
    const checklist = await r.checklist(s);
    const item = await r.item(s, p.id, {
      kind: 'inspection_campaign',
      checklistId: checklist.id,
      dueOn: day(5),
      ...body,
    });
    return { p, checklist, item };
  };
  const spawn = (itemId: string, body: object) =>
    r.http(
      'post',
      `/maintenance/readiness/items/${itemId}/campaign`,
      s.manager.token,
      { inspectorId: s.techs[0].id, ...body },
    );
  const tech = (method: 'post' | 'get' | 'put', path: string, body?: object) =>
    r.http(method, `/technician/inspections${path}`, s.techs[0].token, body);
  const itemOf = async (id: string) =>
    r.inTenant(s.c, (tx) =>
      tx.readinessItem.findUniqueOrThrow({ where: { id } }),
    );

  it('schedules one inspection per target, due on the item’s day, given to the inspector; a target it holds is left out', async () => {
    const { item, checklist } = await campaign();
    const a1 = await r.area(s);
    const a2 = await r.area(s);
    const first = (
      await spawn(item.id, { commonAreaIds: [a1.id, a2.id] }).expect(200)
    ).body as Campaign;
    expect(first.spawned).toHaveLength(2);
    expect(first.inspections.map((i) => i.commonAreaId).sort()).toEqual(
      [a1.id, a2.id].sort(),
    );
    expect(first.inspections.every((i) => i.status === 'scheduled')).toBe(true);
    const rows = await r.inTenant(s.c, (tx) =>
      tx.inspection.findMany({ where: { id: { in: first.spawned } } }),
    );
    for (const row of rows)
      expect(row).toMatchObject({
        checklistId: checklist.id,
        assigneeId: s.techs[0].id,
        dueOn: dateColumn(day(5)),
      });
    const told = await r.inTenant(s.c, (tx) =>
      tx.notification.count({
        where: { accountId: s.techs[0].id, kind: 'inspection.assigned' },
      }),
    );
    expect(told).toBeGreaterThanOrEqual(2);
    const again = (
      await spawn(item.id, {
        commonAreaIds: [a2.id, (await r.area(s)).id],
      }).expect(200)
    ).body as Campaign;
    expect(again.spawned).toHaveLength(1);
    expect(again.inspections).toHaveLength(3);
  });

  it('takes only what the compound inspects: an active asset not in a unit, an active area, an inspector, a campaign still due', async () => {
    const { item } = await campaign();
    const area = await r.area(s);
    expect(
      err(
        await spawn(item.id, {
          inspectorId: s.owner.id,
          commonAreaIds: [area.id],
        }).expect(400),
      ).fields,
    ).toEqual([{ field: 'inspectorId', code: 'INSPECTOR_NOT_ELIGIBLE' }]);
    const inUnit = await r.asset(s, { unitId: s.unit.id });
    expect(
      err(
        await spawn(item.id, {
          assetIds: [inUnit],
          commonAreaIds: [area.id, '0192a5f0-1c2b-7d3e-8f40-000000006705'],
        }).expect(400),
      ).fields,
    ).toEqual([
      { field: 'assetIds.0', code: 'ASSET_NOT_AVAILABLE' },
      { field: 'commonAreaIds.1', code: 'COMMON_AREA_NOT_AVAILABLE' },
    ]);
    expect(err(await spawn(item.id, {}).expect(400)).fields).toEqual([
      { field: 'assetIds', code: 'FIELD_REQUIRED' },
    ]);
    const p = await r.program(s);
    const task = await r.item(s, p.id);
    expect(
      err(await spawn(task.id, { commonAreaIds: [area.id] }).expect(409)),
    ).toMatchObject({
      code: 'READINESS_ITEM_NOT_A_CAMPAIGN',
      params: { kind: 'task' },
    });
    await r.inTenant(s.c, (tx) =>
      tx.readinessItem.update({
        where: { id: item.id },
        data: { dueOn: dateColumn(day(-1)) },
      }),
    );
    expect(
      err(await spawn(item.id, { commonAreaIds: [area.id] }).expect(409)),
    ).toMatchObject({
      code: 'READINESS_ITEM_PAST_DUE',
      params: { dueOn: day(-1) },
    });
  });

  it('is done by its last inspection, submitted or cancelled, and not called off while one is open', async () => {
    const { item } = await campaign();
    const a1 = await r.area(s);
    const a2 = await r.area(s);
    const c = (
      await spawn(item.id, { commonAreaIds: [a1.id, a2.id] }).expect(200)
    ).body as Campaign;
    const [one, two] = c.spawned;
    expect(
      err(
        await r
          .http(
            'post',
            `/maintenance/readiness/items/${item.id}/cancel`,
            s.manager.token,
            {
              reasonCode: 'not_needed',
            },
          )
          .expect(409),
      ),
    ).toMatchObject({ code: 'READINESS_CAMPAIGN_OPEN', params: { open: 2 } });
    // The first submitted: the campaign is still open.
    await tech('post', `/${one}/start`, {}).expect(201);
    const read = (await tech('get', `/${one}`).expect(200)).body as {
      checklist: { items: { id: string }[] };
    };
    await tech('put', `/${one}/items/${read.checklist.items[0].id}`, {
      result: 'pass',
    }).expect(200);
    await tech('post', `/${one}/submit`, {}).expect(201);
    expect((await itemOf(item.id)).doneAt).toBeNull();
    // The second cancelled: done, by nobody.
    await r
      .http('post', `/maintenance/inspections/${two}/cancel`, s.manager.token, {
        reasonCode: 'target_unavailable',
      })
      .expect(201);
    const done = await itemOf(item.id);
    expect(done.doneAt).not.toBeNull();
    expect(done.doneById).toBeNull();
    expect(
      err(
        await spawn(item.id, { commonAreaIds: [(await r.area(s)).id] }).expect(
          409,
        ),
      ),
    ).toMatchObject({
      code: 'READINESS_ITEM_ENDED',
      params: { state: 'done' },
    });
  });

  it('a campaign of a closed program stays as it is when its inspections end', async () => {
    const { p, item } = await campaign();
    const c = (
      await spawn(item.id, { commonAreaIds: [(await r.area(s)).id] }).expect(
        200,
      )
    ).body as Campaign;
    await r
      .http(
        'post',
        `/maintenance/readiness/programs/${p.id}/close`,
        s.manager.token,
      )
      .expect(200);
    await r
      .http(
        'post',
        `/maintenance/inspections/${c.spawned[0]}/cancel`,
        s.manager.token,
        {
          reasonCode: 'not_needed',
        },
      )
      .expect(201);
    expect((await itemOf(item.id)).doneAt).toBeNull();
  });

  it('races: a campaign spawned twice at once inspects each target once', async () => {
    for (let round = 0; round < 3; round++) {
      const { item } = await campaign();
      const areas = [(await r.area(s)).id, (await r.area(s)).id];
      const results = await Promise.all([
        spawn(item.id, { commonAreaIds: areas }),
        spawn(item.id, { commonAreaIds: [...areas].reverse() }),
      ]);
      expect(results.map((x) => x.status)).toEqual([200, 200]);
      const spawned = results.flatMap((x) => (x.body as Campaign).spawned);
      expect(spawned).toHaveLength(2);
      const links = await r.inTenant(s.c, (tx) =>
        tx.readinessCampaignInspection.findMany({ where: { itemId: item.id } }),
      );
      expect(links.map((l) => l.commonAreaId).sort()).toEqual(
        [...areas].sort(),
      );
    }
  });
});
