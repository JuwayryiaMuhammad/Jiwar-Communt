import { ClsService } from 'nestjs-cls';
import { PermissionsService } from '../../src/core/access/permissions.service';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { PrismaService } from '../../src/core/database/prisma.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { TenantsService } from '../../src/core/platform/tenants.service';
import { ResidentsService } from '../../src/community/residents/residents.service';
import type { NewResident } from '../../src/community/residents/residents.types';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { loginViaOtp, type Tokens } from '../setup/login';
import { MOVED_OUT } from '../setup/fixtures';

/** Residents, multi-unit occupancy and unit resource access (ADR 0012). */
describe('Residents', () => {
  let h: HttpHarness;
  let residents: ResidentsService;
  let tenants: TenantsService;
  let permissions: PermissionsService;
  let prisma: PrismaService;
  let cls: ClsService<AppClsStore>;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    residents = h.moduleRef.get(ResidentsService);
    tenants = h.moduleRef.get(TenantsService);
    permissions = h.moduleRef.get(PermissionsService);
    prisma = h.moduleRef.get(PrismaService);
    cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
  });

  afterAll(() => h.close());

  interface Compound {
    tenantId: string;
    managerId: string;
    managerToken: string;
    units: Record<string, string>;
  }

  async function compound(
    codes = ['A-101', 'A-102', 'A-103'],
  ): Promise<Compound> {
    const created = await tenants.createTenant({
      name: 'Residents Court',
      manager: {
        fullName: 'Manager',
        idDocumentType: 'national_id' as const,
        idDocumentNumber: '29001010134444',
        phone: uniquePhone(),
        email: uniqueEmail('mgr'),
      },
    });
    const managerId = created.managers[0].id;
    const managerToken = await h.tokenFor({
      sub: managerId,
      tid: created.id,
      typ: 'manager',
    });
    const units: Record<string, string> = {};
    for (const code of codes) {
      const res = await h
        .http()
        .post(`${API}/units`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ code })
        .expect(201);
      units[code] = (res.body as { id: string }).id;
    }
    return { tenantId: created.id, managerId, managerToken, units };
  }

  /** As the manager, like a guarded request would run it. */
  const asManager = <T>(c: Compound, fn: () => Promise<T>) =>
    cls.run(async () => {
      cls.set('tenantId', c.tenantId);
      cls.set('accountId', c.managerId);
      cls.set('accountType', 'manager');
      return await fn();
    });

  const asResident = <T>(
    c: Compound,
    accountId: string,
    fn: () => Promise<T>,
  ) =>
    cls.run(async () => {
      cls.set('tenantId', c.tenantId);
      cls.set('accountId', accountId);
      cls.set('accountType', 'resident');
      return await fn();
    });

  function newResident(units: NewResident['units']): NewResident {
    return {
      fullName: 'Mona Resident',
      idDocumentType: 'national_id' as const,
      idDocumentNumber: '29001010156666',
      phone: uniquePhone(),
      email: uniqueEmail('res'),
      units,
    };
  }

  const get = (tokens: Tokens, path: string) =>
    h
      .http()
      .get(`${API}${path}`)
      .set('Authorization', `Bearer ${tokens.accessToken}`);

  it('a resident owns one unit and rents another, and sees exactly those', async () => {
    const c = await compound();
    const input = newResident([
      { unitId: c.units['A-101'], occupancyType: 'owner' },
      { unitId: c.units['A-102'], occupancyType: 'tenant' },
    ]);
    const resident = await asManager(c, () => residents.createResident(input));

    expect(
      resident.occupancies.map((o) => [o.unitCode, o.occupancyType, o.status]),
    ).toEqual([
      ['A-101', 'owner', 'active'],
      ['A-102', 'tenant', 'active'],
    ]);

    // Through the real login flow and the real endpoints.
    const tokens = await loginViaOtp(h, input.email, resident.id);
    const units = await get(tokens, '/units').expect(200);
    expect((units.body as { code: string }[]).map((u) => u.code)).toEqual([
      'A-101',
      'A-102',
    ]);

    const mine = await asResident(c, resident.id, () => residents.myUnits());
    expect(mine.map((u) => [u.code, u.occupancyType])).toEqual([
      ['A-101', 'owner'],
      ['A-102', 'tenant'],
    ]);
    const profile = await asResident(c, resident.id, () =>
      residents.myProfile(),
    );
    expect(profile).toMatchObject({ id: resident.id, email: input.email });
  });

  it('another unit of the same compound is not found — not forbidden', async () => {
    const c = await compound();
    const input = newResident([
      { unitId: c.units['A-101'], occupancyType: 'owner' },
    ]);
    const resident = await asManager(c, () => residents.createResident(input));
    const tokens = await loginViaOtp(h, input.email, resident.id);

    await get(tokens, `/units/${c.units['A-101']}`).expect(200);
    const res = await get(tokens, `/units/${c.units['A-103']}`).expect(404);
    expect(res.body).toMatchObject({ code: 'UNIT_NOT_FOUND' });
    // The manager sees every unit of his compound.
    await h
      .http()
      .get(`${API}/units/${c.units['A-103']}`)
      .set('Authorization', `Bearer ${c.managerToken}`)
      .expect(200);
  });

  it('ending an occupancy removes access on the next request; the record stays', async () => {
    const c = await compound();
    const input = newResident([
      { unitId: c.units['A-101'], occupancyType: 'owner' },
      { unitId: c.units['A-102'], occupancyType: 'tenant' },
    ]);
    const resident = await asManager(c, () => residents.createResident(input));
    const tokens = await loginViaOtp(h, input.email, resident.id);
    await get(tokens, `/units/${c.units['A-102']}`).expect(200);

    const rented = resident.occupancies.find((o) => o.unitCode === 'A-102')!;
    const ended = await asManager(c, () =>
      residents.endOccupancy(rented.id, MOVED_OUT),
    );
    expect(ended).toMatchObject({
      status: 'ended',
      endedAt: expect.any(Date) as Date,
    });

    await get(tokens, `/units/${c.units['A-102']}`).expect(404);
    const units = await get(tokens, '/units').expect(200);
    expect((units.body as { code: string }[]).map((u) => u.code)).toEqual([
      'A-101',
    ]);

    const history = await asManager(c, () => residents.get(resident.id));
    expect(history.occupancies.map((o) => [o.unitCode, o.status])).toEqual([
      ['A-101', 'active'],
      ['A-102', 'ended'],
    ]);
    await expect(
      asManager(c, () => residents.endOccupancy(rented.id, MOVED_OUT)),
    ).rejects.toMatchObject({
      code: 'OCCUPANCY_NOT_FOUND',
    });

    // Moving back in is a new occupancy.
    await asManager(c, () =>
      residents.addOccupancy(resident.id, {
        unitId: c.units['A-102'],
        occupancyType: 'owner',
      }),
    );
    await get(tokens, `/units/${c.units['A-102']}`).expect(200);
  });

  it('a resident with no active unit stays active and sees no units', async () => {
    const c = await compound();
    const input = newResident([
      { unitId: c.units['A-101'], occupancyType: 'owner' },
    ]);
    const resident = await asManager(c, () => residents.createResident(input));
    await asManager(c, () =>
      residents.endOccupancy(resident.occupancies[0].id, MOVED_OUT),
    );
    const tokens = await loginViaOtp(h, input.email, resident.id);
    const units = await get(tokens, '/units').expect(200);
    expect(units.body).toEqual([]);
  });

  it('rejects a second active occupancy of the same unit', async () => {
    const c = await compound();
    const resident = await asManager(c, () =>
      residents.createResident(
        newResident([{ unitId: c.units['A-101'], occupancyType: 'owner' }]),
      ),
    );
    await expect(
      asManager(c, () =>
        residents.addOccupancy(resident.id, {
          unitId: c.units['A-101'],
          occupancyType: 'tenant',
        }),
      ),
    ).rejects.toMatchObject({ code: 'OCCUPANCY_ALREADY_ACTIVE' });
  });

  it('a unit can have several residents', async () => {
    const c = await compound();
    const unitId = c.units['A-101'];
    await asManager(c, () =>
      residents.createResident(
        newResident([{ unitId, occupancyType: 'owner' }]),
      ),
    );
    await asManager(c, () =>
      residents.createResident(
        newResident([{ unitId, occupancyType: 'tenant' }]),
      ),
    );
    const all = await asManager(c, () => residents.list());
    expect(
      all.filter((r) => r.occupancies.some((o) => o.unitId === unitId)),
    ).toHaveLength(2);
  });

  it('validates the input and never reaches units of another compound', async () => {
    const c = await compound();
    const other = await compound(['B-1']);
    await expect(
      asManager(c, () => residents.createResident(newResident([]))),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const dupe = { unitId: c.units['A-101'], occupancyType: 'owner' as const };
    await expect(
      asManager(c, () => residents.createResident(newResident([dupe, dupe]))),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      asManager(c, () =>
        residents.createResident(
          newResident([{ unitId: other.units['B-1'], occupancyType: 'owner' }]),
        ),
      ),
    ).rejects.toMatchObject({ code: 'UNIT_NOT_FOUND' });
    // Nothing was half-created: the failed resident has no account.
    expect(await asManager(c, () => residents.list())).toEqual([]);
  });

  it('records who created the occupancy', async () => {
    const c = await compound();
    const resident = await asManager(c, () =>
      residents.createResident(
        newResident([{ unitId: c.units['A-101'], occupancyType: 'owner' }]),
      ),
    );
    const row = await asManager(c, () =>
      prisma.tenant.unitOccupancy.findUniqueOrThrow({
        where: { id: resident.occupancies[0].id },
      }),
    );
    expect(row.createdById).toBe(c.managerId);
  });

  it('a resident lacks manager permissions', async () => {
    const c = await compound();
    const input = newResident([
      { unitId: c.units['A-101'], occupancyType: 'owner' },
    ]);
    const resident = await asManager(c, () => residents.createResident(input));
    const role = await asManager(c, () =>
      prisma.tenant.role.findUniqueOrThrow({
        where: { tenantId_key: { tenantId: c.tenantId, key: 'resident' } },
      }),
    );
    const granted = await asResident(c, resident.id, async () => {
      cls.set('roleId', role.id);
      cls.set('permissionsVersion', role.permissionsVersion);
      return {
        units: await permissions.has('units.read'),
        residents: await permissions.has('residents.manage'),
        roles: await permissions.has('roles.manage'),
        accounts: await permissions.has('accounts.read'),
      };
    });
    expect(granted).toEqual({
      units: true,
      residents: false,
      roles: false,
      accounts: false,
    });

    const tokens = await loginViaOtp(h, input.email, resident.id);
    await h
      .http()
      .post(`${API}/units`)
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ code: 'NOPE' })
      .expect(403);
    await get(tokens, '/accounts').expect(403);
  });
});
