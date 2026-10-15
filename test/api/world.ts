import type { AccountType } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { hashPassword } from '../../src/core/platform/password';
import { PlatformSessionService } from '../../src/core/platform/platform-session.service';
import { InvoicesService } from '../../src/finance/invoices/invoices.service';
import { DelegationsService } from '../../src/community/households/delegations.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { RegistrationService } from '../../src/community/residents/registration.service';
import { WorkersService } from '../../src/community/workers/workers.service';
import { RolesService } from '../../src/core/access/roles.service';
import { AccountDeletionService } from '../../src/core/accounts/account-deletion.service';
import { LoginAlerts } from '../../src/core/auth/login-alerts';
import { Notifier } from '../../src/core/notifications/notifier';
import { VisitorPassesService } from '../../src/gate/visitors/visitor-passes.service';
import { ApprovalsService } from '../../src/gate/approvals/approvals.service';
import { AnnouncementsService } from '../../src/engagement/announcements/announcements.service';
import { EventsService } from '../../src/engagement/events/events.service';
import { PollsService } from '../../src/engagement/polls/polls.service';
import { SuggestionsService } from '../../src/engagement/suggestions/suggestions.service';
import { RequestsService } from '../../src/management/requests/requests.service';
import { ClaimsService } from '../../src/neighbours/claims/claims.service';
import { ComplaintStatusService } from '../../src/neighbours/complaints/complaint-status.service';
import { ComplaintsService } from '../../src/neighbours/complaints/complaints.service';
import { NoticesService } from '../../src/neighbours/complaints/notices.service';
import { BlocksService } from '../../src/neighbours/conversations/blocks.service';
import { ConversationsService } from '../../src/neighbours/conversations/conversations.service';
import { ReportsService } from '../../src/neighbours/conversations/reports.service';
import { PostsService } from '../../src/neighbours/posts/posts.service';
import { BookingsService } from '../../src/facilities/bookings/bookings.service';
import { ClosuresService } from '../../src/facilities/closures/closures.service';
import { ClubService } from '../../src/facilities/club/club.service';
import { VehiclesService } from '../../src/gate/vehicles/vehicles.service';
import { StaffParkingService } from '../../src/gate/parking/staff-parking.service';
import { VisitorParkingService } from '../../src/gate/parking/visitor-parking.service';
import { FinesService } from '../../src/gate/fines/fines.service';
import { FinePaymentsService } from '../../src/gate/fines/fine-payments.service';
import { ParkingReportsService } from '../../src/gate/parking-reports/parking-reports.service';
import { FacilitiesService } from '../../src/facilities/setup/facilities.service';
import { ALL_WEEK, at, day } from '../setup/facilities';
import { DispatchService } from '../../src/maintenance/tickets/dispatch.service';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { VisitsService } from '../../src/maintenance/visits/visits.service';
import { communityHelpers, type Compound } from '../setup/community';
import { fileHelpers } from '../setup/files';
import { parcelHelpers } from '../setup/parcels';
import { gateHelpers } from '../setup/gate';
import { nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  API,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';

/** The tenant accounts every API suite acts as. */
export type Persona =
  | 'manager'
  | 'owner'
  | 'tenant'
  | 'landlord'
  | 'family'
  | 'guard'
  | 'technician';

const TYPES: Record<Persona, AccountType> = {
  manager: 'manager',
  owner: 'resident',
  tenant: 'resident',
  landlord: 'resident',
  family: 'family',
  guard: 'staff',
  technician: 'staff',
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
  /** A pending gate request for B's home, from B's guard. */
  bRequestId: string;
  /** A held parcel for B's home, and that unit's code (ADR 0035). */
  bParcelId: string;
  bUnitCode: string;
  /** A finalized worker photo uploaded by B's owner (ADR 0029). */
  bFileId: string;
  /** A phone B's owner registered for the entry QR (ADR 0031). */
  bEntryCredentialId: string;
  /** One of B's ticket categories (seeded, ADR 0032). */
  bCategoryId: string;
  /** One of B's management request topics (seeded, ADR 0039). */
  bManagementTopicId: string;
  /** A request B's owner opened to B's management. */
  bManagementRequestId: string;
  /** B's community life (ADR 0040): a seeded suggestion topic; an
   * announcement that is out; an upcoming event; an open poll and one of
   * its options; a suggestion of B's owner, on B's board. */
  bSuggestionTopicId: string;
  bAnnouncementId: string;
  bEventId: string;
  bPollId: string;
  bPollOptionId: string;
  bSuggestionId: string;
  /** A ticket B's owner opened on B's home, assigned to B's technician. */
  bTicketId: string;
  /** A visit B's technician proposed on that ticket (ADR 0034). */
  bVisitId: string;
  /** B's home, for unit-scoped routes. */
  bUnitId: string;
  /** One of A's categories, for valid ticket bodies. */
  aCategoryId: string;
  /** One of B's preventive services (seeded, ADR 0038). */
  bPreventiveServiceId: string;
  /** One of A's, for valid preventive requests. */
  aPreventiveServiceId: string;
  /** A device B's owner logged in from (ADR 0036). */
  /** B's neighbours data (ADR 0042): a seeded complaint category; a
   * complaint of B's owner against B's rented unit and its notice to B's
   * tenant; a found post of B's owner and B's tenant's claim on it; a
   * conversation of the two on a lending post, reported by the tenant, who
   * also blocked the owner. */
  bComplaintCategoryId: string;
  bComplaintId: string;
  bNoticeId: string;
  bPostId: string;
  bClaimId: string;
  bConversationId: string;
  bBlockId: string;
  bReportId: string;
  /** B's facilities data (ADR 0044): a bookable facility open every day,
   * and its owner's booking of it. */
  bFacilityId: string;
  bBookingId: string;
  /** A closure of B's facility, a month ahead. */
  bClosureId: string;
  /** A suspension of B's home, in force. */
  bSuspensionId: string;
  /** B's club: a plan, a membership of B's home and a payment for it. */
  bClubPlanId: string;
  bMembershipId: string;
  bPaymentId: string;
  /** B's finance (ADR 0046): an issue to B's home, and its invoice. */
  bInvoiceBatchId: string;
  bInvoiceId: string;
  /** One of A's plans, for valid payment bodies. */
  aClubPlanId: string;
  /** One of A's, open every day, roomy, for valid bookings. */
  aFacilityId: string;
  /** B's vehicles and parking (ADR 0045): a pending vehicle of B's home. */
  bVehicleId: string;
  /** B's home's parking slot, a visitor area, and B's owner's booking there. */
  bSlotId: string;
  bAreaId: string;
  bParkingBookingId: string;
  /** One of A's visitor areas, roomy, for valid bookings. */
  aAreaId: string;
  /** A fine to B's home, issued by B's manager, and its payment. */
  bFineId: string;
  bFinePaymentId: string;
  /** A parking report of B's tenant. */
  bParkingReportId: string;
  bDeviceId: string;
  /** A personal-data export B's owner asked for (ADR 0036). */
  bExportId: string;
  /** One of B's specialties (seeded, ADR 0033). */
  bSpecialtyId: string;
  /** One of A's specialties, for valid bodies. */
  aSpecialtyId: string;
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
  // A maintenance technician (ADR 0032): a staff account by roleKey.
  const technician = await gateHelpers(h).guard(compound, 'technician');
  const ids: Record<Persona, string> = {
    manager: compound.managerId,
    owner: owner.id,
    tenant: tenant.id,
    landlord: landlord.id,
    family: family.id,
    guard: duty.guardId,
    technician: technician.id,
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
  const bRequest = await helpers.as(
    b,
    { id: b.ids.guard, type: 'staff' },
    async () =>
      h.moduleRef.get(ApprovalsService).request({
        kind: 'delivery',
        unitCode: (
          await helpers.prisma.tenant.unit.findUniqueOrThrow({
            where: { id: b.homeUnitId },
          })
        ).code,
      }),
  );
  const bUnitCode = (
    await helpers.asManager(b, () =>
      helpers.prisma.tenant.unit.findUniqueOrThrow({
        where: { id: b.homeUnitId },
      }),
    )
  ).code;
  const bParcel = await parcelHelpers(h).receive(b.tokens.guard, bUnitCode);
  if (bParcel.status !== 201)
    throw new Error(
      `B's parcel: ${bParcel.status} ${JSON.stringify(bParcel.body)}`,
    );
  const bFileId = await fileHelpers(h).ready(b.tokens.owner);
  const bEntryCredential = await h
    .http()
    .post(`${API}/me/entry-credentials`)
    .set('Authorization', `Bearer ${b.tokens.owner}`)
    .send({})
    .expect(201);
  const bCategory = await helpers.asManager(b, () =>
    helpers.prisma.tenant.ticketCategory.findFirstOrThrow({
      where: { key: 'plumbing' },
    }),
  );
  const bTicket = await asBOwner(() =>
    h.moduleRef.get(TicketsService).create({
      unitId: b.homeUnitId,
      categoryId: bCategory.id,
      description: 'World',
    }),
  );
  await helpers.asManager(b, () =>
    h.moduleRef.get(DispatchService).assign(bTicket.id, b.ids.technician),
  );
  const bVisit = await helpers.as(
    b,
    { id: b.ids.technician, type: 'staff' },
    () =>
      h.moduleRef.get(VisitsService).propose(
        bTicket.id,
        {
          startsAt: new Date(Date.now() + 86_400_000),
          endsAt: new Date(Date.now() + 86_400_000 + 3_600_000),
        },
        'technician',
      ),
  );
  const bManagementTopic = await helpers.asManager(b, () =>
    helpers.prisma.tenant.managementRequestTopic.findFirstOrThrow({
      where: { key: 'general' },
    }),
  );
  const bManagementRequest = await asBOwner(() =>
    h.moduleRef.get(RequestsService).create({
      type: 'question',
      topicId: bManagementTopic.id,
      body: 'World',
    }),
  );
  const bSuggestionTopic = await helpers.asManager(b, () =>
    helpers.prisma.tenant.suggestionTopic.findFirstOrThrow({
      where: { key: 'general' },
    }),
  );
  const bAnnouncement = await helpers.asManager(b, async () => {
    const announcements = h.moduleRef.get(AnnouncementsService);
    const created = await announcements.create({
      kind: 'general',
      titleEn: 'World',
      bodyEn: 'World',
    });
    await announcements.publish(created.id, undefined);
    return created;
  });
  const bEvent = await helpers.asManager(b, () =>
    h.moduleRef.get(EventsService).create({
      titleEn: 'World',
      descriptionEn: 'World',
      place: 'World',
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000 + 3_600_000),
    }),
  );
  const bPoll = await helpers.asManager(b, () =>
    h.moduleRef.get(PollsService).create({
      questionEn: 'World?',
      options: [{ labelEn: 'Yes' }, { labelEn: 'No' }],
      closesAt: new Date(Date.now() + 7 * 86_400_000),
    }),
  );
  const bPollOption = await helpers.asManager(b, () =>
    helpers.prisma.tenant.pollOption.findFirstOrThrow({
      where: { pollId: bPoll.id },
    }),
  );
  const bSuggestion = await asBOwner(() =>
    h.moduleRef
      .get(SuggestionsService)
      .create({ topicId: bSuggestionTopic.id, body: 'World' }),
  );
  await helpers.asManager(b, () =>
    h.moduleRef
      .get(SuggestionsService)
      .publish(bSuggestion.id, { titleEn: 'World', textEn: 'World' }),
  );
  // Neighbours (ADR 0042).
  const asBTenant = <T>(fn: () => Promise<T>) =>
    helpers.as(b, { id: b.ids.tenant, type: 'resident' }, fn);
  const bComplaintCategory = await helpers.asManager(b, () =>
    helpers.prisma.tenant.neighbourComplaintCategory.findFirstOrThrow({
      where: { key: 'noise' },
    }),
  );
  const bRentedUnit = await helpers.asManager(b, () =>
    helpers.prisma.tenant.unit.findUniqueOrThrow({
      where: { id: b.rentedUnitId },
    }),
  );
  const bComplaint = await asBOwner(() =>
    h.moduleRef.get(ComplaintsService).create({
      categoryId: bComplaintCategory.id,
      targetUnitCode: bRentedUnit.code,
      body: 'World',
    }),
  );
  const bNotice = await helpers.asManager(b, async () => {
    await h.moduleRef.get(ComplaintStatusService).review(bComplaint.id);
    return h.moduleRef.get(NoticesService).send(bComplaint.id, 'World');
  });
  const bPost = await asBOwner(() =>
    h.moduleRef.get(PostsService).create({ kind: 'found', body: 'World' }),
  );
  const bClaim = await asBTenant(() =>
    h.moduleRef.get(ClaimsService).create(bPost.id, {}),
  );
  const bLendPost = await asBOwner(() =>
    h.moduleRef.get(PostsService).create({ kind: 'lend', body: 'World' }),
  );
  const bConversation = await asBTenant(() =>
    h.moduleRef
      .get(ConversationsService)
      .start(bLendPost.id, { body: 'World' }),
  );
  const bReport = await asBTenant(() =>
    h.moduleRef
      .get(ReportsService)
      .report(bConversation.id, { reasonCode: 'spam' }),
  );
  await asBTenant(() => h.moduleRef.get(BlocksService).block(bConversation.id));
  const bBlock = await helpers.asManager(b, () =>
    helpers.prisma.tenant.neighbourBlock.findFirstOrThrow({
      where: { blockerId: b.ids.tenant },
    }),
  );
  const aCategory = await helpers.asManager(a, () =>
    helpers.prisma.tenant.ticketCategory.findFirstOrThrow({
      where: { key: 'plumbing' },
    }),
  );
  const bSpecialty = await helpers.asManager(b, () =>
    helpers.prisma.tenant.specialty.findFirstOrThrow({
      where: { key: 'plumbing' },
    }),
  );
  await h.moduleRef
    .get(LoginAlerts)
    .recordLogin(
      { accountId: b.ids.owner, tenantId: b.tenantId },
      { userAgent: 'World/1.0 (Linux)' },
    );
  const bDevice = await helpers.asManager(b, () =>
    helpers.prisma.tenant.knownDevice.findFirstOrThrow({
      where: { accountId: b.ids.owner },
    }),
  );
  const bExportId = newId();
  await helpers.asManager(b, () =>
    helpers.prisma.tenant.dataExport.create({
      data: {
        id: bExportId,
        tenantId: b.tenantId,
        accountId: b.ids.owner,
        requestedByAccountId: b.ids.owner,
        delivery: 'in_app',
      },
    }),
  );
  const aSpecialty = await helpers.asManager(a, () =>
    helpers.prisma.tenant.specialty.findFirstOrThrow({
      where: { key: 'plumbing' },
    }),
  );
  const service = (c: typeof a) =>
    helpers.asManager(c, () =>
      helpers.prisma.tenant.preventiveService.findFirstOrThrow({
        where: { key: 'plumbing_check' },
      }),
    );
  const bPreventiveService = await service(b);
  const aPreventiveService = await service(a);
  // Facilities (ADR 0044).
  const facilityOf = (c: typeof a, roomy: boolean) =>
    helpers.asManager(c, async () => {
      const facilities = h.moduleRef.get(FacilitiesService);
      const created = await facilities.create({
        mode: 'bookable',
        nameEn: 'World court',
        nameAr: 'ملعب',
        slotMinutes: 60,
        capacity: roomy ? 500 : 1,
        ...(roomy ? { weeklyQuota: 20 } : {}),
      });
      await facilities.replaceHours(created.id, ALL_WEEK);
      return created;
    });
  const bFacility = await facilityOf(b, false);
  const aFacility = await facilityOf(a, true);
  const bBooking = await asBOwner(() =>
    h.moduleRef.get(BookingsService).book(b.homeUnitId, {
      facilityId: bFacility.id,
      startsAt: at(day(2), 10),
    }),
  );
  const bClosure = await helpers.asManager(b, () =>
    h.moduleRef.get(ClosuresService).create(bFacility.id, {
      startsAt: at(day(30), 10),
      endsAt: at(day(30), 12),
      reasonCode: 'maintenance',
    }),
  );
  const bSuspensionId = newId();
  await helpers.asManager(b, async () => {
    const ended = newId();
    await helpers.prisma.tenant.booking.create({
      data: {
        id: ended,
        tenantId: b.tenantId,
        facilityId: bFacility.id,
        unitId: b.homeUnitId,
        bookedById: b.ids.owner,
        startsAt: new Date(Date.now() - 2 * 3_600_000),
        endsAt: new Date(Date.now() - 3_600_000),
        guests: 0,
        partySize: 1,
        peak: false,
        status: 'no_show',
        noShowMarkedAt: new Date(),
        noShowMarkedById: b.ids.manager,
      },
    });
    await helpers.prisma.tenant.bookingSuspension.create({
      data: {
        id: bSuspensionId,
        tenantId: b.tenantId,
        unitId: b.homeUnitId,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 86_400_000),
        triggerBookingId: ended,
        noShowCount: 3,
      },
    });
  });
  const clubOf = (c: typeof a) =>
    helpers.asManager(c, () =>
      h.moduleRef.get(ClubService).createPlan({
        nameEn: 'Monthly',
        nameAr: 'شهري',
        durationKind: 'monthly',
        price: '500',
      }),
    );
  const bClubPlan = await clubOf(b);
  const aClubPlan = await clubOf(a);
  const bClub = await helpers.asManager(b, async () => {
    const club = h.moduleRef.get(ClubService);
    const membership = await club.create(b.homeUnitId, []);
    const payment = await club.record(membership.membership.id, {
      planId: bClubPlan.id,
      amount: '500',
      receiptNumber: `R-WORLD-${b.tenantId.slice(0, 8)}`,
      paidOn: day(0),
    });
    return { membershipId: membership.membership.id, paymentId: payment.id };
  });
  // Vehicles and parking (ADR 0045).
  const bVehicle = await asBOwner(() =>
    h.moduleRef.get(VehiclesService).create(b.homeUnitId, {
      plate: 'ب و 1234',
      makeAndModel: 'World car',
      color: 'Grey',
      type: 'car',
    }),
  );
  const areaOf = (c: typeof a) =>
    helpers.asManager(c, () =>
      h.moduleRef
        .get(StaffParkingService)
        .createArea({ name: `World area ${uniqueSuffix()}`, capacity: 500 }),
    );
  const bArea = await areaOf(b);
  const aArea = await areaOf(a);
  const bSlot = await helpers.asManager(b, async () =>
    h.moduleRef.get(StaffParkingService).createSlot({
      unitCode: (
        await helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: b.homeUnitId },
        })
      ).code,
      code: `W-${uniqueSuffix()}`.slice(0, 20),
      place: 'World basement',
    }),
  );
  const soon = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 3_600_000);
  const bParking = await asBOwner(() =>
    h.moduleRef.get(VisitorParkingService).book(b.homeUnitId, {
      areaId: bArea.id,
      visitorName: 'World visitor',
      startsAt: soon.toISOString(),
      endsAt: new Date(soon.getTime() + 3_600_000).toISOString(),
    }),
  );
  const bFine = await helpers.asManager(b, async () =>
    h.moduleRef.get(FinesService).issue({
      unitCode: (
        await helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: b.homeUnitId },
        })
      ).code,
      plate: 'ب و 1234',
      reason: 'blocking',
      amount: '300',
      occurredOn: day(0),
    }),
  );
  const bFinePayment = await helpers.asManager(b, () =>
    h.moduleRef.get(FinePaymentsService).record(bFine.fine.id, {
      amount: '300',
      receiptNumber: `F-WORLD-${b.tenantId.slice(0, 8)}`,
      paidOn: day(0),
    }),
  );
  const bParkingReport = await helpers.as(
    b,
    { id: b.ids.tenant, type: 'resident' },
    () =>
      h.moduleRef
        .get(ParkingReportsService)
        .create({ plate: 'ب و 1234', location: 'World ramp' }),
  );
  const bFinance = await helpers.asManager(b, async () => {
    const batch = await h.moduleRef.get(InvoicesService).issue({
      target: 'unit',
      unitId: b.homeUnitId,
      kind: 'service_charge',
      dueOn: day(10),
      lines: [
        {
          descriptionEn: 'Service charge',
          descriptionAr: 'رسوم الخدمات',
          amount: '1200',
        },
      ],
    });
    const invoice = await helpers.prisma.tenant.invoice.findFirstOrThrow({
      where: { batchId: batch.id },
    });
    return { batchId: batch.id, invoiceId: invoice.id };
  });
  return {
    bInvoiceBatchId: bFinance.batchId,
    bInvoiceId: bFinance.invoiceId,
    bParkingReportId: bParkingReport.id,
    bFineId: bFine.fine.id,
    bFinePaymentId: bFinePayment.id,
    bVehicleId: bVehicle.vehicle.id,
    bSlotId: bSlot.slot.id,
    bAreaId: bArea.id,
    bParkingBookingId: bParking.booking.id,
    aAreaId: aArea.id,
    bClubPlanId: bClubPlan.id,
    aClubPlanId: aClubPlan.id,
    bMembershipId: bClub.membershipId,
    bPaymentId: bClub.paymentId,
    bSuspensionId,
    bClosureId: bClosure.closure.id,
    bFacilityId: bFacility.id,
    bBookingId: bBooking.id,
    aFacilityId: aFacility.id,
    bPreventiveServiceId: bPreventiveService.id,
    aPreventiveServiceId: aPreventiveService.id,
    bSpecialtyId: bSpecialty.id,
    bDeviceId: bDevice.id,
    bExportId,
    aSpecialtyId: aSpecialty.id,
    bCategoryId: bCategory.id,
    bManagementTopicId: bManagementTopic.id,
    bManagementRequestId: bManagementRequest.id,
    bSuggestionTopicId: bSuggestionTopic.id,
    bAnnouncementId: bAnnouncement.id,
    bEventId: bEvent.id,
    bPollId: bPoll.id,
    bPollOptionId: bPollOption.id,
    bSuggestionId: bSuggestion.id,
    bComplaintCategoryId: bComplaintCategory.id,
    bComplaintId: bComplaint.id,
    bNoticeId: bNotice.id,
    bPostId: bPost.id,
    bClaimId: bClaim.id,
    bConversationId: bConversation.id,
    bBlockId: bBlock.id,
    bReportId: bReport.id,
    bTicketId: bTicket.id,
    bVisitId: bVisit.id,
    bUnitId: b.homeUnitId,
    aCategoryId: aCategory.id,
    bParcelId: (bParcel.body as { id: string }).id,
    bUnitCode,
    bFileId,
    bEntryCredentialId: (bEntryCredential.body as { id: string }).id,
    bRequestId: bRequest.id,
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
