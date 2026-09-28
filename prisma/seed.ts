import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AccountsService } from '../src/accounts/accounts.service';
import { AppModule } from '../src/app.module';
import type { AppClsStore } from '../src/common/cls/app-cls';
import { GlobalDbService } from '../src/database/global-db.service';
import { UnitsService } from '../src/units/units.service';

/**
 * Local demo data: two compounds, one manager each, a few units, and one
 * person with accounts in both compounds (same phone and email) to try
 * the multi-account login by hand. Idempotent: does nothing if already seeded.
 *
 * Writes go through the real services inside a request-like context, so the
 * seed obeys RLS exactly like the API does.
 */
const TENANTS = [
  {
    id: '01920000-0000-7000-8000-00000000000a',
    name: 'Nile Gardens (demo)',
    manager: {
      email: 'manager.a@jiwar.local',
      phone: '+201000000001',
      fullName: 'Manager A',
    },
    units: ['A-101', 'A-102', 'A-201'],
    shared: 'resident' as const,
  },
  {
    id: '01920000-0000-7000-8000-00000000000b',
    name: 'Desert Rose (demo)',
    manager: {
      email: 'manager.b@jiwar.local',
      phone: '+201000000002',
      fullName: 'Manager B',
    },
    units: ['B-1', 'B-2'],
    shared: 'staff' as const,
  },
];

const SHARED_PERSON = {
  email: 'shared@jiwar.local',
  phone: '+201000000003',
  fullName: 'Shared Person',
};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const globalDb = app.get(GlobalDbService);
    const accounts = app.get(AccountsService);
    const units = app.get(UnitsService);
    const cls = app.get<ClsService<AppClsStore>>(ClsService);

    if (await globalDb.tenant.findUnique({ where: { id: TENANTS[0].id } })) {
      console.log('Already seeded; nothing to do.');
      return;
    }

    let n = 0;
    const nationalId = () => `2900101000000${n++}`.slice(-14);

    for (const t of TENANTS) {
      await globalDb.tenant.create({ data: { id: t.id, name: t.name } });
      await cls.run(async () => {
        cls.set('tenantId', t.id);
        cls.set('accountType', 'manager');
        const manager = await accounts.create({
          type: 'manager',
          nationalId: nationalId(),
          ...t.manager,
        });
        cls.set('accountId', manager.id);
        await accounts.create({
          type: t.shared,
          nationalId: nationalId(),
          ...SHARED_PERSON,
        });
        for (const code of t.units) await units.create({ code });
      });
      console.log(
        `Seeded ${t.name}: manager ${t.manager.email} / ${t.manager.phone}`,
      );
    }
    console.log(
      `Shared person (resident in A, staff in B): ${SHARED_PERSON.email} / ${SHARED_PERSON.phone}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
