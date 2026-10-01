import type { AccountType } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { hashPassword } from '../../src/core/platform/password';
import { PlatformSessionService } from '../../src/core/platform/platform-session.service';
import { DelegationsService } from '../../src/community/households/delegations.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { RegistrationService } from '../../src/community/residents/registration.service';
import { WorkersService } from '../../src/community/workers/workers.service';
import { RolesService } from '../../src/core/access/roles.service';
import { AccountDeletionService } from '../../src/core/accounts/account-deletion.service';
import { Notifier } from '../../src/core/notifications/notifier';
import { VisitorPassesService } from '../../src/gate/visitors/visitor-passes.service';
import { communityHelpers, type Compound } from '../setup/community';
import { gateHelpers } from '../setup/gate';
import { nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import { uniqueEmail, uniquePhone, type HttpHarness } from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';

/** The tenant accounts every API suite acts as. */
export type Persona =
  'manager' | 'owner' | 'tenant' | 'landlord' | 'family' | 'guard';

const TYPES: Record<Persona, AccountType> = {
  manager: 'manager',
  owner: 'resident',
  tenant: 'resident',
  landlord: 'resident',
  family: 'family',
  guard: 'staff',
};

/** One compound as the API suites see it. */
export interface Side extends Compound {
  /** Owned and lived in by `owner`, its primary; `family` is a member. */
  homeUnitId: string;
  /** Owned by `landlord` (not residing), rented and lived in by `tenant`. */
  rentedUnitId: string;
  ids: Record<Persona, string>;
  tokens: Record<Persona, string>;
  /** The session behind each token. */
  sessions: Record<Persona, string>;
  /** The family account's membership of home. */
  familyMemberId: string;
  /** Active occupancies: the owner's of home, the landlord's and tenant's of rented. */
  occupancies: Record<'owner' | 'landlord' | 'tenant', string>;
  /** `guard` is on duty at this gate (ADR 0028). */
  gateId: string;
  gateName: string;
  shiftId: string;
}

export interface World {
  h: HttpHarness;
  helpers: ReturnType<typeof communityHelpers>;
  /** The compound the requests act in. */
  a: Side;
  /** Another compound: its ids must be "not found" from A. */
  b: Side;
  platform: { adminId: string; token: string; restrictedToken: string };
  /** An open separation flag on B's rented unit (a foreign flag id). */
  bFlagId: string;
  /** B's registration link and a pending registration request. */
  bLinkId: string;
  bRegistrationId: string;
  /** A pending deletion request in B, and a legal hold on its account. */
  bDeletionRequestId: string;
  bLegalHoldId: string;
  /** B's resident role. */
  bRoleId: string;
  /** A pending household invite in B. */
  bInviteId: string;
  /** A deferred action by B's family member, waiting for B's primary. */
  bDeferredActionId: string;
  /** B's owner delegates the workers to B's family member. */
  bDelegationId: string;
  /** An active engagement in B (its worker), a compliance case on another
   * worker, and a card incident on the engagement. */
  bEngagementId: string;
  bWorkerId: string;
  bCaseId: string;
  bIncidentId: string;
  /** A notification for B's owner. */
  bNotificationId: string;
  /** An active visitor pass of B's owner. */
  bPassId: string;
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
  const duty = await gateHelpers(h).onDuty(compound);
  const ids: Record<Persona, string> = {
    manager: compound.managerId,
    owner: owner.id,
    tenant: tenant.id,
    landlord: landlord.id,
    family: family.id,
    guard: duty.guardId,
  };
  const tokens = {} as Record<Persona, string>;
  for (const persona of Object.keys(ids) as Persona[]) {
    tokens[persona] = await h.tokenFor({
      sub: ids[persona],
      tid: compound.tenantId,
      typ: TYPES[persona],
    });
  }
  const occupancyOf = async (unitId: string, accountId: string) =>
    (await c.occupancies(compound, unitId)).find(
      (o) => o.accountId === accountId && o.status === 'active',
    )!.id;
  const occupancies = {
    owner: await occupancyOf(home.id, owner.id),
    landlord: await occupancyOf(rented.id, landlord.id),
    tenant: await occupancyOf(rented.id, tenant.id),
  };
  const sessions = {} as Record<Persona, string>;
  for (const persona of Object.keys(tokens) as Persona[]) {
    sessions[persona] = sessionOf(tokens[persona]);
  }
  return {
    ...compound,
    homeUnitId: home.id,
    rentedUnitId: rented.id,
    ids,
    tokens,
    sessions,
    occupancies,
    familyMemberId: family.memberId,
    gateId: duty.gateId,
    gateName: duty.gateName,
    shiftId: duty.shiftId,
  };
}

/** The `sid` claim of an access token (not verified: our own token). */
export function sessionOf(token: string): string {
  const payload = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as { sid: string };
  return payload.sid;
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
  const { flagId: bFlagId } = await helpers.asManager(b, () =>
    helpers.residents.tagSeparation(b.rentedUnitId, {
      code: 'separation',
      text: 'World fixture',
    }),
  );
  const registrations = h.moduleRef.get(RegistrationService);
  const link = await helpers.asManager(b, () => registrations.createLink());
  const registrant = {
    linkToken: link.token,
    fullName: 'World Registrant',
    unitCode: 'NO-SUCH',
    phone: uniquePhone(),
    email: uniqueEmail('world-reg'),
    idDocumentType: 'national_id' as const,
    idDocumentNumber: nationalIdFor(),
    occupancyType: 'owner' as const,
  };
  const since = new Date();
  await registrations.start(registrant, '10.99.0.1', 'en');
  await registrations.complete(
    registrant,
    await waitForOtp(registrant.email, since),
    '10.99.0.1',
  );
  const [pending] = (await helpers.asManager(b, () => registrations.pending()))
    .items;
  const deletion = h.moduleRef.get(AccountDeletionService);
  const leaving = await helpers.resident(b, [b.homeUnitId], 'tenant');
  const request = await helpers.as(
    b,
    { id: leaving.id, type: 'resident' },
    () => deletion.requestDeletion('DELETE'),
  );
  const holdId = await helpers.asManager(b, () =>
    deletion.placeLegalHold(leaving.id, { code: 'litigation', text: 'World' }),
  );
  const bRoles = await helpers.asManager(b, () =>
    h.moduleRef.get(RolesService).list(),
  );
  const bInvite = await helpers.as(
    b,
    { id: b.ids.owner, type: 'resident' },
    () =>
      h.moduleRef.get(HouseholdsService).createInvite(b.homeUnitId, {
        fullName: 'World Invitee',
        phone: uniquePhone(),
        email: uniqueEmail('world-invite'),
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(),
        relation: 'sibling',
      }),
  );
  const bDeferredActionId = await helpers.as(
    b,
    { id: b.ids.family, type: 'family' },
    () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        h.moduleRef.get(MemberPermissionsService).submitDeferredAction(tx, {
          accountId: b.ids.family,
          unitId: b.homeUnitId,
          permission: 'bookings',
          payload: { what: 'world' },
        }),
      ),
  );
  const bDelegation = await helpers.as(
    b,
    { id: b.ids.owner, type: 'resident' },
    () =>
      h.moduleRef
        .get(DelegationsService)
        .create(
          b.homeUnitId,
          b.ids.family,
          ['workers'],
          new Date(Date.now() + 30 * 86_400_000),
        ),
  );
  const workers = h.moduleRef.get(WorkersService);
  const asBOwner = <T>(fn: () => Promise<T>) =>
    helpers.as(b, { id: b.ids.owner, type: 'resident' }, fn);
  const worker = () => ({
    fullName: 'World Worker',
    idDocumentType: 'national_id' as const,
    idDocumentNumber: nationalIdFor(),
    phone: uniquePhone(),
    capacity: 'live_in' as const,
  });
  const bEngagement = await asBOwner(() =>
    workers.register(b.homeUnitId, worker()),
  );
  await helpers.asManager(b, () =>
    workers.review(bEngagement.engagementId, 'approve'),
  );
  const bIncident = await helpers.asManager(b, () =>
    workers.reportCardIncident(bEngagement.engagementId, 'lost'),
  );
  const other = await asBOwner(() => workers.register(b.homeUnitId, worker()));
  const otherRow = await helpers.asManager(b, () =>
    helpers.prisma.tenant.workerEngagement.findUniqueOrThrow({
      where: { id: other.engagementId },
    }),
  );
  const bCaseId = await helpers.asManager(b, () =>
    workers.reportUnderage(otherRow.workerId, {
      code: 'report_received',
      text: 'World',
    }),
  );
  const bRow = await helpers.asManager(b, () =>
    helpers.prisma.tenant.workerEngagement.findUniqueOrThrow({
      where: { id: bEngagement.engagementId },
    }),
  );
  await asBOwner(() =>
    h.moduleRef.get(TenantTx).withTenantTx((tx) =>
      h.moduleRef.get(Notifier).notify(tx, [b.ids.owner], {
        kind: 'worker.entered',
        params: { unitCode: 'B-HOME', gateName: 'Main', workerName: 'World' },
        targetId: bEngagement.engagementId,
      }),
    ),
  );
  const bNotification = await asBOwner(() =>
    helpers.prisma.tenant.notification.findFirstOrThrow({
      where: { accountId: b.ids.owner },
    }),
  );
  const bPass = await asBOwner(() =>
    h.moduleRef.get(VisitorPassesService).create(b.homeUnitId, {
      kind: 'one_time',
      partySize: 1,
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 86_400_000),
    }),
  );
  return {
    bPassId: bPass.id,
    bNotificationId: bNotification.id,
    bEngagementId: bEngagement.engagementId,
    bWorkerId: bRow.workerId,
    bCaseId,
    bIncidentId: bIncident.incidentId,
    bDelegationId: bDelegation.id,
    bDeferredActionId,
    bInviteId: bInvite.inviteId,
    bRoleId: bRoles.find((r) => r.key === 'resident')!.id,
    bFlagId,
    bDeletionRequestId: request.id,
    bLegalHoldId: holdId,
    bLinkId: link.id,
    bRegistrationId: pending.id,
    h,
    helpers,
    a,
    b,
    platform: await platformAdmins(h),
    tokenFor: (c, sub, typ) => h.tokenFor({ sub, tid: c.tenantId, typ }),
  };
}
