import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { AppException } from '../../src/core/common/errors';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PrismaService } from '../../src/core/database/prisma.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { TenantsService } from '../../src/core/platform/tenants.service';
import { ResidentsService } from '../../src/community/residents/residents.service';
import { nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

const INVALID = '29001010000011'; // governorate 00

/** Every account creator validates the Egyptian national ID (AccountWriter). */
describe('National ID on account creation', () => {
  let h: HttpHarness;
  let tenants: TenantsService;
  let residents: ResidentsService;
  let prisma: PrismaService;
  let cls: ClsService<AppClsStore>;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    tenants = h.moduleRef.get(TenantsService);
    residents = h.moduleRef.get(ResidentsService);
    prisma = h.moduleRef.get(PrismaService);
    cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
  });

  afterAll(() => h.close());

  const invalidNationalId = {
    code: 'VALIDATION_FAILED',
    fields: [{ field: 'nationalId', code: 'INVALID_NATIONAL_ID' }],
  };

  async function compound() {
    const created = await tenants.createTenant({
      name: `National ID Court ${uniqueSuffix()}`,
      manager: {
        fullName: 'Manager',
        nationalId: nationalIdFor(),
        phone: uniquePhone(),
        email: uniqueEmail('mgr'),
      },
    });
    return { tenantId: created.id, managerId: created.managers[0].id };
  }

  function asManager<T>(
    c: { tenantId: string; managerId: string },
    fn: () => Promise<T>,
  ) {
    // Awaited inside: Prisma queries are lazy and run when awaited.
    return cls.run(async () => {
      cls.set('tenantId', c.tenantId);
      cls.set('accountId', c.managerId);
      cls.set('accountType', 'manager');
      return await fn();
    });
  }

  it('the accounts endpoint returns the INVALID_NATIONAL_ID field code', async () => {
    const c = await compound();
    const token = await h.tokenFor({
      sub: c.managerId,
      tid: c.tenantId,
      typ: 'manager',
    });
    const res = await h
      .http()
      .post(`${API}/accounts`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'resident',
        fullName: 'Someone',
        nationalId: INVALID,
        phone: uniquePhone(),
        email: uniqueEmail('bad-id'),
      })
      .expect(400);
    expect(res.body).toMatchObject(invalidNationalId);
  });

  it('the residents service rejects it, and nothing is created', async () => {
    const c = await compound();
    const email = uniqueEmail('bad-resident');
    const unitId = (
      await asManager(c, () =>
        prisma.tenant.unit.create({
          data: { id: newId(), tenantId: c.tenantId, code: 'N-1' },
        }),
      )
    ).id;
    const error = await asManager(c, () =>
      residents.createResident({
        fullName: 'Someone',
        nationalId: INVALID,
        phone: uniquePhone(),
        email,
        units: [{ unitId, occupancyType: 'owner' }],
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getResponse()).toMatchObject(
      invalidNationalId,
    );
    expect(
      await asManager(c, () =>
        prisma.tenant.account.count({ where: { email } }),
      ),
    ).toBe(0);
  });

  it('creating a compound with an invalid manager ID leaves no compound behind', async () => {
    const name = `Rejected Court ${uniqueSuffix()}`;
    const error = await tenants
      .createTenant({
        name,
        manager: {
          fullName: 'Manager',
          nationalId: '29002300100011', // 30 February
          phone: uniquePhone(),
          email: uniqueEmail('mgr'),
        },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getResponse()).toMatchObject(
      invalidNationalId,
    );
    expect(
      await h.moduleRef.get(GlobalDbService).tenant.count({ where: { name } }),
    ).toBe(0);
  });

  it('Arabic-Indic digits are accepted and stored as ASCII', async () => {
    const c = await compound();
    const ascii = nationalIdFor();
    const arabic = ascii.replace(/\d/g, (d) =>
      String.fromCharCode(0x0660 + Number(d)),
    );
    const unitId = (
      await asManager(c, () =>
        prisma.tenant.unit.create({
          data: { id: newId(), tenantId: c.tenantId, code: 'N-2' },
        }),
      )
    ).id;
    const created = await asManager(c, () =>
      residents.createResident({
        fullName: 'Arabic Digits',
        nationalId: arabic,
        phone: uniquePhone(),
        email: uniqueEmail('arabic-digits'),
        units: [{ unitId, occupancyType: 'owner' }],
      }),
    );
    expect(created.nationalId).toBe(ascii);
  });
});
