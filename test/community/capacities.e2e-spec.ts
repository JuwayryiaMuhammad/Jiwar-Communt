import { Client } from 'pg';
import { CapabilitiesService } from '../../src/community/capabilities/capabilities.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import { WorkersService } from '../../src/community/workers/workers.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { bornYearsAgo, codeOf, nationalIdFor } from '../setup/fixtures';
import {
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { required } from '../setup/test-env';

/** Occupancy capacities and capabilities (ADR 0020). */
describe('Capacities', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let caps: CapabilitiesService;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    caps = h.moduleRef.get(CapabilitiesService);
    globalDb = h.moduleRef.get(GlobalDbService);
  });

  afterAll(() => h.close());

  const asResident = <T>(c: Compound, id: string, fn: () => Promise<T>) =>
    x.as(c, { id, type: 'resident' }, fn);
  const mine = (c: Compound, id: string, unitId: string) =>
    asResident(c, id, () => caps.mine(unitId));

  async function landlordThenTenant() {
    const c = await x.compound('Capacity Court');
    const u = await x.unit(c);
    const landlord = x.person('landlord');
    const created = await x.asManager(c, () =>
      x.residents.createResident({
        ...landlord,
        units: [{ unitId: u.id, occupancyType: 'owner', resides: false }],
      }),
    );
    const tenant = await x.resident(c, [u.id], 'tenant');
    return { c, unitId: u.id, landlordId: created.id, tenant };
  }

  it('a landlord is never primary: the first RESIDING occupant is', async () => {
    const { c, unitId, landlordId, tenant } = await landlordThenTenant();
    const occupancies = await x.occupancies(c, unitId);
    const byAccount = (id: string) =>
      occupancies.find((o) => o.accountId === id)!;
    expect(byAccount(landlordId)).toMatchObject({
      resides: false,
      isPrimary: false,
    });
    expect(byAccount(tenant.id)).toMatchObject({
      resides: true,
      isPrimary: true,
    });
    expect(byAccount(tenant.id).primarySince).toBeInstanceOf(Date);
    expect(
      await codeOf(
        x.asManager(c, () => x.residents.setPrimary(unitId, landlordId)),
      ),
    ).toBe('PRIMARY_MUST_RESIDE');
  });

  it('the landlord never sees the household or the workers, and cannot register one', async () => {
    const { c, unitId, landlordId, tenant } = await landlordThenTenant();
    await x.joinFamily(c, unitId, tenant);
    const households = h.moduleRef.get(HouseholdsService);
    const workers = h.moduleRef.get(WorkersService);
    expect(
      await codeOf(
        asResident(c, landlordId, () => households.listMembers(unitId)),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await codeOf(
        asResident(c, landlordId, () => workers.listForUnit(unitId)),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await codeOf(
        asResident(c, landlordId, () =>
          workers.register(unitId, {
            fullName: 'Hired By Landlord',
            idDocumentType: 'national_id',
            idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
            phone: uniquePhone(),
            capacity: 'live_in',
          }),
        ),
      ),
    ).toBe('FORBIDDEN');
    // The tenant sees the household.
    expect(
      await asResident(c, tenant.id, () => households.listMembers(unitId)),
    ).toHaveLength(1);
    expect(await mine(c, landlordId, unitId)).toMatchObject({
      landlordTenantFinance: true,
      householdView: false,
      visitorsInvite: false,
      governanceVote: true,
    });
    expect(await mine(c, tenant.id, unitId)).toMatchObject({
      governanceVote: false,
      ownershipCard: true,
      householdManage: true,
    });
  });

  it('tenant → owner: two rows, the primary kept, governance opens, the person is told', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    const tenant = await x.resident(c, [u.id], 'tenant');
    const [rented] = await x.occupancies(c, u.id);
    const owned = await x.asManager(c, () =>
      x.residents.convertToOwner(rented.id),
    );
    const rows = await x.occupancies(c, u.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((o) => o.id === rented.id)).toMatchObject({
      status: 'ended',
      endReason: 'converted_to_owner',
    });
    expect(rows.find((o) => o.id === owned.id)).toMatchObject({
      status: 'active',
      occupancyType: 'owner',
      isPrimary: true,
      primarySince: rented.primarySince,
      convertedFromId: rented.id,
    });
    expect(await mine(c, tenant.id, u.id)).toMatchObject({
      governanceVote: true,
      ownershipCard: false,
    });
    // No household review: conversion is not the primary leaving.
    expect(await x.openReviews(c, u.id)).toEqual([]);
    const [mail] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: c.tenantId,
        templateKey: 'community.capacity_changed',
      },
    });
    expect(mail).toMatchObject({
      recipientAccountId: tenant.id,
      params: expect.objectContaining({ capacity: 'owner_resident' }) as object,
    });
    expect(
      await codeOf(x.asManager(c, () => x.residents.convertToOwner(owned.id))),
    ).toBe('OCCUPANCY_NOT_CONVERTIBLE');
  });

  it('the primary cannot become a landlord; another owner can', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    await x.resident(c, [u.id]);
    const [primary] = await x.occupancies(c, u.id);
    expect(
      await codeOf(
        x.asManager(c, () => x.residents.setResidence(primary.id, false)),
      ),
    ).toBe('PRIMARY_MUST_RESIDE');
    const t = await x.resident(c, [u.id], 'tenant');
    const rented = (await x.occupancies(c, u.id)).find(
      (o) => o.accountId === t.id,
    )!;
    expect(
      await codeOf(
        x.asManager(c, () => x.residents.setResidence(rented.id, false)),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('ending an occupancy needs a reason code and text; the occupant is told and the audit keeps only the code', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    const r = await x.resident(c, [u.id]);
    const [o] = await x.occupancies(c, u.id);
    expect(
      await codeOf(
        x.asManager(c, () =>
          x.residents.endOccupancy(o.id, { code: 'moved_out' }),
        ),
      ),
    ).toBe('REASON_REQUIRED');
    expect(
      await codeOf(
        x.asManager(c, () =>
          x.residents.endOccupancy(o.id, { code: 'evicted', text: 'x' }),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    await x.asManager(c, () =>
      x.residents.endOccupancy(o.id, {
        code: 'moved_out',
        text: 'Keys returned to Omar',
      }),
    );
    const [mail] = await globalDb.outboxMessage.findMany({
      where: { tenantId: c.tenantId, templateKey: 'community.occupancy_ended' },
    });
    expect(mail).toMatchObject({
      recipient: r.email,
      recipientAccountId: r.id,
      params: expect.objectContaining({
        reason: 'Keys returned to Omar',
      }) as object,
    });
    const [entry] = await auditReaders(h).tenant(c.tenantId, {
      action: 'occupancy.ended',
      targetId: o.id,
    });
    expect(entry.metadata).toMatchObject({ reasonCode: 'moved_out' });
    expect(JSON.stringify(entry)).not.toContain('Omar');
    // Archive: view only, emergency until handover.
    expect(await mine(c, r.id, u.id)).toMatchObject({
      archiveView: true,
      emergency: true,
      householdView: false,
    });
    await x.asManager(c, () => x.residents.recordHandover(o.id));
    expect((await mine(c, r.id, u.id)).emergency).toBe(false);
    expect(
      await codeOf(x.asManager(c, () => x.residents.recordHandover(o.id))),
    ).toBe('OCCUPANCY_NOT_FOUND');
  });

  it('closed-unit mode: only the owner-resident primary sets it, and the card appears', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    const t = await x.resident(c, [u.id], 'tenant');
    expect(
      await codeOf(
        asResident(c, t.id, () => x.residents.setUnitClosed(u.id, true)),
      ),
    ).toBe('NOT_PRIMARY_RESIDENT');
    const c2 = await x.compound();
    const u2 = await x.unit(c2);
    const owner = await x.resident(c2, [u2.id]);
    await asResident(c2, owner.id, () =>
      x.residents.setUnitClosed(u2.id, true),
    );
    expect(await mine(c2, owner.id, u2.id)).toMatchObject({
      closedUnitCard: true,
    });
  });

  it('the owner of several units has independent capabilities on each', async () => {
    const c = await x.compound();
    const a = await x.unit(c);
    const b = await x.unit(c);
    const p = x.person('multi');
    const created = await x.asManager(c, () =>
      x.residents.createResident({
        ...p,
        units: [
          { unitId: a.id, occupancyType: 'owner' },
          { unitId: b.id, occupancyType: 'owner', resides: false },
        ],
      }),
    );
    expect(await mine(c, created.id, a.id)).toMatchObject({
      householdManage: true,
      householdView: true,
    });
    expect(await mine(c, created.id, b.id)).toMatchObject({
      householdManage: false,
      householdView: false,
      landlordTenantFinance: true,
    });
  });

  it('tenant B cannot convert, move or hand over A’s occupancies', async () => {
    const a = await x.compound();
    const b = await x.compound();
    const u = await x.unit(a);
    await x.resident(a, [u.id], 'tenant');
    const [o] = await x.occupancies(a, u.id);
    for (const call of [
      () => x.residents.convertToOwner(o.id),
      () => x.residents.setResidence(o.id, true),
      () => x.residents.recordHandover(o.id),
    ]) {
      expect(await codeOf(x.asManager(b, call))).toBe('OCCUPANCY_NOT_FOUND');
    }
  });

  it('the database refuses a non-residing tenant and a landlord primary', async () => {
    const db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
    try {
      const c = await x.compound();
      const u = await x.unit(c);
      await x.resident(c, [u.id], 'tenant');
      const [o] = await x.occupancies(c, u.id);
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        c.tenantId,
      ]);
      await expect(
        db.query(`UPDATE unit_occupancies SET resides = false WHERE id = $1`, [
          o.id,
        ]),
      ).rejects.toThrow(/unit_occupancies_(tenant|primary)_resides/);
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
  });
});
