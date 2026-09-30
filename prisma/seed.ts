import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AppModule } from '../src/app.module';
import type { AppClsStore } from '../src/core/common/cls/app-cls';
import { GlobalDbService } from '../src/core/database/global-db.service';
import { TenantsService } from '../src/core/platform/tenants.service';
import { ResidentsService } from '../src/community/residents/residents.service';
import { UnitsService } from '../src/community/units/units.service';
import { WorkersService } from '../src/community/workers/workers.service';
import { PrismaService } from '../src/core/database/prisma.service';

/**
 * Local demo data (idempotent). Everything goes through the real services,
 * so the seed obeys RLS, roles and validation exactly like the API:
 *
 * - the platform super admin, created by the startup bootstrap from
 *   SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD (password change forced);
 * - two compounds via TenantsService.createTenant (roles + first manager);
 * - units, and residents with occupancies — one resident owns A-101 and
 *   rents A-102, and one person is a resident in both compounds (same
 *   phone and email) to try the multi-account login by hand;
 * - a foreign resident (UK passport) in A-301, and the domestic worker they
 *   registered (Philippine passport), approved with the manager's
 *   birth-date attestation (ADR 0018).
 *
 * Each part is checked on its own, so later additions also reach an
 * existing dev database.
 */
const COMPOUNDS = [
  {
    name: 'Nile Gardens (demo)',
    manager: {
      fullName: 'Manager A',
      idDocumentType: 'national_id' as const,
      idDocumentNumber: '29001010100001',
      email: 'manager.a@jiwar.local',
      phone: '+201000000001',
    },
    units: ['A-101', 'A-102', 'A-201'],
  },
  {
    name: 'Desert Rose (demo)',
    manager: {
      fullName: 'Manager B',
      idDocumentType: 'national_id' as const,
      idDocumentNumber: '29001010100002',
      email: 'manager.b@jiwar.local',
      phone: '+201000000002',
    },
    units: ['B-1', 'B-2'],
  },
];

const SHARED_PERSON = {
  fullName: 'Shared Person',
  idDocumentType: 'national_id' as const,
  idDocumentNumber: '29001010100003',
  email: 'shared@jiwar.local',
  phone: '+201000000003',
};

const FOREIGN_RESIDENT = {
  fullName: 'Foreign Resident',
  idDocumentType: 'passport' as const,
  idDocumentNumber: '125349876',
  nationality: 'GB',
  birthDate: '1978-04-12',
  email: 'foreign.resident@jiwar.local',
  phone: '+447911123456',
};

const FOREIGN_WORKER = {
  fullName: 'Maria Santos',
  idDocumentType: 'passport' as const,
  idDocumentNumber: 'P4421873A',
  nationality: 'PH',
  birthDate: '1992-11-03',
  phone: '+639171234567',
  capacity: 'hourly' as const,
  schedule: {
    days: [0, 2, 4],
    windows: [{ from: '08:00', to: '16:00' }],
  },
};

const OWNER_AND_RENTER = {
  fullName: 'Owner And Renter',
  idDocumentType: 'national_id' as const,
  idDocumentNumber: '29001010100004',
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

    const workers = app.get(WorkersService);
    const prisma = app.get(PrismaService);

    // Everything the seed writes is audited as `system` (ADR 0014), even
    // where it acts through a manager's or resident's context. Only trusted
    // entry points may set auditActor.
    await cls.run(async () => {
      cls.set('auditActor', { type: 'system', id: null });
      if (
        await globalDb.tenant.findFirst({ where: { name: COMPOUNDS[0].name } })
      ) {
        console.log('Base demo data already there.');
      } else {
        await seed();
      }
      await seedForeigners();
    });

    /** Runs `fn` as an account of the first demo compound. */
    async function asAccount<T>(
      tenantId: string,
      accountId: string,
      accountType: 'manager' | 'resident',
      fn: () => Promise<T>,
    ): Promise<T> {
      return cls.run({ ifNested: 'inherit' }, async () => {
        cls.set('tenantId', tenantId);
        cls.set('accountId', accountId);
        cls.set('accountType', accountType);
        return await fn();
      });
    }

    async function seedForeigners() {
      const tenant = await globalDb.tenant.findFirstOrThrow({
        where: { name: COMPOUNDS[0].name },
      });
      const find = (email: string, type: 'manager' | 'resident') =>
        asAccount(tenant.id, tenant.id, 'manager', () =>
          prisma.tenant.account.findFirst({ where: { email, type } }),
        );
      const manager = await find(COMPOUNDS[0].manager.email, 'manager');
      if (!manager) throw new Error('The demo manager is missing');
      const asManager = <T>(fn: () => Promise<T>) =>
        asAccount(tenant.id, manager.id, 'manager', fn);

      let resident = await find(FOREIGN_RESIDENT.email, 'resident');
      if (!resident) {
        const unit =
          (await asManager(() =>
            prisma.tenant.unit.findFirst({ where: { code: 'A-301' } }),
          )) ?? (await asManager(() => units.create({ code: 'A-301' })));
        await asManager(() =>
          residents.createResident({
            ...FOREIGN_RESIDENT,
            units: [{ unitId: unit.id, occupancyType: 'tenant' }],
          }),
        );
        resident = await find(FOREIGN_RESIDENT.email, 'resident');
        console.log(
          `Foreign resident (UK passport) in A-301: ${FOREIGN_RESIDENT.email} / ${FOREIGN_RESIDENT.phone}`,
        );
      }

      const hasWorker = await asManager(() =>
        prisma.tenant.domesticWorker.findFirst({
          where: { idDocumentNumber: FOREIGN_WORKER.idDocumentNumber },
        }),
      );
      if (!hasWorker) {
        const unit = await asManager(() =>
          prisma.tenant.unit.findFirstOrThrow({ where: { code: 'A-301' } }),
        );
        const registered = await asAccount(
          tenant.id,
          resident!.id,
          'resident',
          () => workers.register(unit.id, FOREIGN_WORKER),
        );
        // The access code is returned once and never printed or stored:
        // reissue it (WorkersService.reissueCode) to get one to try.
        await asManager(() =>
          workers.review(registered.engagementId, 'approve', {
            birthDateConfirmed: true,
          }),
        );
        console.log(
          'Domestic worker (Philippine passport) for A-301, approved with the birth date attested',
        );
      }
    }

    async function seed() {
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
          units: [
            { unitId: created[0].units['A-201'], occupancyType: 'owner' },
          ],
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
    }

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
