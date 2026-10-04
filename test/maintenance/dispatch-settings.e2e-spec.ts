import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0033: the dispatch settings — automatic dispatch off until the manager
 * turns it on, the status weights and the priority multipliers.
 */
describe('Maintenance — dispatch settings', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
  }, 60_000);

  afterAll(() => h.close());

  it('a new compound starts off with the weights of ADR 0033', async () => {
    const res = await d
      .http('get', '/maintenance/dispatch-settings', s.manager.token)
      .expect(200);
    expect(res.body).toEqual({
      autoDispatchEnabled: false,
      weightAssigned: 1,
      weightInProgress: 2,
      weightOnHold: 0,
      multiplierNormal: 1,
      multiplierUrgent: 1.5,
      multiplierEmergency: 3,
    });
  });

  it('only the manager reads or writes them; a supervisor is refused', async () => {
    await d
      .http('get', '/maintenance/dispatch-settings', s.supervisor.token)
      .expect(403);
    await d
      .http('patch', '/maintenance/dispatch-settings', s.supervisor.token, {
        autoDispatchEnabled: true,
      })
      .expect(403);
  });

  it('a patch changes only what it names, with two decimals', async () => {
    const res = await d
      .http('patch', '/maintenance/dispatch-settings', s.manager.token, {
        multiplierUrgent: 1.75,
        weightOnHold: 0.5,
      })
      .expect(200);
    expect(res.body).toMatchObject({
      autoDispatchEnabled: false,
      weightOnHold: 0.5,
      multiplierUrgent: 1.75,
      multiplierEmergency: 3,
    });
    const on = await d
      .http('patch', '/maintenance/dispatch-settings', s.manager.token, {
        autoDispatchEnabled: true,
      })
      .expect(200);
    expect(on.body).toMatchObject({
      autoDispatchEnabled: true,
      multiplierUrgent: 1.75,
    });
  });

  it('refuses a value out of range or with more than two decimals, naming the field', async () => {
    const res = await d
      .http('patch', '/maintenance/dispatch-settings', s.manager.token, {
        weightAssigned: 100.01,
        multiplierNormal: 0.05,
        multiplierUrgent: 1.234,
      })
      .expect(400);
    expect(res.body).toMatchObject({
      fields: [
        {
          field: 'weightAssigned',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 100 },
        },
        {
          field: 'multiplierNormal',
          code: 'INVALID_NUMBER',
          params: { min: 0.1, max: 100 },
        },
        {
          field: 'multiplierUrgent',
          code: 'INVALID_NUMBER',
          params: { min: 0.1, max: 100 },
        },
      ],
    });
  });

  it('the table refuses what the service would: a zero multiplier', async () => {
    await expect(
      d.inTenant(s.c, (tx) =>
        tx.maintenanceDispatchSettings.update({
          where: { tenantId: s.c.tenantId },
          data: { multiplierEmergency: 0 },
        }),
      ),
    ).rejects.toThrow(/ranges/);
  });
});
