import type { AccountType, OccupancyType } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { newId } from '../../src/core/common/uuid';
import { PrismaService } from '../../src/core/database/prisma.service';
import { TenantsService } from '../../src/core/platform/tenants.service';
import { ResidentsService } from '../../src/community/residents/residents.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import type { NewInvite } from '../../src/community/households/households.types';
import { InviteAcceptanceService } from '../../src/community/households/invite-acceptance.service';
import { bornYearsAgo, nationalIdFor, uniqueSuffix } from './fixtures';
import { waitForOtp } from './mailpit';
import { uniqueEmail, uniquePhone, type HttpHarness } from './http-app';

export interface Compound {
  tenantId: string;
  managerId: string;
}

export interface Person {
  id: string;
  email: string;
  phone: string;
  fullName: string;
  nationalId: string;
}

/**
 * Service-level helpers for community suites: compounds created through the
 * platform service, and calls made as a given account exactly as
 * JwtAuthGuard would set the request context. Needs a harness built with
 * PlatformModule.
 */
export function communityHelpers(h: HttpHarness) {
  const cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
  const tenants = h.moduleRef.get(TenantsService);
  const residents = h.moduleRef.get(ResidentsService);
  const prisma = h.moduleRef.get(PrismaService);

  /** Runs `fn` as the account (awaited inside: Prisma queries are lazy). */
  function as<T>(
    c: { tenantId: string },
    account: { id: string; type: AccountType; sessionId?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    return cls.run(async () => {
      cls.set('tenantId', c.tenantId);
      cls.set('accountId', account.id);
      cls.set('accountType', account.type);
      if (account.sessionId) cls.set('sessionId', account.sessionId);
      return await fn();
    });
  }

  const asManager = <T>(c: Compound, fn: () => Promise<T>) =>
    as(c, { id: c.managerId, type: 'manager' }, fn);

  function person(label = 'person'): Omit<Person, 'id'> {
    return {
      fullName: `Person ${uniqueSuffix()}`,
      nationalId: nationalIdFor(),
      phone: uniquePhone(),
      email: uniqueEmail(label),
    };
  }

  async function compound(name = 'Community Court'): Promise<Compound> {
    const created = await tenants.createTenant({
      name: `${name} ${uniqueSuffix()}`,
      manager: person('mgr'),
    });
    return { tenantId: created.id, managerId: created.managers[0].id };
  }

  async function unit(c: Compound, code = `U-${uniqueSuffix()}`) {
    return asManager(c, () =>
      prisma.tenant.unit.create({
        data: { id: newId(), tenantId: c.tenantId, code },
      }),
    );
  }

  /** A resident occupying `unitIds` (owner by default), through the service. */
  async function resident(
    c: Compound,
    unitIds: string[],
    occupancyType: OccupancyType = 'owner',
  ): Promise<Person> {
    const p = person('res');
    const created = await asManager(c, () =>
      residents.createResident({
        ...p,
        units: unitIds.map((unitId) => ({ unitId, occupancyType })),
      }),
    );
    return { ...p, id: created.id };
  }

  /** The unit's occupancies as the manager sees them. */
  function occupancies(c: Compound, unitId: string) {
    return asManager(c, () =>
      prisma.tenant.unitOccupancy.findMany({
        where: { unitId },
        orderBy: { startedAt: 'asc' },
      }),
    );
  }

  /**
   * An adult joins the unit's household through the real invite flow: the
   * primary invites, the code goes to the invited email, the invitee accepts.
   */
  async function joinFamily(
    c: Compound,
    unitId: string,
    primary: { id: string },
    input: Partial<NewInvite> = {},
  ) {
    const invite: NewInvite = {
      fullName: `Family ${uniqueSuffix()}`,
      phone: uniquePhone(),
      email: uniqueEmail('family'),
      nationalId: nationalIdFor(bornYearsAgo(30)),
      relation: 'spouse',
      ...input,
    };
    const created = await as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(HouseholdsService).createInvite(unitId, invite),
    );
    const since = new Date();
    const acceptance = h.moduleRef.get(InviteAcceptanceService);
    await acceptance.startAcceptance(created.token, '10.9.9.9', 'en');
    const accepted = await acceptance.completeAcceptance(
      created.token,
      await waitForOtp(invite.email, since),
    );
    return { ...accepted, ...invite, id: accepted.accountId };
  }

  function unitRow(c: Compound, unitId: string) {
    return asManager(c, () =>
      prisma.tenant.unit.findUniqueOrThrow({ where: { id: unitId } }),
    );
  }

  return {
    cls,
    prisma,
    residents,
    tenants,
    as,
    asManager,
    person,
    compound,
    unit,
    resident,
    occupancies,
    unitRow,
    joinFamily,
  };
}
