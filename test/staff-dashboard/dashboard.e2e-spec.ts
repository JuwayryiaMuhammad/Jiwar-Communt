import { Prisma } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { clock, dbClock, dbDate, day } from '../setup/compound-clock';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

interface Summary {
  date: string;
  timeZone: string;
  figures: Record<string, Record<string, unknown> | null>;
  inbox: { total: number; overdue: number } | null;
  liquidityDays: null;
}

interface Alert {
  section: string;
  code: string;
  severity: string;
  count: number;
}

interface NeedsYou {
  alerts: Alert[];
  items: { type: string; id: string; overdue: boolean }[] | null;
  inbox: { total: number; overdue: number } | null;
}

interface BuildingStatus {
  id: string;
  name: string;
  band: string;
  units: { units: number; occupied: number } | null;
  maintenance: { open: number; overdue: number; emergencyOpen: number } | null;
  energy: { outagesActive: number } | null;
}

/** Numbers unique in the suite's compounds. */
let seq = 0;

/**
 * ADR 0079: the operations dashboard. The cards in one call, each section
 * to the holders of its own domain's permission and null to the others;
 * on the compound's local day; counts and amounts of the compound only,
 * another compound's rows never counted (RLS). "Needs you now": the
 * alerts, the critical first, then the inbox's overdue items. Every
 * building's status, with its band.
 */
describe('Operations dashboard — the cards, needs you now and the buildings', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let other: SetUp;
  let accountant: Who;
  let security: Who;
  let towerId: string;
  let otherTowerId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    other = await d.setUp(1);
    accountant = await d.who(
      s.c,
      (await d.g.guard(s.c, 'accountant')).id,
      'staff',
    );
    security = await d.who(
      s.c,
      (await d.g.guard(s.c, 'security_supervisor')).id,
      'staff',
    );
    towerId = await inTx(async (tx) => {
      const id = newId();
      await tx.building.create({
        data: { id, tenantId: s.c.tenantId, name: `Tower ${id.slice(-6)}` },
      });
      await tx.unit.update({
        where: { id: s.unit.id },
        data: { buildingId: id },
      });
      return id;
    });
    otherTowerId = await d.inTenant(other.c, async (tx) => {
      const id = newId();
      await tx.building.create({
        data: { id, tenantId: other.c.tenantId, name: `Tower ${id.slice(-6)}` },
      });
      return id;
    });
  }, 180_000);

  afterAll(() => h.close());

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    d.inTenant(s.c, fn);

  const get = async <T>(path: string, who: Who = s.manager) =>
    (await d.http('get', path, who.token).expect(200)).body as T;

  const summary = (who?: Who) => get<Summary>('/staff/dashboard', who);

  async function assign(ticketId: string) {
    await d
      .http(
        'post',
        `/maintenance/tickets/${ticketId}/assign`,
        s.supervisor.token,
        {
          technicianId: s.techs[0].id,
        },
      )
      .expect(204);
  }

  /** An invoice of the home due `dueOn`, of `total` EGP, with its line. */
  async function invoice(dueOn: string, total: string): Promise<void> {
    await inTx(async (tx) => {
      const batchId = newId();
      await tx.invoiceBatch.create({
        data: {
          id: batchId,
          tenantId: s.c.tenantId,
          target: 'unit',
          unitId: s.unit.id,
          kind: 'other',
          unitCount: 1,
          issuedOn: dbDate(day(-30)),
          dueOn: dbDate(dueOn),
          createdById: s.manager.id,
        },
      });
      const id = newId();
      await tx.invoice.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          number: 790_000 + ++seq,
          batchId,
          unitId: s.unit.id,
          kind: 'other',
          total: new Prisma.Decimal(total),
          currency: 'EGP',
          issuedOn: dbDate(day(-30)),
          dueOn: dbDate(dueOn),
          createdById: s.manager.id,
        },
      });
      await tx.invoiceLine.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          invoiceId: id,
          position: 1,
          descriptionEn: 'Line',
          descriptionAr: 'بند',
          amount: new Prisma.Decimal(total),
        },
      });
    });
  }

  it('is the dashboard.read holders’: a technician is refused', async () => {
    await d.http('get', '/staff/dashboard', s.techs[0].token).expect(403);
    await d
      .http('get', '/staff/dashboard/needs-you', s.techs[0].token)
      .expect(403);
    await d
      .http('get', '/staff/dashboard/buildings', s.techs[0].token)
      .expect(403);
  });

  it('counts the tickets on the compound’s day, never another compound’s', async () => {
    const before = (await summary()).figures.maintenance!;
    const normal = await d.openTicket(s);
    await d.openTicket(s, { priority: 'emergency' });
    await d.openTicket(other, { priority: 'emergency' });
    await assign(normal);
    const now = await summary();
    expect(now.date).toBe(clock().today);
    expect(now.timeZone).toBe('Africa/Cairo');
    expect(now.figures.maintenance).toMatchObject({
      slaEnabled: false,
      open: (before.open as number) + 2,
      unassigned: (before.unassigned as number) + 1,
      emergencyOpen: (before.emergencyOpen as number) + 1,
      emergencyUnassigned: (before.emergencyUnassigned as number) + 1,
      openedToday: (before.openedToday as number) + 2,
      overdue: 0,
      atRisk: 0,
      pressure: {
        threshold: null,
        available: expect.any(Number) as unknown,
        underPressure: false,
        since: null,
      },
    });
    expect(now.liquidityDays).toBeNull();
  });

  it('shows each section to its own permission’s holders, null to the others', async () => {
    const manager = await summary();
    for (const section of [
      'units',
      'maintenance',
      'energy',
      'security',
      'gate',
      'finance',
    ])
      expect(manager.figures[section]).not.toBeNull();
    expect(manager.inbox).not.toBeNull();

    // The maintenance supervisor: tickets.dispatch, energy.read, inbox.read.
    const dispatch = await summary(s.supervisor);
    expect(
      Object.entries(dispatch.figures)
        .filter(([, f]) => f !== null)
        .map(([k]) => k)
        .sort(),
    ).toEqual(['energy', 'maintenance']);

    const money = await summary(accountant);
    expect(
      Object.entries(money.figures)
        .filter(([, f]) => f !== null)
        .map(([k]) => k),
    ).toEqual(['finance']);

    // The security supervisor: incidents.manage and units.directory.
    const guardDesk = await summary(security);
    expect(
      Object.entries(guardDesk.figures)
        .filter(([, f]) => f !== null)
        .map(([k]) => k)
        .sort(),
    ).toEqual(['security', 'units']);
  });

  it('finance: what is due this month and the share paid, and what is owed past its day', async () => {
    const before = (await summary(accountant)).figures.finance!;
    await invoice(day(0), '100.00');
    await invoice(day(-1), '40.00');
    const sameMonth = day(-1).slice(0, 7) === day(0).slice(0, 7);
    const after = (await summary(accountant)).figures.finance!;
    const dueBefore = Number(before.dueMonth);
    expect(Number(after.dueMonth)).toBeCloseTo(
      dueBefore + 100 + (sameMonth ? 40 : 0),
    );
    expect(after.overdueInvoices).toBe((before.overdueInvoices as number) + 1);
    expect(Number(after.overdueAmount)).toBeCloseTo(
      Number(before.overdueAmount) + 40,
    );
    expect(after.collectionRate).toBe(0);
    expect(after.currency).toBe('EGP');
    // Amounts, never a unit or a payer.
    expect(JSON.stringify(after)).not.toContain(s.unit.code);
  });

  it('the units: occupied, vacant and closed add up to the units', async () => {
    const u = (await summary()).figures.units as Record<string, number>;
    expect(u.occupied + u.vacant + u.closed).toBe(u.units);
    expect(u.occupied).toBeGreaterThanOrEqual(1);
  });

  it('needs you now: the critical alerts first, then the inbox’s overdue items', async () => {
    const vehicle = await inTx(async (tx) => {
      const id = newId();
      await tx.vehicle.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          number: 780_000 + ++seq,
          unitId: s.unit.id,
          registeredById: s.owner.id,
          plate: `DSH ${id.slice(-6)}`,
          makeAndModel: 'Dashboard car',
          color: 'Grey',
          type: 'car',
          // Past the vehicle's 72 hours.
          createdAt: clock().at(day(-5), 9),
        },
      });
      return id;
    });
    const n = await get<NeedsYou>('/staff/dashboard/needs-you');
    expect(n.alerts[0]).toEqual({
      section: 'maintenance',
      code: 'emergency_unassigned',
      severity: 'critical',
      count: expect.any(Number) as unknown,
    });
    const severities = n.alerts.map((a) => a.severity);
    expect(severities).toEqual([...severities].sort());
    expect(n.items![0]).toMatchObject({
      type: 'vehicle',
      id: vehicle,
      overdue: true,
    });
    expect(n.inbox!.overdue).toBeGreaterThanOrEqual(1);

    // The accountant reads no ticket: no maintenance alert; no vehicle.
    const theirs = await get<NeedsYou>(
      '/staff/dashboard/needs-you',
      accountant,
    );
    expect(theirs.alerts.filter((a) => a.section === 'maintenance')).toEqual(
      [],
    );
    expect((theirs.items ?? []).map((i) => i.id)).not.toContain(vehicle);
  });

  it('the buildings: each with its units, tickets and outages, critical with an emergency open', async () => {
    const res = await get<{ buildings: BuildingStatus[] }>(
      '/staff/dashboard/buildings',
    );
    const tower = res.buildings.find((b) => b.id === towerId)!;
    expect(tower.units).toEqual({ units: 1, occupied: 1 });
    expect(tower.maintenance).toMatchObject({ emergencyOpen: 1 });
    expect(tower.maintenance!.open).toBeGreaterThanOrEqual(2);
    expect(tower.band).toBe('critical');
    // Another compound's buildings are not listed.
    expect(res.buildings.map((b) => b.id)).not.toContain(otherTowerId);

    // The accountant reads none of the three sections: names and bands only.
    const theirs = await get<{ buildings: BuildingStatus[] }>(
      '/staff/dashboard/buildings',
      accountant,
    );
    expect(theirs.buildings.find((b) => b.id === towerId)).toEqual({
      id: towerId,
      name: tower.name,
      band: 'ok',
      units: null,
      maintenance: null,
      energy: null,
    });
  });

  it('an outage in force over the building counts on it and on the energy card', async () => {
    const before = (await summary()).figures.energy as Record<string, number>;
    const tower = await inTx((tx) =>
      tx.building.findUniqueOrThrow({ where: { id: towerId } }),
    );
    const now = dbClock();
    await inTx((tx) =>
      tx.utilityOutage.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          kind: 'water',
          planned: false,
          scope: 'buildings',
          buildings: [tower.name],
          startsAt: clock().at(day(-1), 9),
          endsAt: clock().at(day(1), 9),
          createdById: s.manager.id,
          createdAt: now,
        },
      }),
    );
    const after = (await summary()).figures.energy as Record<string, number>;
    expect(after.outagesActive).toBe(before.outagesActive + 1);
    const res = await get<{ buildings: BuildingStatus[] }>(
      '/staff/dashboard/buildings',
    );
    expect(res.buildings.find((b) => b.id === towerId)!.energy).toEqual({
      outagesActive: 1,
    });
  });

  it('the day is the compound’s own, in its time zone', async () => {
    await inTx((tx) =>
      tx.tenantSettings.update({
        where: { tenantId: s.c.tenantId },
        data: { timezone: 'Pacific/Kiritimati' },
      }),
    );
    try {
      const res = await summary();
      expect(res.timeZone).toBe('Pacific/Kiritimati');
      expect(res.date).toBe(clock('Pacific/Kiritimati').today);
    } finally {
      await inTx((tx) =>
        tx.tenantSettings.update({
          where: { tenantId: s.c.tenantId },
          data: { timezone: 'Africa/Cairo' },
        }),
      );
    }
  });
});
