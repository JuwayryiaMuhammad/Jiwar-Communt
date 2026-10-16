import { addDays, localDate } from '../../src/core/common/slots/day-slots';
import { PERMIT_LIMITS } from '../../src/gate/permits/permit-rules';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitHelpers, type PermitSetUp } from '../setup/permits';

const ZONE = 'Africa/Cairo';

describe('Permits — the compound’s rules (ADR 0049)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let s: PermitSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    s = await p.setUp('Permit Rules Court');
  }, 180_000);

  afterAll(() => h.close());

  const today = () => localDate(new Date(), ZONE);

  it('a new compound starts with Saturday to Thursday, 09:00–17:00 and no days off', async () => {
    const res = await p
      .http('get', '/staff/permit-settings', s.manager.token)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      workDays: [0, 1, 2, 3, 4, 6],
      workHours: { from: '09:00', to: '17:00' },
      daysOff: [],
    });
  });

  it('the manager changes them: sorted, repeats dropped, audited by value; the same again records nothing', async () => {
    const c = await p.setUp('Permit Rules Change Court');
    const body = await p.setRules(c.manager, {
      workDays: [4, 0, 4, 1],
      workHours: { from: '08:30', to: '16:00' },
      daysOff: [addDays(today(), 9), addDays(today(), 3), addDays(today(), 3)],
    });
    expect(body).toEqual({
      workDays: [0, 1, 4],
      workHours: { from: '08:30', to: '16:00' },
      daysOff: [addDays(today(), 3), addDays(today(), 9)],
    });
    const rows = await p.v.x.asManager(c.c, () =>
      p.v.x.prisma.tenant.auditLog.findMany({
        where: { action: 'permit_settings.changed' },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: c.manager.id,
      targetType: 'tenant',
      targetId: c.c.tenantId,
      changes: {
        workDays: { from: [0, 1, 2, 3, 4, 6], to: [0, 1, 4] },
        workHours: {
          from: { from: '09:00', to: '17:00' },
          to: { from: '08:30', to: '16:00' },
        },
        daysOff: { from: [], to: body.daysOff },
      },
    });
    await p.setRules(c.manager, { workDays: [1, 0, 4] });
    expect(
      await p.v.x.asManager(c.c, () =>
        p.v.x.prisma.tenant.auditLog.count({
          where: { action: 'permit_settings.changed' },
        }),
      ),
    ).toBe(1);
  });

  it('refuses hours that end before they start, an empty week, a bad day and too many days off', async () => {
    const bad = async (body: object) =>
      (
        (
          await p
            .http('patch', '/staff/permit-settings', s.manager.token, body)
            .expect(400)
        ).body as { fields: unknown }
      ).fields;
    expect(await bad({ workHours: { from: '17:00', to: '09:00' } })).toEqual([
      { field: 'workHours.to', code: 'ENDS_BEFORE_START' },
    ]);
    expect(await bad({ workHours: { from: '09:00', to: '09:00' } })).toEqual([
      { field: 'workHours.to', code: 'ENDS_BEFORE_START' },
    ]);
    expect(await bad({ workDays: [] })).toEqual([
      {
        field: 'workDays',
        code: 'INVALID_LENGTH',
        params: { min: 1, max: 7 },
      },
    ]);
    expect(await bad({ workDays: [7] })).toEqual([
      { field: 'workDays', code: 'INVALID_NUMBER', params: { min: 0, max: 6 } },
    ]);
    expect(await bad({ daysOff: ['2026-13-01'] })).toEqual([
      { field: 'daysOff', code: 'INVALID_FORMAT' },
    ]);
    const many = Array.from({ length: PERMIT_LIMITS.daysOff + 1 }, (_, i) =>
      addDays(today(), i),
    );
    expect(await bad({ daysOff: many })).toEqual([
      {
        field: 'daysOff',
        code: 'INVALID_LENGTH',
        params: { min: 0, max: PERMIT_LIMITS.daysOff },
      },
    ]);
    // Nothing changed.
    expect(
      (await p.http('get', '/staff/permit-settings', s.manager.token)).body,
    ).toMatchObject({ workHours: { from: '09:00', to: '17:00' } });
  });

  it('the database refuses what the API would never write', async () => {
    const write = (sql: string) =>
      p.v.inTx(s.c, (tx) => tx.$executeRawUnsafe(sql));
    for (const sql of [
      `UPDATE permit_settings SET work_from = 600, work_to = 600`,
      `UPDATE permit_settings SET work_to = 1440`,
      `UPDATE permit_settings SET work_days = '{}'`,
      `UPDATE permit_settings SET work_days = '{7}'`,
      `UPDATE permit_settings SET work_days = '{1,NULL}'`,
      `UPDATE permit_settings SET days_off = ARRAY[NULL]::date[]`,
      `UPDATE permit_settings SET days_off = (SELECT array_agg(current_date + i) FROM generate_series(0, 100) i)`,
    ])
      await expect(write(sql)).rejects.toThrow(/permit_settings_/);
  });

  it('residents and guards read the rules: the days off from today on, the time zone and the limits', async () => {
    const c = await p.setUp('Permit Rules Read Court');
    await p.setRules(c.manager, {
      daysOff: [addDays(today(), -2), today(), addDays(today(), 5)],
    });
    const guard = await p.guardOnDuty(c.c);
    for (const as of [c.alice, guard]) {
      const res = await p
        .http('get', '/community/permit-rules', as.token)
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        workDays: [0, 1, 2, 3, 4, 6],
        workHours: { from: '09:00', to: '17:00' },
        daysOff: [today(), addDays(today(), 5)],
        timeZone: ZONE,
        limits: { ...PERMIT_LIMITS },
      });
    }
    // The management's own view keeps the past ones.
    expect(
      (
        (await p.http('get', '/staff/permit-settings', c.manager.token))
          .body as { daysOff: string[] }
      ).daysOff,
    ).toEqual([addDays(today(), -2), today(), addDays(today(), 5)]);
  });
});
