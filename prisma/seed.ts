import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AppModule } from '../src/app.module';
import type { AppClsStore } from '../src/common/cls/app-cls';
import { GlobalDbService } from '../src/database/global-db.service';
import { TenantsService } from '../src/platform/tenants.service';
import { ResidentsService } from '../src/residents/residents.service';
import { UnitsService } from '../src/units/units.service';

/**
 * Local demo data (idempotent). Everything goes through the real services,
 * so the seed obeys RLS, roles and validation exactly like the API:
 *
 * - the platform super admin, created by the startup bootstrap from
 *   SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD (password change forced);
 * - two compounds via TenantsService.createTenant (roles + first manager);
 * - units, and residents with occupancies — one resident owns A-101 and
 *   rents A-102, and one person is a resident in both compounds (same
 *   phone and email) to try the multi-account login by hand.
 */
const COMPOUNDS = [
  {
    name: 'Nile Gardens (demo)',
    manager: {
      fullName: 'Manager A',
      nationalId: '29001010000001',
      email: 'manager.a@jiwar.local',
      phone: '+201000000001',
    },
    units: ['A-101', 'A-102', 'A-201'],
  },
  {
    name: 'Desert Rose (demo)',
    manager: {
      fullName: 'Manager B',
      nationalId: '29001010000002',
      email: 'manager.b@jiwar.local',
      phone: '+201000000002',
    },
    units: ['B-1', 'B-2'],
  },
];

const SHARED_PERSON = {
  fullName: 'Shared Person',
  nationalId: '29001010000003',
  email: 'shared@jiwar.local',
  phone: '+201000000003',
};

const OWNER_AND_RENTER = {
  fullName: 'Owner And Renter',
  nationalId: '29001010000004',
  email: 'resident.a@jiwar.local',
  phone: '+201000000004',
};

async function main() {
  // Bootstrap (the platform admin) runs as the context starts.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const globalDb = app.get(GlobalDbService);
    const tenants = app.get(TenantsService);
    const units = app.get(UnitsService);
    const residents = app.get(ResidentsService);
    const cls = app.get<ClsService<AppClsStore>>(ClsService);

    if (
      await globalDb.tenant.findFirst({ where: { name: COMPOUNDS[0].name } })
    ) {
      console.log('Already seeded; nothing to do.');
      return;
    }

    const created: {
      tenantId: string;
      managerId: string;
      units: Record<string, string>;
    }[] = [];
    for (const def of COMPOUNDS) {
      const compound = await tenants.createTenant({
        name: def.name,
        manager: def.manager,
      });
      const managerId = compound.managers[0].id;
      const unitIds: Record<string, string> = {};
      await cls.run(async () => {
        cls.set('tenantId', compound.id);
        cls.set('accountId', managerId);
        cls.set('accountType', 'manager');
        for (const code of def.units)
          unitIds[code] = (await units.create({ code })).id;
      });
      created.push({ tenantId: compound.id, managerId, units: unitIds });
      console.log(
        `Compound ${def.name}: manager ${def.manager.email} / ${def.manager.phone}`,
      );
    }

    const asManager = (i: number, fn: () => Promise<unknown>) =>
      cls.run(async () => {
        cls.set('tenantId', created[i].tenantId);
        cls.set('accountId', created[i].managerId);
        cls.set('accountType', 'manager');
        await fn();
      });

    await asManager(0, () =>
      residents.createResident({
        ...OWNER_AND_RENTER,
        units: [
          { unitId: created[0].units['A-101'], occupancyType: 'owner' },
          { unitId: created[0].units['A-102'], occupancyType: 'tenant' },
        ],
      }),
    );
    await asManager(0, () =>
      residents.createResident({
        ...SHARED_PERSON,
        units: [{ unitId: created[0].units['A-201'], occupancyType: 'owner' }],
      }),
    );
    await asManager(1, () =>
      residents.createResident({
        ...SHARED_PERSON,
        units: [{ unitId: created[1].units['B-1'], occupancyType: 'tenant' }],
      }),
    );

    console.log(
      `Resident owning A-101 and renting A-102: ${OWNER_AND_RENTER.email} / ${OWNER_AND_RENTER.phone}`,
    );
    console.log(
      `Resident in both compounds: ${SHARED_PERSON.email} / ${SHARED_PERSON.phone}`,
    );
    const admins = await globalDb.platformAdmin.count();
    console.log(
      admins
        ? 'Platform admin: see SUPERADMIN_EMAIL in .env (password change required on first login).'
        : 'No platform admin: set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD to create one.',
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
