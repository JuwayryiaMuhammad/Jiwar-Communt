import { err } from '../api/request';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { day, daysLater } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0064: the technician in the field. A current tag opens the asset's
 * card or the area (anything else is one answer), and the scan is kept;
 * the card shows the history and the readings against the previous ones;
 * readings by hand are dated within a month; a fault found on site is a
 * field work order (its unit's household sees it); one recommendation to
 * replace waits per asset, decided once; the planned work coming in the
 * technician's trade; the technician's list most urgent first.
 */
describe('Assets — the technician in the field', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;
  let tech: { id: string; token: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
    tech = s.techs[0];
    await a.specialize(s, tech, ['plumbing']);
  }, 90_000);

  afterAll(() => h.close());

  const scan = (code: string, token = tech.token) =>
    a.http('post', '/technician/scan', token, { code });
  const tag = async (path: string, token = s.manager.token) =>
    (
      (await a.http('post', `${path}/tag`, token).expect(201)).body as {
        code: string;
      }
    ).code;

  it('a current tag opens the card or the area, and is kept; anything else is one answer', async () => {
    const assetId = await a.asset(s);
    const old = await tag(`/maintenance/assets/${assetId}`);
    const current = await tag(`/maintenance/assets/${assetId}`);
    const seen = (await scan(current).expect(201)).body as {
      kind: string;
      asset: { asset: { id: string } };
    };
    expect(seen).toMatchObject({
      kind: 'asset',
      asset: { asset: { id: assetId } },
    });
    const area = await a.area(s);
    const areaTag = await tag(`/maintenance/areas/${area.id}`);
    expect((await scan(areaTag).expect(201)).body).toMatchObject({
      kind: 'area',
      area: { id: area.id },
    });
    const other = await a.setUp(0);
    const theirs = await tag(
      `/maintenance/areas/${(await a.area(other)).id}`,
      other.manager.token,
    );
    for (const code of [old, theirs, 'JWA1.x', 'JWR1.abc'])
      await scan(code)
        .expect(404)
        .expect((r) => expect(err(r).code).toBe('TAG_NOT_RECOGNIZED'));
    const kept = await a.inTenant(s.c, (tx) =>
      tx.fieldScan.findMany({ where: { accountId: tech.id } }),
    );
    expect(kept.map((k) => k.assetId ?? k.commonAreaId).sort()).toEqual(
      [assetId, area.id].sort(),
    );
    await scan(current, s.owner.token).expect(403);
  });

  it('readings by hand: dated within a month, never ahead; the card compares with the previous', async () => {
    const assetId = await a.asset(s);
    const record = (readings: object[]) =>
      a.http('post', `/technician/assets/${assetId}/readings`, tech.token, {
        readings,
      });
    await record([
      {
        metricKey: 'pressure_bar',
        value: '3',
        occurredAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ])
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'readings.0.occurredAt', code: 'INVALID_VALUE' },
        ]),
      );
    await record([
      {
        metricKey: 'pressure_bar',
        value: '3',
        occurredAt: daysLater(-40).toISOString(),
      },
    ]).expect(400);
    await record([
      {
        metricKey: 'pressure_bar',
        value: '3',
        occurredAt: '2026-01-01T10:00:00',
      },
    ]).expect(400);
    await record([
      {
        metricKey: 'pressure_bar',
        value: '3.1',
        unit: 'bar',
        occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ]).expect(204);
    await record([
      {
        metricKey: 'pressure_bar',
        value: '3.4',
        unit: 'bar',
        occurredAt: new Date().toISOString(),
      },
    ]).expect(204);
    const card = (
      await a
        .http('get', `/technician/assets/${assetId}`, tech.token)
        .expect(200)
    ).body as {
      readings: {
        metricKey: string;
        last: { value: string };
        previous: { value: string } | null;
      }[];
    };
    expect(card.readings).toEqual([
      expect.objectContaining({
        metricKey: 'pressure_bar',
        last: expect.objectContaining({ value: '3.4000' }) as unknown,
        previous: expect.objectContaining({ value: '3.1000' }) as unknown,
      }),
    ]);
  });

  it('a fault on an asset in a unit: a field work order its household sees; in an area, nobody outside', async () => {
    const inUnit = await a.asset(s, { unitId: s.unit.id });
    const created = (
      await a
        .http('post', `/technician/assets/${inUnit}/faults`, tech.token, {
          description: 'Leaking valve',
          priority: 'urgent',
        })
        .expect(201)
    ).body as { id: string };
    const ticket = await a.inTenant(s.c, (tx) =>
      tx.ticket.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(ticket).toMatchObject({
      origin: 'field',
      assetId: inUnit,
      unitId: s.unit.id,
      priority: 'urgent',
      reporterId: tech.id,
    });
    await a.http('get', `/tickets/${created.id}`, s.owner.token).expect(200);
    const inArea = await a.asset(s);
    const other = (
      await a
        .http('post', `/technician/assets/${inArea}/faults`, tech.token, {
          description: 'Worn belt',
        })
        .expect(201)
    ).body as { id: string };
    await a.http('get', `/tickets/${other.id}`, s.owner.token).expect(404);
    // A retired asset takes no fault.
    await a
      .http('post', `/maintenance/assets/${inArea}/retire`, s.manager.token, {
        reasonCode: 'replaced',
      })
      .expect(201);
    await a
      .http('post', `/technician/assets/${inArea}/faults`, tech.token, {
        description: 'Again',
      })
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('ASSET_RETIRED'));
  });

  it('one recommendation waits per asset, even two at once; decided once; the history and the keepers know', async () => {
    for (let round = 0; round < 3; round++) {
      const assetId = await a.asset(s);
      const [x, y] = await Promise.all([
        a.http(
          'post',
          `/technician/assets/${assetId}/replacement-recommendations`,
          tech.token,
          { reasonCode: 'end_of_life' },
        ),
        a.http(
          'post',
          `/technician/assets/${assetId}/replacement-recommendations`,
          tech.token,
          { reasonCode: 'safety' },
        ),
      ]);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
    }
    const assetId = await a.asset(s);
    const rec = (
      await a
        .http(
          'post',
          `/technician/assets/${assetId}/replacement-recommendations`,
          tech.token,
          {
            reasonCode: 'repeated_failures',
            note: 'Fourth seal this year',
          },
        )
        .expect(201)
    ).body as { id: string };
    const told = await a.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { kind: 'asset.replacement_recommended', targetId: rec.id },
      }),
    );
    expect(told.map((n) => n.accountId).sort()).toEqual(
      [s.manager.id, s.supervisor.id].sort(),
    );
    await a
      .http(
        'post',
        `/maintenance/replacement-recommendations/${rec.id}/decline`,
        s.manager.token,
        {},
      )
      .expect(400)
      .expect((r) => expect(err(r).code).toBe('REASON_REQUIRED'));
    await a
      .http(
        'post',
        `/maintenance/replacement-recommendations/${rec.id}/decline`,
        s.manager.token,
        { reasonCode: 'repair_first' },
      )
      .expect(201)
      .expect((r) =>
        expect(r.body).toMatchObject({
          status: 'declined',
          decisionReason: 'repair_first',
        }),
      );
    await a
      .http(
        'post',
        `/maintenance/replacement-recommendations/${rec.id}/accept`,
        s.manager.token,
      )
      .expect(409)
      .expect((r) =>
        expect(err(r).code).toBe('REPLACEMENT_RECOMMENDATION_DECIDED'),
      );
    const events = (
      (
        await a
          .http('get', `/maintenance/assets/${assetId}/events`, s.manager.token)
          .expect(200)
      ).body as {
        data: {
          kind: string;
          toValue: string | null;
          reasonCode: string | null;
        }[];
      }
    ).data;
    expect(events.slice(0, 2)).toEqual([
      expect.objectContaining({
        kind: 'replacement_decided',
        toValue: 'declined',
        reasonCode: 'repair_first',
      }),
      expect.objectContaining({
        kind: 'replacement_recommended',
        reasonCode: 'repeated_failures',
      }),
    ]);
    // A new one may wait now.
    await a
      .http(
        'post',
        `/technician/assets/${assetId}/replacement-recommendations`,
        tech.token,
        { reasonCode: 'obsolete' },
      )
      .expect(201);
  });

  it('the planned work coming in the technician’s trade, and theirs already', async () => {
    const assetId = await a.asset(s);
    const plan = (
      await a
        .http('post', '/maintenance/plans', s.manager.token, {
          assetId,
          title: 'Pump service',
          trigger: 'calendar',
          every: 1,
          unit: 'month',
          anchorOn: day(20),
        })
        .expect(201)
    ).body as { id: string };
    const upcoming = (
      await a.http('get', '/technician/plans/upcoming', tech.token).expect(200)
    ).body as {
      data: { planId: string; dueOn: string; ticketId: string | null }[];
    };
    expect(upcoming.data).toContainEqual(
      expect.objectContaining({
        planId: plan.id,
        dueOn: day(20),
        ticketId: null,
      }),
    );
    // Out of the trade: an electrician's plan is not theirs to see.
    const panel = await a.asset(s, {
      typeId: await a.typeId(s, 'electrical_panel'),
    });
    const other = (
      await a
        .http('post', '/maintenance/plans', s.manager.token, {
          assetId: panel,
          title: 'Panel check',
          trigger: 'calendar',
          every: 1,
          unit: 'month',
          anchorOn: day(10),
        })
        .expect(201)
    ).body as { id: string };
    const again = (
      await a.http('get', '/technician/plans/upcoming', tech.token).expect(200)
    ).body as {
      data: { planId: string }[];
    };
    expect(again.data.map((u) => u.planId)).not.toContain(other.id);
  });

  it('the technician’s list, most urgent first, page by page', async () => {
    const one = await a.setUp(1);
    const t = one.techs[0];
    const ids: Record<string, string> = {};
    for (const priority of [
      'normal',
      'emergency',
      'urgent',
      'normal',
    ] as const) {
      const assetId = await a.asset(one);
      const categoryId = await a.categoryId(one.c, 'plumbing');
      const ticket = await a.x.asManager(one.c, () =>
        h.moduleRef.get(TenantTx).withTenantTx((tx) =>
          h.moduleRef.get(TicketsService).createWorkOrder(tx, {
            tenantId: one.c.tenantId,
            origin: 'plan',
            assetId,
            categoryId,
            priority,
            description: priority,
            responsibleId: one.supervisor.id,
            actorId: null,
          }),
        ),
      );
      await a
        .http(
          'post',
          `/maintenance/tickets/${ticket.id}/assign`,
          one.supervisor.token,
          { technicianId: t.id },
        )
        .expect(204);
      ids[`${priority}-${Object.keys(ids).length}`] = ticket.id;
    }
    const first = (
      await a
        .http('get', '/technician/tickets?sort=priority&limit=2', t.token)
        .expect(200)
    ).body as {
      data: { id: string; priority: string }[];
      nextCursor: string;
    };
    const second = (
      await a
        .http(
          'get',
          `/technician/tickets?sort=priority&limit=2&cursor=${first.nextCursor}`,
          t.token,
        )
        .expect(200)
    ).body as {
      data: { id: string; priority: string }[];
      nextCursor: string | null;
    };
    expect([...first.data, ...second.data].map((x) => x.priority)).toEqual([
      'emergency',
      'urgent',
      'normal',
      'normal',
    ]);
    expect(second.nextCursor).toBeNull();
    await a
      .http(
        'get',
        '/technician/tickets?sort=priority&cursor=bm90LWEtY3Vyc29y',
        t.token,
      )
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'cursor', code: 'INVALID_FORMAT' },
        ]),
      );
  });
});
