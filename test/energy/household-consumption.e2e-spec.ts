import { Prisma } from '@prisma/client';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { lastDay } from '../../src/maintenance/energy/household-consumption-rules';
import { err } from '../api/request';
import type { Compound } from '../setup/community';
import { at, day, month, today } from '../setup/compound-clock';
import { engagementHelpers, type Who } from '../setup/engagement';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface MonthBody {
  month: string;
  use: string;
  estimatedCost: string | null;
  complete: boolean;
}
interface KindBody {
  kind: string;
  unit: string;
  meters: number;
  use: string;
  estimatedCost: string | null;
  months: MonthBody[];
  compare: {
    month: string;
    use: string;
    previousMonth: { month: string; use: string } | null;
    sameMonthLastYear: { month: string; use: string } | null;
  } | null;
}
interface HouseholdBody {
  unitId: string;
  since: string;
  kinds: KindBody[];
}

/**
 * ADR 0069: a household reads its unit's consumption over its own tenure
 * only — periods between two readings on or after the day it came, so
 * nothing of a household before it shows; a landlord never reads it; its
 * months compare with each other, and with other homes only as an
 * aggregate of at least five other units of its building; a spike on its
 * meter reaches it only when the mean it beat was all its own.
 */
describe('Energy — a household’s own consumption', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let c: Compound;
  let manager: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    c = await e.x.compound('Household Energy Court');
    manager = await e.who(c, c.managerId, 'manager');
    await e
      .http('post', '/maintenance/energy/tariffs', manager.token, {
        kind: 'electricity',
        effectiveOn: day(-390),
        pricePerUnit: '2',
      })
      .expect(201);
  }, 90_000);

  afterAll(() => h.close());

  /** A unit in its own building (or `building`), with a floor area. */
  async function home(building = `B-${uniqueSuffix()}`, areaSqm = '100') {
    const u = await e.unit(c, building);
    await e.inTx(c, (tx) =>
      tx.unit.update({ where: { id: u.id }, data: { areaSqm } }),
    );
    return u;
  }

  async function meter(unitId: string, kind = 'electricity') {
    return (
      await e
        .http('post', '/maintenance/meters', manager.token, {
          code: `M-${uniqueSuffix()}`,
          kind,
          unitId,
        })
        .expect(201)
    ).body as { id: string };
  }

  async function read(m: { id: string }, readings: [string, string][]) {
    for (const [readOn, value] of readings)
      await e
        .http('post', `/maintenance/meters/${m.id}/readings`, manager.token, {
          readOn,
          value,
        })
        .expect(201);
  }

  /** The household came on `readOn`'s noon, as a move-in would record it. */
  const cameOn = (accountId: string, unitId: string, d: string) =>
    e.inTx(c, (tx) =>
      tx.unitOccupancy.updateMany({
        where: { accountId, unitId, status: 'active' },
        data: { residesSince: at(d, 12) },
      }),
    );

  const end = (m: number) => lastDay(month(m));

  const mine = (who: Who, unitId: string, query = '') =>
    e.http('get', `/units/${unitId}/consumption${query}`, who.token);

  it('reads only the periods that began in the household’s time, by month, compared, at the tariff as an estimate', async () => {
    const u = await home();
    const owner = await e.owner(c, u.id);
    const m = await meter(u.id);
    await read(m, [
      [end(-5), '1000'],
      [end(-4), '1100'],
      [end(-3), '1200'],
      [end(-2), '1350'],
      [end(-1), '1450'],
    ]);
    await cameOn(owner.id, u.id, end(-3));
    const body = (
      await mine(owner, u.id, `?from=${day(-200)}&to=${today()}`).expect(200)
    ).body as HouseholdBody;
    expect(body.since).toBe(end(-3));
    expect(body.kinds).toEqual([
      {
        kind: 'electricity',
        unit: 'kWh',
        meters: 1,
        // The two periods before it never count, however the window reads.
        use: '250.0000',
        estimatedCost: '500.00',
        months: [
          {
            month: month(-2),
            use: '150.0000',
            estimatedCost: '300.00',
            complete: true,
          },
          {
            month: month(-1),
            use: '100.0000',
            estimatedCost: '200.00',
            complete: true,
          },
        ],
        compare: {
          month: month(-1),
          use: '100.0000',
          previousMonth: { month: month(-2), use: '150.0000' },
          sameMonthLastYear: null,
        },
      },
    ]);
    // The staff's view of the same meter still reads every period.
    const staff = (
      await e
        .http(
          'get',
          `/maintenance/meters/${m.id}/consumption?from=${day(-200)}&to=${today()}`,
          manager.token,
        )
        .expect(200)
    ).body as { use: string };
    expect(staff.use).toBe('450.0000');
  });

  it('who reads it: who lives there and a member given finance; a landlord is refused, a stranger finds no unit', async () => {
    const u = await home();
    const landlord = await e.landlord(c, u.id);
    const tenant = await e.tenant(c, u.id);
    await meter(u.id);
    await mine(tenant, u.id).expect(200);
    expect(err(await mine(landlord, u.id).expect(403)).code).toBe(
      'CONSUMPTION_NOT_ALLOWED',
    );
    const member = await e.family(c, u.id, tenant);
    expect(err(await mine(member, u.id).expect(403)).code).toBe(
      'CONSUMPTION_NOT_ALLOWED',
    );
    await e.x.as(c, { id: tenant.id, type: 'resident' }, () =>
      h.moduleRef
        .get(MemberPermissionsService)
        .grant(member.memberId, 'finance', { capPerOperation: '100.00' }),
    );
    await mine(member, u.id).expect(200);
    const stranger = await e.owner(c, (await home()).id);
    expect(err(await mine(stranger, u.id).expect(404)).code).toBe(
      'UNIT_NOT_FOUND',
    );
  });

  it('an owner who moves back in after a tenant reads from the day they came back, never the tenant’s use', async () => {
    const u = await home();
    const owner = await e.landlord(c, u.id);
    const tenant = await e.tenant(c, u.id);
    const m = await meter(u.id);
    await cameOn(tenant.id, u.id, end(-4));
    await read(m, [
      [end(-4), '10'],
      [end(-3), '60'],
      [end(-2), '110'],
    ]);
    const tenancy = (await e.x.occupancies(c, u.id)).find(
      (o) => o.accountId === tenant.id,
    )!;
    await e.x.asManager(c, () =>
      e.x.residents.endOccupancy(tenancy.id, {
        code: 'moved_out',
        text: 'Moved out',
      }),
    );
    const own = (await e.x.occupancies(c, u.id)).find(
      (o) => o.accountId === owner.id,
    )!;
    await e.x.asManager(c, () => e.x.residents.setResidence(own.id, true));
    const body = (
      await mine(owner, u.id, `?from=${day(-200)}&to=${today()}`).expect(200)
    ).body as HouseholdBody;
    expect(body.since).toBe(today());
    expect(body.kinds[0]).toMatchObject({
      use: '0.0000',
      months: [],
      compare: null,
    });
  });

  it('the database keeps resides_since: a residing start, cleared when someone stops living there, set when they come back, a converted owner keeps the tenant’s', async () => {
    const u = await home();
    const tenant = await e.tenant(c, u.id);
    const live = async (unitId: string, accountId: string) =>
      (await e.x.occupancies(c, unitId)).find(
        (o) => o.accountId === accountId && o.status === 'active',
      )!;
    const first = await live(u.id, tenant.id);
    expect(first.residesSince).toEqual(first.startedAt);
    await cameOn(tenant.id, u.id, end(-6));
    await e.x.asManager(c, () => e.x.residents.convertToOwner(first.id));
    const owner = await live(u.id, tenant.id);
    expect(owner.id).not.toBe(first.id);
    expect(owner.convertedFromId).toBe(first.id);
    expect(owner.residesSince).toEqual(at(end(-6), 12));

    const away = await home();
    const landlord = await e.landlord(c, away.id);
    const row = await live(away.id, landlord.id);
    expect(row.residesSince).toBeNull();
    const set = (resides: boolean) =>
      e.inTx(c, (tx) =>
        tx.unitOccupancy.update({ where: { id: row.id }, data: { resides } }),
      );
    const back = await set(true);
    expect(back.residesSince!.getTime()).toBeGreaterThanOrEqual(
      row.createdAt.getTime(),
    );
    expect((await set(false)).residesSince).toBeNull();
  });

  describe('against other homes of the building', () => {
    const building = `Bench-${uniqueSuffix()}`;
    const days = Number(end(-1).slice(8));
    let caller: { unitId: string; owner: Who };

    /** A home of the building read all of last month, `use` in it. */
    async function neighbour(use: number, areaSqm = '100') {
      const u = await home(building, areaSqm);
      const owner = await e.owner(c, u.id);
      await cameOn(owner.id, u.id, end(-3));
      await read(await meter(u.id), [
        [end(-2), '1000'],
        [end(-1), String(1000 + use)],
      ]);
      return { unitId: u.id, owner };
    }
    const bench = (q: string) =>
      e.http(
        'get',
        `/units/${caller.unitId}/consumption/benchmark${q}`,
        caller.owner.token,
      );
    const perSqmDay = (use: number) =>
      new Prisma.Decimal(use).dividedBy(100).dividedBy(days).toFixed(4);

    beforeAll(async () => {
      caller = await neighbour(50);
      for (const use of [100, 200, 300, 400]) await neighbour(use);
    }, 90_000);

    it('fewer than five other homes read all month: none', async () => {
      expect(
        (await bench(`?kind=electricity&month=${month(-1)}`).expect(200)).body,
      ).toMatchObject({
        available: false,
        reason: 'TOO_FEW_UNITS',
        units: null,
        medianPerSqmDay: null,
        meanPerSqmDay: null,
        mine: null,
      });
    });

    it('five other homes: their median and mean a square metre a day, and the household’s own — never which homes', async () => {
      await neighbour(500);
      // A home that came mid-month is not compared.
      const late = await neighbour(9000);
      await cameOn(late.owner.id, late.unitId, day(-1));
      const body = (
        await bench(`?kind=electricity&month=${month(-1)}`).expect(200)
      ).body as Record<string, unknown>;
      expect(body).toEqual({
        kind: 'electricity',
        unit: 'kWh',
        month: month(-1),
        available: true,
        reason: null,
        units: 5,
        medianPerSqmDay: perSqmDay(300),
        meanPerSqmDay: perSqmDay(300),
        mine: perSqmDay(50),
      });
    });

    it('only a month that has ended; a unit in no building has none', async () => {
      expect(
        err(await bench(`?kind=electricity&month=${month(0)}`).expect(400))
          .fields,
      ).toEqual([
        {
          field: 'month',
          code: 'INVALID_VALUE',
          params: { latest: month(-1) },
        },
      ]);
      const loose = await e.unit(c, null);
      const owner = await e.owner(c, loose.id);
      expect(
        (
          await e
            .http(
              'get',
              `/units/${loose.id}/consumption/benchmark?kind=electricity&month=${month(-1)}`,
              owner.token,
            )
            .expect(200)
        ).body,
      ).toMatchObject({ available: false, reason: 'NO_BUILDING' });
    });
  });

  describe('a spike on the unit’s meter', () => {
    /** 10 a day for three periods, then 60 a day: a spike today. */
    const spiking: [string, string][] = [
      [day(-40), '1000'],
      [day(-30), '1100'],
      [day(-20), '1200'],
      [day(-10), '1300'],
    ];
    const told = (accountId: string) =>
      e.notifications(c, accountId, 'meter.unit_spike');

    it('reaches who reads the consumption, the kind and the day only, when the mean was all the household’s', async () => {
      const u = await home();
      const landlord = await e.landlord(c, u.id);
      const tenant = await e.tenant(c, u.id);
      await cameOn(tenant.id, u.id, day(-45));
      const m = await meter(u.id, 'water');
      await read(m, [...spiking, [day(0), '1900']]);
      const [notice] = await told(tenant.id);
      expect(notice).toMatchObject({
        kind: 'meter.unit_spike',
        targetType: 'unit',
        targetId: u.id,
        params: { meterKind: 'water', readOn: day(0) },
      });
      expect(await told(landlord.id)).toEqual([]);
      // The staff are told as before.
      expect(await e.notifications(c, manager.id, 'meter.anomaly')).not.toEqual(
        [],
      );
    });

    it('stays with the staff when the mean reaches back before the household came', async () => {
      const u = await home();
      const owner = await e.owner(c, u.id);
      await cameOn(owner.id, u.id, day(-25));
      const m = await meter(u.id, 'water');
      await read(m, [...spiking, [day(0), '1900']]);
      expect(await told(owner.id)).toEqual([]);
    });
  });
});
