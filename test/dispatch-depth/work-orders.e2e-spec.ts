import { newId } from '../../src/core/common/uuid';
import { dbDate } from '../setup/compound-clock';
import { energyHelpers, type EnergySetUp } from '../setup/energy';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/** An answer's body, as the assertions read it. */
type Body = {
  code: string;
  fields: { field: string; code: string }[];
  [key: string]: unknown;
};

interface Created {
  id: string;
  number: string;
  status: string;
  priority: string;
}

/**
 * ADR 0076: the management's own work orders. `tickets.dispatch` opens one
 * on an asset or a common area of the compound's, or for a meter's spike
 * (one per alert, the alert acknowledged with it); it is a repair of origin
 * `staff`, dispatched and measured like any, its reporter the dispatcher.
 * The household sees one on an asset in its unit, as a field fault; none
 * other.
 */
describe('Dispatch depth — the management’s own work orders', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof energyHelpers>;
  let s: EnergySetUp;
  let plumbing: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = energyHelpers(h);
    s = await e.setUp(1);
    plumbing = await e.categoryId(s.c, 'plumbing');
  }, 180_000);

  afterAll(() => h.close());

  const open = (body: object, token = s.supervisor.token) =>
    e.http('post', '/maintenance/work-orders', token, {
      categoryId: plumbing,
      description: 'Pump hums and leaks',
      ...body,
    });

  const row = (id: string) =>
    e.inTenant(s.c, (tx) => tx.ticket.findUniqueOrThrow({ where: { id } }));

  /** A spike on `meterId`, as the reading rule writes it. */
  const alertOn = (meterId: string, day = '2026-01-01') =>
    e.inTenant(s.c, async (tx) => {
      const reading = await tx.meterReading.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          meterId,
          readOn: dbDate(day),
          value: '10',
          source: 'manual',
        },
      });
      return tx.meterAlert.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          meterId,
          readingId: reading.id,
          readOn: reading.readOn,
          kind: 'spike',
          dailyRate: '9',
          baselineRate: '1',
        },
      });
    });

  it('on an asset: a staff repair where the asset is, its reporter and creator the dispatcher, audited', async () => {
    const assetId = await e.asset(s);
    const res = await open({ assetId, priority: 'urgent' }).expect(201);
    const t = await row((res.body as Created).id);
    expect(t).toMatchObject({
      origin: 'staff',
      kind: 'repair',
      assetId,
      unitId: null,
      reporterId: s.supervisor.id,
      createdById: s.supervisor.id,
      priority: 'urgent',
      meterAlertId: null,
    });
    expect(t.commonAreaId).not.toBeNull();
    const audit = await e.inTenant(s.c, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'ticket.work_order_opened', targetId: t.id },
      }),
    );
    expect(audit.metadata).toMatchObject({
      origin: 'staff',
      assetId,
      priority: 'urgent',
    });
    expect(JSON.stringify(audit)).not.toContain('Pump hums');
  });

  it('on a common area: the area named, its name the label; the category’s priority by default', async () => {
    const area = await e.area(s);
    const res = await open({ commonAreaId: area.id }).expect(201);
    const t = await row((res.body as Created).id);
    expect(t).toMatchObject({
      origin: 'staff',
      commonAreaId: area.id,
      commonArea: 'Pump room',
      assetId: null,
    });
    const category = await e.inTenant(s.c, (tx) =>
      tx.ticketCategory.findUniqueOrThrow({ where: { id: plumbing } }),
    );
    expect(t.priority).toBe(category.defaultPriority);
  });

  it('names one place: both, or neither, is a field error', async () => {
    const area = await e.area(s);
    const assetId = await e.asset(s);
    const both = await open({ assetId, commonAreaId: area.id }).expect(400);
    expect(both.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: [{ field: 'commonAreaId', code: 'FIELD_NOT_ALLOWED' }],
    });
    const none = await open({}).expect(400);
    expect(none.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: [{ field: 'assetId', code: 'FIELD_REQUIRED' }],
    });
  });

  it('refuses an unknown asset, a retired one, an unknown area and an unknown category', async () => {
    await open({ assetId: newId() })
      .expect(404)
      .expect((r) => expect((r.body as Body).code).toBe('ASSET_NOT_FOUND'));
    await open({ commonAreaId: newId() })
      .expect(404)
      .expect((r) =>
        expect((r.body as Body).code).toBe('COMMON_AREA_NOT_FOUND'),
      );
    const retired = await e.asset(s);
    await e
      .http('post', `/maintenance/assets/${retired}/retire`, s.manager.token, {
        reasonCode: 'disposed',
      })
      .expect(201);
    await open({ assetId: retired })
      .expect(409)
      .expect((r) => expect((r.body as Body).code).toBe('ASSET_RETIRED'));
    await open({ assetId: await e.asset(s), categoryId: newId() })
      .expect(404)
      .expect((r) =>
        expect((r.body as Body).code).toBe('TICKET_CATEGORY_NOT_FOUND'),
      );
  });

  it('for a meter’s spike: on the meter’s asset, the alert acknowledged with it, and one work order per alert', async () => {
    const assetId = await e.asset(s);
    const meter = await e.meter(s, { assetId });
    const alert = await alertOn(meter.id);
    const res = await open({ meterAlertId: alert.id }).expect(201);
    const t = await row((res.body as Created).id);
    expect(t).toMatchObject({ assetId, meterAlertId: alert.id });
    const after = await e.inTenant(s.c, (tx) =>
      tx.meterAlert.findUniqueOrThrow({ where: { id: alert.id } }),
    );
    expect(after.acknowledgedById).toBe(s.supervisor.id);
    const again = await open({ meterAlertId: alert.id }).expect(409);
    expect(again.body).toMatchObject({
      code: 'METER_ALERT_HAS_WORK_ORDER',
      params: { ticketNumber: (res.body as Created).number },
    });
  });

  it('for a spike on a unit’s meter without an asset: the place must be named', async () => {
    const meter = await e.meter(s, { unitId: s.unit.id });
    const alert = await alertOn(meter.id);
    const res = await open({ meterAlertId: alert.id }).expect(400);
    expect(res.body).toMatchObject({
      fields: [{ field: 'assetId', code: 'FIELD_REQUIRED' }],
    });
    const area = await e.area(s);
    await open({ meterAlertId: alert.id, commonAreaId: area.id }).expect(201);
  });

  it('an unknown alert is not found', async () => {
    const res = await open({
      meterAlertId: newId(),
      assetId: await e.asset(s),
    }).expect(404);
    expect((res.body as Body).code).toBe('METER_ALERT_NOT_FOUND');
  });

  it('the household sees one on an asset in its unit; none on a common area', async () => {
    const inUnit = await e.asset(s, { unitId: s.unit.id });
    const mine = (await open({ assetId: inUnit }).expect(201)).body as Created;
    const area = (
      await open({ commonAreaId: (await e.area(s)).id }).expect(201)
    ).body as Created;
    await e.http('get', `/tickets/${mine.id}`, s.owner.token).expect(200);
    await e.http('get', `/tickets/${area.id}`, s.owner.token).expect(404);
  });

  it('is dispatch’s: a technician and a resident may not', async () => {
    const assetId = await e.asset(s);
    await open({ assetId }, s.techs[0].token).expect(403);
    await open({ assetId }, s.owner.token).expect(403);
  });

  it('race: two work orders for one alert at once, exactly one opened', async () => {
    const meter = await e.meter(s, { assetId: await e.asset(s) });
    const alert = await alertOn(meter.id, '2026-01-02');
    const results = await Promise.all([
      open({ meterAlertId: alert.id }),
      open({ meterAlertId: alert.id }, s.manager.token),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const tickets = await e.inTenant(s.c, (tx) =>
      tx.ticket.count({ where: { meterAlertId: alert.id } }),
    );
    expect(tickets).toBe(1);
  });
});
