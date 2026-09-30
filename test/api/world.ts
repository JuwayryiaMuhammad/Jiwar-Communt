import type { AccountType } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { hashPassword } from '../../src/core/platform/password';
import { PlatformSessionService } from '../../src/core/platform/platform-session.service';
import { communityHelpers, type Compound } from '../setup/community';
import { uniqueSuffix } from '../setup/fixtures';
import type { HttpHarness } from '../setup/http-app';

/** The tenant accounts every API suite acts as. */
export type Persona = 'manager' | 'owner' | 'tenant' | 'landlord' | 'family';

const TYPES: Record<Persona, AccountType> = {
  manager: 'manager',
  owner: 'resident',
  tenant: 'resident',
  landlord: 'resident',
  family: 'family',
};

/** One compound as the API suites see it. */
export interface Side extends Compound {
  /** Owned and lived in by `owner`, its primary; `family` is a member. */
  homeUnitId: string;
  /** Owned by `landlord` (not residing), rented and lived in by `tenant`. */
  rentedUnitId: string;
  ids: Record<Persona, string>;
  tokens: Record<Persona, string>;
}

export interface World {
  h: HttpHarness;
  helpers: ReturnType<typeof communityHelpers>;
  /** The compound the requests act in. */
  a: Side;
  /** Another compound: its ids must be "not found" from A. */
  b: Side;
  platform: { adminId: string; token: string; restrictedToken: string };
  /** A fresh token (and session) for any account. */
  tokenFor(
    side: Compound,
    accountId: string,
    type: AccountType,
  ): Promise<string>;
}

async function side(
  h: HttpHarness,
  c: ReturnType<typeof communityHelpers>,
  label: string,
): Promise<Side> {
  const compound = await c.compound(`API ${label}`);
  const home = await c.unit(compound, `${label}-HOME-${uniqueSuffix()}`);
  const rented = await c.unit(compound, `${label}-RENT-${uniqueSuffix()}`);
  const owner = await c.resident(compound, [home.id]);
  const landlord = await c.asManager(compound, () =>
    c.residents.createResident({
      ...c.person('landlord'),
      units: [{ unitId: rented.id, occupancyType: 'owner', resides: false }],
    }),
  );
  const tenant = await c.resident(compound, [rented.id], 'tenant');
  const family = await c.joinFamily(compound, home.id, owner);
  const ids: Record<Persona, string> = {
    manager: compound.managerId,
    owner: owner.id,
    tenant: tenant.id,
    landlord: landlord.id,
    family: family.id,
  };
  const tokens = {} as Record<Persona, string>;
  for (const persona of Object.keys(ids) as Persona[]) {
    tokens[persona] = await h.tokenFor({
      sub: ids[persona],
      tid: compound.tenantId,
      typ: TYPES[persona],
    });
  }
  return {
    ...compound,
    homeUnitId: home.id,
    rentedUnitId: rented.id,
    ids,
    tokens,
  };
}

async function platformAdmins(h: HttpHarness) {
  const globalDb = h.moduleRef.get(GlobalDbService);
  const sessions = h.moduleRef.get(PlatformSessionService);
  const passwordHash = await hashPassword('world-password-123');
  const create = (mustChangePassword: boolean) =>
    globalDb.platformAdmin.create({
      data: {
        id: newId(),
        email: `admin-${uniqueSuffix()}@jiwar.test`,
        passwordHash,
        mustChangePassword,
      },
    });
  const admin = await create(false);
  const pending = await create(true);
  return {
    adminId: admin.id,
    token: (await sessions.start(admin.id)).accessToken,
    restrictedToken: (await sessions.passwordChangeToken(pending.id))
      .accessToken,
  };
}

/** Two compounds with every persona, and platform admins. */
export async function buildWorld(h: HttpHarness): Promise<World> {
  const helpers = communityHelpers(h);
  const a = await side(h, helpers, 'A');
  const b = await side(h, helpers, 'B');
  return {
    h,
    helpers,
    a,
    b,
    platform: await platformAdmins(h),
    tokenFor: (c, sub, typ) => h.tokenFor({ sub, tid: c.tenantId, typ }),
  };
}
