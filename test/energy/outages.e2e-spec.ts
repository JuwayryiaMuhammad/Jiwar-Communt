import { OutageSweep } from '../../src/maintenance/outages/outage-sweep';
import { err } from '../api/request';
import { communityHelpers } from '../setup/community';
import { energyHelpers, type EnergySetUp } from '../setup/energy';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Outage {
  id: string;
  kind: string;
  planned: boolean;
  scope: string;
  buildings: string[];
  startsAt: string;
  endsAt: string;
  notifiedAt: string | null;
  endedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

const HOUR = 3_600_000;
/** An instant `hours` from now, with its offset. */
const inHours = (hours: number) =>
  new Date(Date.now() + hours * HOUR).toISOString();

/**
 * ADR 0066: a utility outage told to the residents of its buildings — at
 * once when unplanned or within 48 hours, otherwise by the sweep 48 hours
 * ahead — each one recorded, so a new start, the end and a cancellation go
 * to exactly those told.
 */
describe('Energy — utility outages', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof energyHelpers>;
  let s: EnergySetUp;
  /** Someone in another building of the same compound. */
  let elsewhere: { id: string; token: string; building: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    e = energyHelpers(h);
    s = await e.setUp(1);
    const x = communityHelpers(h);
    const unit = await x.unit(s.c);
    const building = `${s.building} B`;
    await e.inTenant(s.c, (tx) =>
      tx.unit.update({ where: { id: unit.id }, data: { building } }),
    );
    const person = await x.resident(s.c, [unit.id]);
    elsewhere = {
      id: person.id,
      building,
      token: await h.tokenFor({
        sub: person.id,
        tid: s.c.tenantId,
        typ: 'resident',
      }),
    };
  }, 90_000);

  afterAll(() => h.close());

  const create = (body: object) =>
    e.http('post', '/maintenance/outages', s.manager.token, {
      kind: 'water',
      planned: true,
      scope: 'buildings',
      buildings: [s.building],
      startsAt: inHours(72),
      endsAt: inHours(76),
      ...body,
    });
  const outage = async (body: object = {}) =>
    (await create(body).expect(201)).body as Outage;
  const act = (o: Outage, what: string, body?: object) =>
    e.http(
      'post',
      `/maintenance/outages/${o.id}/${what}`,
      s.manager.token,
      body,
    );
  const patch = (o: Outage, body: object) =>
    e.http('patch', `/maintenance/outages/${o.id}`, s.manager.token, body);
  const told = (accountId: string, o: Outage, kind: string) =>
    e.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { accountId, kind, targetId: o.id },
      }),
    );
  const sweep = (at: Date) => h.moduleRef.get(OutageSweep).run(at);

  it('unplanned, or planned within 48 hours: told at once, to its buildings only', async () => {
    const now = await outage({ planned: false, startsAt: inHours(1) });
    expect(now.notifiedAt).not.toBeNull();
    const [notice] = await told(s.owner.id, now, 'utility_outage.announced');
    expect(notice.params).toEqual({
      outageKind: 'water',
      startsAt: now.startsAt,
      endsAt: now.endsAt,
    });
    expect(
      await told(elsewhere.id, now, 'utility_outage.announced'),
    ).toHaveLength(0);
    const soon = await outage({ startsAt: inHours(30), endsAt: inHours(31) });
    expect(soon.notifiedAt).not.toBeNull();
    const mine = (await e.http('get', '/me/outages', s.owner.token).expect(200))
      .body as { id: string }[];
    expect(mine.map((o) => o.id)).toEqual(
      expect.arrayContaining([now.id, soon.id]),
    );
    // The staff's note never reaches a resident, as it never rides a notice.
    for (const o of mine)
      expect(Object.keys(o).sort()).toEqual([
        'endsAt',
        'id',
        'kind',
        'startsAt',
      ]);
    expect(
      (
        (await e.http('get', '/me/outages', elsewhere.token).expect(200))
          .body as { id: string }[]
      ).map((o) => o.id),
    ).not.toContain(now.id);
  });

  it('planned further ahead: told by the sweep 48 hours before, once, whatever runs', async () => {
    const later = await outage();
    expect(later.notifiedAt).toBeNull();
    await sweep(new Date());
    expect(
      await told(s.owner.id, later, 'utility_outage.announced'),
    ).toHaveLength(0);
    const due = new Date(Date.parse(later.startsAt) - 47 * HOUR);
    await Promise.all([sweep(due), sweep(due)]);
    await sweep(due);
    expect(
      await told(s.owner.id, later, 'utility_outage.announced'),
    ).toHaveLength(1);
  });

  it('the whole compound reaches every building; a scope becomes buildings only with one named', async () => {
    const all = await outage({
      planned: false,
      scope: 'compound',
      buildings: [],
      startsAt: inHours(2),
      endsAt: inHours(3),
    });
    expect(all).toMatchObject({ scope: 'compound', buildings: [] });
    for (const who of [s.owner.id, elsewhere.id])
      expect(await told(who, all, 'utility_outage.announced')).toHaveLength(1);
    expect(
      err(await patch(all, { scope: 'buildings' }).expect(400)).fields,
    ).toEqual([{ field: 'buildings', code: 'FIELD_REQUIRED' }]);
    expect(
      (
        (
          await patch(all, {
            scope: 'buildings',
            buildings: [s.building],
          }).expect(200)
        ).body as Outage
      ).buildings,
    ).toEqual([s.building]);
  });

  it('a new start is told once to those told; new buildings reach their residents; the end alone tells nobody', async () => {
    const o = await outage({ startsAt: inHours(10), endsAt: inHours(12) });
    await patch(o, { endsAt: inHours(14) }).expect(200);
    expect(
      await told(s.owner.id, o, 'utility_outage.rescheduled'),
    ).toHaveLength(0);
    await patch(o, { startsAt: inHours(11) }).expect(200);
    expect(
      await told(s.owner.id, o, 'utility_outage.rescheduled'),
    ).toHaveLength(1);
    await patch(o, { buildings: [s.building, elsewhere.building] }).expect(200);
    expect(
      await told(elsewhere.id, o, 'utility_outage.announced'),
    ).toHaveLength(1);
    expect(await told(s.owner.id, o, 'utility_outage.announced')).toHaveLength(
      1,
    );
  });

  it('cancelled before it starts, ended after; then it never changes', async () => {
    const o = await outage({ startsAt: inHours(5), endsAt: inHours(6) });
    expect(err(await act(o, 'end').expect(409)).code).toBe(
      'UTILITY_OUTAGE_NOT_STARTED',
    );
    expect(err(await act(o, 'cancel', {}).expect(400)).code).toBe(
      'REASON_REQUIRED',
    );
    expect(
      (
        (await act(o, 'cancel', { reasonCode: 'rescheduled' }).expect(200))
          .body as Outage
      ).cancelReason,
    ).toBe('rescheduled');
    expect(await told(s.owner.id, o, 'utility_outage.cancelled')).toHaveLength(
      1,
    );
    expect(err(await patch(o, { endsAt: inHours(7) }).expect(409)).code).toBe(
      'UTILITY_OUTAGE_CLOSED',
    );
    const on = await outage({
      planned: false,
      scope: 'compound',
      buildings: [],
      startsAt: inHours(-1),
      endsAt: inHours(3),
    });
    expect(
      err(await act(on, 'cancel', { reasonCode: 'other' }).expect(409)).code,
    ).toBe('UTILITY_OUTAGE_STARTED');
    expect(
      err(await patch(on, { startsAt: inHours(1) }).expect(409)).code,
    ).toBe('UTILITY_OUTAGE_STARTED');
    await act(on, 'end').expect(200);
    expect(await told(s.owner.id, on, 'utility_outage.ended')).toHaveLength(1);
    await expect(
      e.inTenant(s.c, (tx) =>
        tx.utilityOutage.update({
          where: { id: on.id },
          data: { note: 'Later' },
        }),
      ),
    ).rejects.toThrow(/never changes/);
  });

  it('its window: after its start, two weeks at most, not over; buildings that exist', async () => {
    expect(
      err(await create({ endsAt: inHours(71) }).expect(400)).fields,
    ).toEqual([{ field: 'endsAt', code: 'ENDS_BEFORE_START' }]);
    expect(
      err(await create({ endsAt: inHours(72 + 15 * 24) }).expect(400)).fields,
    ).toEqual([
      { field: 'endsAt', code: 'INVALID_VALUE', params: { maxDays: 14 } },
    ]);
    expect(
      err(
        await create({ startsAt: inHours(-5), endsAt: inHours(-1) }).expect(
          400,
        ),
      ).fields,
    ).toEqual([{ field: 'endsAt', code: 'INVALID_VALUE' }]);
    expect(
      err(
        await create({ buildings: [s.building, 'No such tower'] }).expect(400),
      ).fields,
    ).toEqual([{ field: 'buildings.1', code: 'BUILDING_NOT_FOUND' }]);
    // The scope and its buildings in step: the compound names none,
    // buildings name one at least.
    expect(
      err(
        await create({ scope: 'compound', buildings: [s.building] }).expect(
          400,
        ),
      ).fields,
    ).toEqual([{ field: 'buildings', code: 'FIELD_NOT_ALLOWED' }]);
    expect(
      err(await create({ scope: 'buildings', buildings: [] }).expect(400))
        .fields,
    ).toEqual([{ field: 'buildings', code: 'FIELD_REQUIRED' }]);
    // Left out (undefined is not sent): the same.
    expect(
      err(
        await create({ scope: 'buildings', buildings: undefined }).expect(400),
      ).fields,
    ).toEqual([{ field: 'buildings', code: 'FIELD_REQUIRED' }]);
    await e
      .http('post', '/maintenance/outages', s.techs[0].token, {})
      .expect(403);
  });

  describe('races', () => {
    it('ended twice at once: once, and told once', async () => {
      for (let round = 0; round < 3; round++) {
        const on = await outage({
          planned: false,
          startsAt: inHours(-1),
          endsAt: inHours(2),
        });
        const results = await Promise.all([act(on, 'end'), act(on, 'end')]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(await told(s.owner.id, on, 'utility_outage.ended')).toHaveLength(
          1,
        );
      }
    });

    it('a cancellation racing a new start: decided one after the other', async () => {
      for (let round = 0; round < 3; round++) {
        const o = await outage({ startsAt: inHours(5), endsAt: inHours(6) });
        const [cancel, move] = await Promise.all([
          act(o, 'cancel', { reasonCode: 'not_needed' }),
          patch(o, { startsAt: inHours(4) }),
        ]);
        expect(cancel.status).toBe(200);
        expect([200, 409]).toContain(move.status);
        const moved = await told(s.owner.id, o, 'utility_outage.rescheduled');
        expect(moved).toHaveLength(move.status === 200 ? 1 : 0);
        expect(
          await told(s.owner.id, o, 'utility_outage.cancelled'),
        ).toHaveLength(1);
      }
    });
  });
});
