import type { Response } from 'supertest';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { ParcelTokens } from '../../src/gate/parcels/parcel-tokens';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { GatewayService } from '../../src/finance/gateway/gateway.service';
import { gatewayBody } from '../setup/finance';
import { hashPassword } from '../../src/core/platform/password';
import { fileHelpers } from '../setup/files';
import { parcelHelpers } from '../setup/parcels';
import { bornYearsAgo, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { buildExports } from '../setup/exports';
import { waitForMessage, waitForOtp } from '../setup/mailpit';
import { drainOutbox } from '../setup/outbox';
import { lapse, shiftElection } from '../setup/governance';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import {
  CONTEST_CLOSE_SWEEP,
  CONTEST_OPEN_SWEEP,
} from '../../src/governance/contests/contest-sweeps';
import {
  appealCalls,
  boardMatterCalls,
  budgetCalls,
} from './no-store-board-matters';
import { call } from './request';
import { ROUTES } from './routes';
import { inviteBody, minorBody } from './routes/household';
import { ticketBody } from './routes/maintenance';
import { passBody } from './routes/visitors';
import { workerBody } from './routes/workers';
import { guardDutyCalls } from './no-store-guard-duty';
import { patrolCalls } from './no-store-patrols';
import { securityOpsCalls } from './no-store-security-ops';
import { childrenCalls } from './no-store-children';
import { gateCompletionCalls } from './no-store-gate-completion';
import { offlineCalls } from './no-store-offline';
import { residentItemCalls } from './no-store-resident-items';
import { partnerCalls } from './no-store-partners';
import { registrationCalls } from './no-store-registration';
import { kinshipCalls } from './no-store-kinship';
import { unitDocumentCalls } from './no-store-unit-documents';
import { decisionAppealCalls } from './no-store-decision-appeals';
import { representativeCalls } from './no-store-representatives';
import { governanceVoiceCalls } from './no-store-governance-voice';
import { buildWorld, type World } from './world';

import { ALL_WEEK, at, day as localDay } from '../setup/facilities';
import { today } from '../setup/compound-clock';
import { workDaysOf, type PermitRulesBody } from '../setup/permits';
/**
 * Every response that carries a secret shown once (ADR 0025) is
 * `Cache-Control: no-store`: each registry row marked `noStore` is called
 * for real, successfully, here.
 */
describe('API v0 — no-store', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const body = <T>(res: Response) => res.body as T;

  /**
   * An assisted export of A's tenant (ADR 0036), built, and the link its
   * email carries (once per suite).
   */
  let assisted: Promise<{ token: string; email: string }> | null = null;
  const assistedLink = () =>
    (assisted ??= (async () => {
      const email = (
        await w.helpers.asManager(w.a, () =>
          w.helpers.prisma.tenant.account.findUniqueOrThrow({
            where: { id: w.a.ids.tenant },
          }),
        )
      ).email!;
      const since = new Date();
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.dataExport.create({
          data: {
            id: newId(),
            tenantId: w.a.tenantId,
            accountId: w.a.ids.tenant,
            requestedByAccountId: w.a.ids.manager,
            assisted: true,
            assistReasonCode: 'in_person',
            delivery: 'email',
          },
        }),
      );
      await buildExports(h);
      await drainOutbox(h);
      const message = await waitForMessage(email, since);
      const token = /\/a\/export#([0-9a-f-]{36}\.[0-9a-f]{64})/.exec(
        message.Text,
      )![1];
      return { token, email };
    })());

  /** A ticket the owner opened on their home. */
  async function aTicket(): Promise<string> {
    const res = await call(w, 'POST', '/tickets', {
      token: w.a.tokens.owner,
      body: ticketBody(w.a.homeUnitId, w.aCategoryId),
    }).expect(201);
    return body<{ id: string }>(res).id;
  }

  // Requests to the management (ADR 0039).
  const topic = async (key = 'general') =>
    (
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.managementRequestTopic.findFirstOrThrow({
          where: { key },
        }),
      )
    ).id;
  /** A request A's owner opened; its id. */
  async function aRequest(): Promise<string> {
    const res = await call(w, 'POST', '/management-requests', {
      token: w.a.tokens.owner,
      body: { type: 'question', topicId: await topic(), body: 'No-store' },
    }).expect(201);
    return body<{ id: string }>(res).id;
  }
  /** A request staff closed. */
  async function aClosedRequest(): Promise<string> {
    const id = await aRequest();
    await call(w, 'POST', `/management/requests/${id}/close`, {
      token: w.a.tokens.manager,
      body: { reasonCode: 'resolved' },
    }).expect(204);
    return id;
  }
  /** Free slots, far enough ahead to still be bookable a moment later. */
  let slotsTaken = 0;
  async function aSlot(): Promise<string> {
    const res = await call(w, 'GET', '/management-appointment-slots', {
      token: w.a.tokens.owner,
      query: { days: '31' },
    }).expect(200);
    const soon = Date.now() + 2 * 3_600_000;
    const free = body<{ data: { startsAt: string }[] }>(res).data.filter(
      (slot) => new Date(slot.startsAt).getTime() > soon,
    );
    return free[slotsTaken++].startsAt;
  }
  /** An appointment request of A's owner, waiting for the management. */
  async function anAppointment(): Promise<string> {
    const res = await call(w, 'POST', '/management-requests', {
      token: w.a.tokens.owner,
      body: {
        type: 'appointment',
        topicId: await topic(),
        body: 'No-store',
        appointment: { startsAt: await aSlot(), mode: 'in_person' },
      },
    }).expect(201);
    return body<{ id: string }>(res).id;
  }

  /** A parcel the guard received for A's home. */
  async function aParcel(): Promise<string> {
    const unit = await w.helpers.unitRow(w.a, w.a.homeUnitId);
    const res = await parcelHelpers(h).receive(w.a.tokens.guard, unit.code);
    return body<{ id: string }>(res).id;
  }

  /** A ticket of A's home, assigned, with a visit soon; `confirmed` agrees to it. */
  async function aVisit(
    confirmed = false,
  ): Promise<{ ticketId: string; visitId: string }> {
    const ticketId = await aTicket();
    await call(w, 'POST', `/maintenance/tickets/${ticketId}/assign`, {
      token: w.a.tokens.manager,
      body: { technicianId: w.a.ids.technician },
    }).expect(204);
    const start = Date.now() + 20 * 60_000;
    const visit = await call(
      w,
      'POST',
      `/technician/tickets/${ticketId}/visits`,
      {
        token: w.a.tokens.technician,
        body: {
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + 3_600_000).toISOString(),
        },
      },
    ).expect(201);
    const visitId = body<{ id: string }>(visit).id;
    if (confirmed)
      await call(w, 'POST', `/tickets/${ticketId}/visits/${visitId}/confirm`, {
        token: w.a.tokens.owner,
      }).expect(204);
    return { ticketId, visitId };
  }

  async function login(): Promise<{
    verify: Response;
    select: Response;
    refresh: Response;
  }> {
    const person = await w.helpers.resident(w.a, [w.a.homeUnitId], 'tenant');
    const since = new Date();
    await call(w, 'POST', '/auth/otp/request', {
      body: { identifier: person.email },
    }).expect(202);
    const code = await waitForOtp(person.email, since);
    const verify = await call(w, 'POST', '/auth/otp/verify', {
      body: { identifier: person.email, code },
    });
    const select = await call(w, 'POST', '/auth/select-account', {
      body: {
        loginTicket: body<{ loginTicket: string }>(verify).loginTicket,
        accountId: person.id,
      },
    });
    const refresh = await call(w, 'POST', '/auth/refresh', {
      body: {
        refreshToken: body<{ refreshToken: string }>(select).refreshToken,
      },
    });
    return { verify, select, refresh };
  }

  async function platform(mustChangePassword: boolean) {
    const email = `admin-${uniqueSuffix()}@jiwar.test`;
    await h.moduleRef.get(GlobalDbService).platformAdmin.create({
      data: {
        id: newId(),
        email,
        passwordHash: await hashPassword('no-store-password-1'),
        mustChangePassword,
      },
    });
    return call(w, 'POST', '/platform/auth/login', {
      body: { email, password: 'no-store-password-1' },
    });
  }

  async function activeEngagement() {
    const reg = await call(w, 'POST', `/units/${w.a.homeUnitId}/workers`, {
      token: w.a.tokens.owner,
      body: workerBody(),
    }).expect(201);
    const id = body<{ engagementId: string }>(reg).engagementId;
    const review = await call(w, 'POST', `/worker-engagements/${id}/review`, {
      token: w.a.tokens.manager,
      body: { decision: 'approve' },
    });
    return { id, review };
  }

  /** A live visitor link's token (ADR 0030): the fragment of `link`. */
  async function linkToken(): Promise<string> {
    const pass = await call(
      w,
      'POST',
      `/units/${w.a.homeUnitId}/visitor-passes`,
      { token: w.a.tokens.owner, body: passBody() },
    ).expect(201);
    return body<{ link: string }>(pass).link.split('#')[1];
  }

  /** A waiting gate request for A's home unit (ADR 0043: no-store). */
  async function askHome(): Promise<string> {
    const unit = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.unit.findUniqueOrThrow({
        where: { id: w.a.homeUnitId },
      }),
    );
    const res = await call(w, 'POST', '/gate/approval-requests', {
      token: w.a.tokens.guard,
      body: { kind: 'uninvited_visitor', unitCode: unit.code },
    }).expect(201);
    return body<{ id: string }>(res).id;
  }

  // Community life (ADR 0040).
  // eslint-disable-next-line no-restricted-syntax -- any future instant: events and polls compare instants only
  const day = (n: number) => new Date(Date.now() + n * 86_400_000);
  const created = async (path: string, token: string, payload: object) =>
    body<{ id: string }>(
      await call(w, 'POST', path, { token, body: payload }).expect(201),
    ).id;
  /** A draft announcement of A's manager. */
  const aDraft = () =>
    created('/community/announcements', w.a.tokens.manager, {
      kind: 'general',
      titleEn: 'No-store',
      bodyEn: 'No-store',
    });
  /** An announcement that is out, put to everyone. */
  async function anAnnouncement(): Promise<string> {
    const id = await aDraft();
    await call(w, 'POST', `/community/announcements/${id}/publish`, {
      token: w.a.tokens.manager,
    }).expect(204);
    return id;
  }
  const anEvent = () =>
    created('/community/events', w.a.tokens.manager, {
      titleEn: 'No-store',
      descriptionEn: 'No-store',
      place: 'No-store',
      startsAt: day(2),
      endsAt: day(3),
    });
  const aPoll = () =>
    created('/community/polls', w.a.tokens.manager, {
      questionEn: 'No-store?',
      options: [{ labelEn: 'Yes' }, { labelEn: 'No' }],
      closesAt: day(3),
    });
  const suggestionTopic = async () =>
    (
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.suggestionTopic.findFirstOrThrow({
          where: { key: 'general' },
        }),
      )
    ).id;
  /** A suggestion of A's owner. */
  const aSuggestion = async () =>
    created('/suggestions', w.a.tokens.owner, {
      topicId: await suggestionTopic(),
      body: 'No-store',
    });
  /** One the staff put on the board. */
  async function aPublishedSuggestion(): Promise<string> {
    const id = await aSuggestion();
    await call(w, 'POST', `/community/suggestions/${id}/publish`, {
      token: w.a.tokens.manager,
      body: { titleEn: 'No-store', textEn: 'No-store' },
    }).expect(204);
    return id;
  }
  /** One that was done. */
  async function aDoneSuggestion(): Promise<string> {
    const id = await aSuggestion();
    await call(w, 'POST', `/community/suggestions/${id}/status`, {
      token: w.a.tokens.manager,
      body: { status: 'done' },
    }).expect(204);
    return id;
  }
  const asManager = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    path: string,
    payload?: object,
  ) => call(w, method, path, { token: w.a.tokens.manager, body: payload });
  const asOwner = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    payload?: object,
  ) => call(w, method, path, { token: w.a.tokens.owner, body: payload });

  // Neighbours (ADR 0042): every response is no-store. The owner (home)
  // and the tenant (rented) are each other's neighbours; the landlord and
  // the family member are the pair the block calls use, so a block never
  // stands between the other two.
  const as = (
    persona: 'owner' | 'tenant' | 'landlord' | 'family' | 'manager',
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    payload?: object,
  ) => call(w, method, path, { token: w.a.tokens[persona], body: payload });
  let limitsRaised: Promise<unknown> | null = null;
  /** Limits out of the way: this suite files and posts many times. */
  const raised = () =>
    (limitsRaised ??= as('manager', 'PATCH', '/neighbours/settings', {
      maxOpenComplaints: 50,
      maxOpenPosts: 50,
      maxNewConversationsPerDay: 100,
    }).expect(200));
  const complaintCategory = async () =>
    (
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.neighbourComplaintCategory.findFirstOrThrow({
          where: { key: 'noise' },
        }),
      )
    ).id;
  const rentedCode = async () =>
    (
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: w.a.rentedUnitId },
        }),
      )
    ).code;
  const complaintBody = async () => ({
    categoryId: await complaintCategory(),
    targetUnitCode: await rentedCode(),
    body: 'No-store',
  });
  /** A complaint of A's owner against the rented unit. */
  async function aComplaint(): Promise<string> {
    await raised();
    return created(
      '/neighbour-complaints',
      w.a.tokens.owner,
      await complaintBody(),
    );
  }
  async function aReviewedComplaint(): Promise<string> {
    const id = await aComplaint();
    await as('manager', 'POST', `/neighbours/complaints/${id}/review`).expect(
      204,
    );
    return id;
  }
  /** A complaint whose notice went to the tenant: both ids. */
  async function aNotice(): Promise<{ complaintId: string; noticeId: string }> {
    const complaintId = await aReviewedComplaint();
    const res = await as(
      'manager',
      'POST',
      `/neighbours/complaints/${complaintId}/notice`,
      { body: 'No-store' },
    ).expect(201);
    return { complaintId, noticeId: body<{ id: string }>(res).id };
  }
  /** A post of `by` on a board. */
  async function aPost(
    kind = 'found',
    by: 'owner' | 'family' = 'owner',
  ): Promise<string> {
    await raised();
    return created('/neighbour-posts', w.a.tokens[by], {
      kind,
      body: 'No-store',
    });
  }
  /** The tenant's claim on a found post of the owner: both ids. */
  async function aClaim(): Promise<{ postId: string; claimId: string }> {
    const postId = await aPost();
    return {
      postId,
      claimId: await created(
        `/neighbour-posts/${postId}/claims`,
        w.a.tokens.tenant,
        {},
      ),
    };
  }
  /** A conversation the tenant started on a lending post of the owner. */
  async function aConversation(): Promise<string> {
    const postId = await aPost('lend');
    return created(
      `/neighbour-posts/${postId}/conversations`,
      w.a.tokens.tenant,
      {
        body: 'No-store',
      },
    );
  }
  /** The landlord's blocks, undone: the pair may meet again. */
  async function unblocked(): Promise<void> {
    const res = await as('landlord', 'GET', '/neighbour-blocks').expect(200);
    for (const b of body<{ data: { id: string }[] }>(res).data)
      await as('landlord', 'DELETE', `/neighbour-blocks/${b.id}`).expect(204);
  }
  /** A conversation the landlord started on a post of the family member. */
  async function aPairConversation(): Promise<string> {
    await unblocked();
    const postId = await aPost('lend', 'family');
    return created(
      `/neighbour-posts/${postId}/conversations`,
      w.a.tokens.landlord,
      { body: 'No-store' },
    );
  }
  /** An open report by the tenant on a conversation of theirs. */
  async function aReport(): Promise<string> {
    const id = await aConversation();
    return created(`/neighbour-conversations/${id}/report`, w.a.tokens.tenant, {
      reasonCode: 'spam',
    });
  }

  // Facilities (ADR 0044): every response is no-store.
  let slotsUsed = 0;
  /** A slot of A's roomy facility nobody in this suite has booked. */
  const freshSlot = () => {
    const n = slotsUsed++;
    return at(
      localDay(2 + (n % 7)),
      6 + (Math.floor(n / 7) % 16),
    ).toISOString();
  };
  /** A booking of the owner's home, made now. */
  const aBooking = async () =>
    body<{ id: string }>(
      await as('owner', 'POST', `/units/${w.a.homeUnitId}/bookings`, {
        facilityId: w.aFacilityId,
        startsAt: freshSlot(),
      }).expect(201),
    ).id;
  let approvalRoom: Promise<string> | null = null;
  /** A facility of A's that requires approval, open every day. */
  const aRoom = () =>
    (approvalRoom ??= (async () => {
      const id = body<{ id: string }>(
        await as('manager', 'POST', '/staff/facilities', {
          mode: 'bookable',
          nameEn: 'No-store room',
          nameAr: 'قاعة',
          slotMinutes: 60,
          capacity: 50,
          weeklyQuota: 20,
          requiresApproval: true,
        }).expect(201),
      ).id;
      await as('manager', 'PUT', `/staff/facilities/${id}/hours`, {
        windows: ALL_WEEK,
      }).expect(200);
      return id;
    })());
  /** A pending booking of the owner's home. */
  const aPending = async () =>
    body<{ id: string }>(
      await as('owner', 'POST', `/units/${w.a.homeUnitId}/bookings`, {
        facilityId: await aRoom(),
        startsAt: freshSlot(),
      }).expect(201),
    ).id;
  let closuresMade = 0;
  /** A closure of A's room, each a day further out, an hour long. */
  const aClosure = async () => {
    const n = closuresMade++;
    return as(
      'manager',
      'POST',
      `/staff/facilities/${await aRoom()}/closures`,
      {
        startsAt: at(localDay(40 + n), 10).toISOString(),
        endsAt: at(localDay(40 + n), 11).toISOString(),
        reasonCode: 'other',
      },
    );
  };
  /** A confirmed booking of the tenant's unit whose slot just ended. */
  const anEnded = async () => {
    const id = newId();
    await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.booking.create({
        data: {
          id,
          tenantId: w.a.tenantId,
          facilityId: w.aFacilityId,
          unitId: w.a.rentedUnitId,
          bookedById: w.a.ids.tenant,
          startsAt: new Date(Date.now() - 2 * 3_600_000),
          endsAt: new Date(Date.now() - 3_600_000),
          guests: 0,
          partySize: 1,
          peak: false,
          status: 'confirmed',
        },
      }),
    );
    return id;
  };
  /** A suspension of the tenant's unit in force: three no-shows marked. */
  const aSuspension = async () => {
    for (let i = 0; i < 3; i++)
      await as(
        'manager',
        'POST',
        `/staff/bookings/${await anEnded()}/no-show`,
      ).expect(204);
    const list = await as(
      'manager',
      'GET',
      '/staff/booking-suspensions?inForce=true',
    ).expect(200);
    return body<{ data: { id: string; unitId: string }[] }>(list).data.find(
      (x) => x.unitId === w.a.rentedUnitId,
    )!.id;
  };
  let homeMembership: Promise<string> | null = null;
  /** The owner's home's club membership, made once. */
  const aMembership = () =>
    (homeMembership ??= (async () =>
      body<{ id: string }>(
        await as('manager', 'POST', '/staff/club-memberships', {
          unitId: w.a.homeUnitId,
          people: [],
        }).expect(201),
      ).id)());
  let receiptsMade = 0;
  /** A payment for it. */
  const aPayment = async () =>
    as(
      'manager',
      'POST',
      `/staff/club-memberships/${await aMembership()}/payments`,
      {
        planId: w.aClubPlanId,
        amount: '500',
        receiptNumber: `R-NS-${uniqueSuffix()}-${receiptsMade++}`,
        paidOn: localDay(0),
      },
    );
  /** A's gateway on, and an invoice owed by A's home: a checkout to open (ADR 0046). */
  let aCheckout: Promise<string> | null = null;
  const anOpenCheckout = () =>
    (aCheckout ??= (async () => {
      await w.helpers.asManager(w.a, () =>
        h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
          const gateway = h.moduleRef.get(GatewayService);
          await gateway.set(tx, w.a.tenantId, gatewayBody() as never, {
            accountId: w.a.ids.manager,
          });
          await gateway.setOnline(tx, w.a.tenantId, true);
        }),
      );
      await call(w, 'POST', '/staff/invoices', {
        token: w.a.tokens.manager,
        body: {
          target: 'unit',
          unitId: w.a.homeUnitId,
          kind: 'other',
          dueOn: localDay(5),
          lines: [{ descriptionEn: 'Fee', descriptionAr: 'رسم', amount: '10' }],
        },
      }).expect(201);
      const res = await as(
        'owner',
        'POST',
        `/units/${w.a.homeUnitId}/payment-sessions`,
        {},
      );
      return body<{ id: string }>(res).id;
    })());
  /** An open emergency of A's home, reported by its owner: its id. */
  const anEmergency = async (type: string) =>
    body<{ id: string }>(
      await as('owner', 'POST', '/emergencies', {
        type,
        unitId: w.a.homeUnitId,
      }),
    ).id;

  const asGuard = (method: 'GET' | 'POST', path: string, payload?: object) =>
    call(w, method, path, { token: w.a.tokens.guard, body: payload });
  /**
   * An emergency nobody answered yet: one of A's home's types is cancelled
   * first if open, so every call gets a fresh one.
   */
  const anUnansweredEmergency = async () => {
    const id = await anEmergency('facilities');
    const seen = await asGuard('GET', `/gate/emergencies/${id}`);
    if (body<{ status: string }>(seen).status === 'reported') return id;
    await as('owner', 'POST', `/emergencies/${id}/cancel`, {});
    return anEmergency('facilities');
  };

  /** An escort request of A's owner: the response. */
  const anEscort = () =>
    as('owner', 'POST', '/escort-requests', {
      unitId: w.a.homeUnitId,
      fromPlaceId: w.aPlaceId,
      toPlaceId: w.aPlaceId,
      when: 'in_30',
    });
  /**
   * A fresh open escort request of A's owner: its id. Its open ones are
   * cancelled first, so the unit's three-open limit never answers instead.
   */
  const aService = async () => {
    const open = body<{ data: { id: string }[] }>(
      await as('owner', 'GET', '/me/gate-services?status=open&kind=escort'),
    ).data;
    for (const r of open)
      await as('owner', 'POST', `/gate-services/${r.id}/cancel`);
    return body<{ id: string }>(await anEscort()).id;
  };

  /**
   * The live works permits of A's home are cancelled first, so the unit's
   * three-live limit never answers instead.
   */
  const clearPermits = async (kind = 'works') => {
    for (const status of ['pending', 'approved']) {
      const live = body<{ data: { id: string }[] }>(
        await as(
          'owner',
          'GET',
          `/units/${w.a.homeUnitId}/permits?kind=${kind}&status=${status}`,
        ),
      ).data;
      for (const p of live)
        await as('owner', 'POST', `/permits/${p.id}/cancel`, {});
    }
  };
  /** A small event of A's home, approved at once: the response. */
  const aPermitEvent = () =>
    as('owner', 'POST', `/units/${w.a.homeUnitId}/permits/events`, {
      startsAt: at(localDay(4), 18).toISOString(),
      endsAt: at(localDay(4), 22).toISOString(),
      guests: [{ fullName: 'No-store Guest' }],
    });
  const aWorksBody = {
    workType: 'finishing',
    startsOn: localDay(2),
    endsOn: localDay(4),
    dailyHours: { from: '10:00', to: '14:00' },
    contractorCompany: 'No-store Builders',
    description: 'Painting',
  };
  /** A fresh pending works permit of A's home: its id. */
  const aPermit = async () => {
    await clearPermits();
    return body<{ id: string }>(
      await as(
        'owner',
        'POST',
        `/units/${w.a.homeUnitId}/permits/works`,
        aWorksBody,
      ),
    ).id;
  };
  const aWorker = async (permitId: string) =>
    as('owner', 'POST', `/permits/${permitId}/workers`, {
      fullName: 'No-store Worker',
      photoFileId: await fileHelpers(h).ready(
        w.a.tokens.owner,
        'contractor_photo',
      ),
      idType: 'national_id',
      idLast4: '0001',
    });

  /** Permits and contractors (ADR 0049). */
  /** A new unit of A and its owner, who lives there; the owner's id. */
  const aNewOwner = async () => {
    const unit = await w.helpers.unit(w.a);
    return (await w.helpers.resident(w.a, [unit.id])).id;
  };
  let sittingBoard: Promise<unknown> | null = null;
  /** A board sits in A, with seats to spare (once per suite, or again after an appointment). */
  const aBoard = () =>
    (sittingBoard ??= (async () => {
      // The world seats A's landlord (ADR 0055): this suite's own board
      // replaces it, the landlord on it too.
      const now = body<{ board: { id: string } | null }>(
        await as('manager', 'GET', '/staff/governance/board').expect(200),
      ).board;
      if (now) await lapse(now.id);
      return as('manager', 'POST', '/staff/governance/board/appoint', {
        seats: 15,
        // eslint-disable-next-line no-restricted-syntax -- the board term's length is measured in ms / 86_400_000
        endsAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        members: [w.a.ids.owner, w.a.ids.landlord, await aNewOwner()].map(
          (accountId) => ({ accountId, role: 'member' }),
        ),
      });
    })());
  const aSeat = async () => {
    await aBoard();
    const seat = await as(
      'manager',
      'POST',
      '/staff/governance/board/members',
      {
        accountId: await aNewOwner(),
        role: 'member',
      },
    ).expect(201);
    return body<{ members: { id: string; endedAt: string | null }[] }>(seat)
      .members.filter((m) => !m.endedAt)
      .at(-1)!.id;
  };
  /** A board sits in A now: the one there, or a new one after a lapse. */
  const aSittingBoard = async () => {
    const now = body<{ board: { id: string; status: string } | null }>(
      await as('manager', 'GET', '/staff/governance/board').expect(200),
    ).board;
    if (now?.status === 'current') return;
    if (now) await lapse(now.id);
    sittingBoard = null;
    await aBoard();
  };
  const aDecision = {
    kind: 'decision',
    decidedOn: today(),
    titleEn: 'No-store decision',
    bodyEn: 'Decided.',
  };
  const aPublication = async () => {
    await aSittingBoard();
    return body<{ id: string }>(
      await as('manager', 'POST', '/governance/publications', aDecision).expect(
        201,
      ),
    ).id;
  };
  /** Ids this suite reads again later: never cancelled to make room. */
  const keep = new Set<string>();
  /**
   * A compound holds 10 polls and elections under way at most: this suite
   * makes many, so before each one it cancels its own that nobody reads
   * again.
   */
  const makeRoom = async () => {
    for (const status of ['scheduled', 'open'])
      for (const p of body<{ data: { id: string }[] }>(
        await as(
          'manager',
          'GET',
          `/staff/governance/polls?status=${status}&limit=100`,
        ),
      ).data)
        if (!keep.has(p.id))
          await as('manager', 'POST', `/governance/polls/${p.id}/cancel`, {
            reasonCode: 'other',
          }).expect(200);
    for (const phase of [
      'upcoming',
      'nominating',
      'nominations_closed',
      'voting',
    ])
      for (const e of body<{ data: { id: string }[] }>(
        await as(
          'manager',
          'GET',
          `/staff/governance/elections?phase=${phase}&limit=100`,
        ),
      ).data)
        if (!keep.has(e.id))
          await as('manager', 'POST', `/governance/elections/${e.id}/cancel`, {
            reasonCode: 'other',
          }).expect(200);
  };
  /** A poll put by A's manager (open now, unless `opensAt`); its id. */
  const aGovernancePollOf = async (over: object = {}) => {
    await makeRoom();
    return body<{ id: string }>(
      await as('manager', 'POST', '/governance/polls', {
        kind: 'yes_no',
        titleEn: 'No-store poll',
        bodyEn: 'Whether.',
        secret: true,
        quorumPct: 50,
        thresholdPct: 50,
        closesAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
        ...over,
      }).expect(201),
    ).id;
  };
  const electionBodyNow = (over: object = {}) => ({
    titleEn: 'No-store election',
    bodyEn: 'Three seats.',
    seats: 3,
    termMonths: 24,
    nominationsCloseAt: new Date(Date.now() + 25 * 3_600_000).toISOString(),
    votingOpensAt: new Date(Date.now() + 25 * 3_600_000).toISOString(),
    votingClosesAt: new Date(Date.now() + 49 * 3_600_000).toISOString(),
    ...over,
  });
  /** An election called by A's manager (nominations open now); its id. */
  const aGovernanceElectionOf = async (over: object = {}) => {
    await makeRoom();
    return body<{ id: string }>(
      await as(
        'manager',
        'POST',
        '/governance/elections',
        electionBodyNow(over),
      ).expect(201),
    ).id;
  };
  let oneGovernanceElection: Promise<string> | null = null;
  const aGovernanceElection = () =>
    (oneGovernanceElection ??= aGovernanceElectionOf().then((id) => {
      keep.add(id);
      return id;
    }));
  let oneGovernancePoll: Promise<string> | null = null;
  const aGovernancePoll = () =>
    (oneGovernancePoll ??= aGovernancePollOf().then((id) => {
      keep.add(id);
      return id;
    }));
  const GOVERNANCE_CALLS = (): Record<string, () => Promise<Response>> => ({
    'GET /governance/board': () => as('owner', 'GET', '/governance/board'),
    'GET /governance/board/terms': () =>
      as('owner', 'GET', '/governance/board/terms'),
    'GET /staff/governance/board': () =>
      as('manager', 'GET', '/staff/governance/board'),
    'GET /staff/governance/board/terms': () =>
      as('manager', 'GET', '/staff/governance/board/terms'),
    'POST /staff/governance/board/appoint': async () => {
      await aBoard();
      const now = body<{ board: { id: string } | null }>(
        await as('manager', 'GET', '/staff/governance/board').expect(200),
      ).board;
      if (now) await lapse(now.id);
      sittingBoard = null;
      const res = await aBoard();
      return res as Response;
    },
    'POST /staff/governance/board/members': async () => {
      await aBoard();
      return as('manager', 'POST', '/staff/governance/board/members', {
        accountId: await aNewOwner(),
        role: 'member',
      });
    },
    'PATCH /staff/governance/board/members/{id}': async () =>
      as(
        'manager',
        'PATCH',
        `/staff/governance/board/members/${await aSeat()}`,
        {
          role: 'member',
        },
      ),
    'POST /staff/governance/board/members/{id}/end': async () =>
      as(
        'manager',
        'POST',
        `/staff/governance/board/members/${await aSeat()}/end`,
        {
          reasonCode: 'resigned',
        },
      ),
    'GET /staff/governance/owners': () =>
      as('manager', 'GET', '/staff/governance/owners'),
    'GET /governance/polls': async () => {
      await aGovernancePoll();
      return as('owner', 'GET', '/governance/polls');
    },
    'GET /governance/polls/{id}': async () =>
      as('owner', 'GET', `/governance/polls/${await aGovernancePoll()}`),
    'POST /governance/polls/{id}/votes': async () => {
      const id = await aGovernancePollOf();
      const poll = body<{ options: { id: string; key: string }[] }>(
        await as('owner', 'GET', `/governance/polls/${id}`).expect(200),
      );
      return as('owner', 'POST', `/governance/polls/${id}/votes`, {
        unitId: w.a.homeUnitId,
        optionIds: [poll.options.find((o) => o.key === 'yes')!.id],
      });
    },
    'POST /governance/polls': async () => {
      await makeRoom();
      return as('manager', 'POST', '/governance/polls', {
        kind: 'yes_no',
        titleEn: 'No-store poll',
        bodyEn: 'Whether.',
        secret: false,
        quorumPct: 50,
        thresholdPct: 50,
        closesAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      });
    },
    'PATCH /governance/polls/{id}': async () => {
      const id = await aGovernancePollOf({
        opensAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      return as('manager', 'PATCH', `/governance/polls/${id}`, {
        quorumPct: 30,
      });
    },
    'POST /governance/polls/{id}/cancel': async () =>
      as(
        'manager',
        'POST',
        `/governance/polls/${await aGovernancePollOf()}/cancel`,
        {
          reasonCode: 'created_in_error',
        },
      ),
    'GET /governance/elections': async () => {
      await aGovernanceElection();
      return as('owner', 'GET', '/governance/elections');
    },
    'GET /governance/elections/{id}': async () =>
      as(
        'owner',
        'GET',
        `/governance/elections/${await aGovernanceElection()}`,
      ),
    'POST /governance/elections/{id}/candidacy': async () =>
      as(
        'landlord',
        'POST',
        `/governance/elections/${await aGovernanceElectionOf()}/candidacy`,
        { statement: 'No-store statement' },
      ),
    'POST /governance/elections/{id}/candidacy/withdraw': async () => {
      const id = await aGovernanceElectionOf();
      await as(
        'owner',
        'POST',
        `/governance/elections/${id}/candidacy`,
        {},
      ).expect(201);
      return as(
        'owner',
        'POST',
        `/governance/elections/${id}/candidacy/withdraw`,
      );
    },
    'POST /governance/elections/{id}/votes': async () => {
      const id = await aGovernanceElectionOf();
      await as(
        'landlord',
        'POST',
        `/governance/elections/${id}/candidacy`,
        {},
      ).expect(201);
      await shiftElection(id, -25);
      await h.moduleRef.get(SweepRunner).run(CONTEST_OPEN_SWEEP, new Date());
      const e = body<{ candidates: { id: string }[] }>(
        await as('owner', 'GET', `/governance/elections/${id}`).expect(200),
      );
      return as('owner', 'POST', `/governance/elections/${id}/votes`, {
        unitId: w.a.homeUnitId,
        candidateIds: [e.candidates[0].id],
      });
    },
    'POST /governance/elections': async () => {
      await makeRoom();
      return as('manager', 'POST', '/governance/elections', electionBodyNow());
    },
    'PATCH /governance/elections/{id}': async () => {
      const id = await aGovernanceElectionOf({
        nominationsOpenAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      return as('manager', 'PATCH', `/governance/elections/${id}`, {
        termMonths: 36,
      });
    },
    'POST /governance/elections/{id}/cancel': async () =>
      as(
        'manager',
        'POST',
        `/governance/elections/${await aGovernanceElectionOf()}/cancel`,
        { reasonCode: 'postponed' },
      ),
    'POST /staff/governance/elections/{id}/certify': async () => {
      const id = await aGovernanceElectionOf();
      await as(
        'landlord',
        'POST',
        `/governance/elections/${id}/candidacy`,
        {},
      ).expect(201);
      const sweeps = h.moduleRef.get(SweepRunner);
      await shiftElection(id, -25);
      await sweeps.run(CONTEST_OPEN_SWEEP, new Date());
      const e = body<{ candidates: { id: string }[] }>(
        await as('owner', 'GET', `/governance/elections/${id}`).expect(200),
      );
      await as('owner', 'POST', `/governance/elections/${id}/votes`, {
        unitId: w.a.homeUnitId,
        candidateIds: [e.candidates[0].id],
      }).expect(201);
      await shiftElection(id, -25);
      await sweeps.run(CONTEST_CLOSE_SWEEP, new Date());
      return as(
        'manager',
        'POST',
        `/staff/governance/elections/${id}/certify`,
        {},
      );
    },
    'GET /staff/governance/elections': () =>
      as('manager', 'GET', '/staff/governance/elections'),
    'GET /staff/governance/elections/{id}': async () =>
      as(
        'manager',
        'GET',
        `/staff/governance/elections/${await aGovernanceElection()}`,
      ),
    'POST /staff/governance/elections/{id}/candidates/{candidateId}/disqualify':
      async () => {
        const id = await aGovernanceElectionOf();
        await as(
          'landlord',
          'POST',
          `/governance/elections/${id}/candidacy`,
          {},
        ).expect(201);
        const e = body<{ candidates: { id: string }[] }>(
          await as(
            'manager',
            'GET',
            `/staff/governance/elections/${id}`,
          ).expect(200),
        );
        return as(
          'manager',
          'POST',
          `/staff/governance/elections/${id}/candidates/${e.candidates[0].id}/disqualify`,
          { reasonCode: 'not_eligible' },
        );
      },
    'GET /governance/publications': () =>
      as('owner', 'GET', '/governance/publications'),
    'POST /governance/publications': async () => {
      await aSittingBoard();
      return as('manager', 'POST', '/governance/publications', aDecision);
    },
    'PATCH /governance/publications/{id}': async () =>
      as(
        'manager',
        'PATCH',
        `/governance/publications/${await aPublication()}`,
        {
          titleEn: 'Corrected',
        },
      ),
    'POST /governance/publications/{id}/archive': async () =>
      as(
        'manager',
        'POST',
        `/governance/publications/${await aPublication()}/archive`,
      ),
    'GET /staff/governance/publications': () =>
      as('manager', 'GET', '/staff/governance/publications'),
    'GET /staff/governance/polls': () =>
      as('manager', 'GET', '/staff/governance/polls'),
    'GET /staff/governance/polls/{id}': async () =>
      as(
        'manager',
        'GET',
        `/staff/governance/polls/${await aGovernancePoll()}`,
      ),
  });
  const PERMIT_CALLS = (): Record<string, () => Promise<Response>> => ({
    'POST /units/{unitId}/permits/works': async () => {
      await clearPermits();
      return as(
        'owner',
        'POST',
        `/units/${w.a.homeUnitId}/permits/works`,
        aWorksBody,
      );
    },
    'GET /units/{unitId}/permits': () =>
      as('owner', 'GET', `/units/${w.a.homeUnitId}/permits`),
    'GET /permits/{id}': async () =>
      as('owner', 'GET', `/permits/${await aPermit()}`),
    'POST /permits/{id}/cancel': async () =>
      as('owner', 'POST', `/permits/${await aPermit()}/cancel`, {}),
    'POST /permits/{id}/workers': async () => aWorker(await aPermit()),
    'POST /units/{unitId}/permits/moves': async () => {
      await clearPermits('move');
      // A's first work day three days on, under its rules: never a fixed
      // offset (Tuesday + 3 is a Friday, a day off by default).
      const rules = (await as('owner', 'GET', '/community/permit-rules'))
        .body as PermitRulesBody;
      return as('owner', 'POST', `/units/${w.a.homeUnitId}/permits/moves`, {
        date: workDaysOf(rules, 1, 3)[0],
        window: { from: '10:00', to: '12:00' },
        truckPlate: 'NS 1',
        itemsDescription: 'Boxes',
      });
    },
    'POST /units/{unitId}/permits/material-exits': async () => {
      await clearPermits('material_exit');
      return as(
        'owner',
        'POST',
        `/units/${w.a.homeUnitId}/permits/material-exits`,
        {
          validFrom: localDay(1),
          validUntil: localDay(2),
          items: [{ name: 'Tiles', quantity: 2 }],
        },
      );
    },
    'POST /units/{unitId}/permits/events': async () => {
      await clearPermits('event');
      return aPermitEvent();
    },
    'POST /permits/{id}/guests': async () => {
      await clearPermits('event');
      const id = body<{ id: string }>(await aPermitEvent()).id;
      return as('owner', 'POST', `/permits/${id}/guests`, {
        guests: [{ fullName: 'No-store Late Guest' }],
      });
    },
    'POST /permits/{id}/guests/{guestId}/remove': async () => {
      await clearPermits('event');
      const made = body<{ id: string; event: { guests: { id: string }[] } }>(
        await aPermitEvent(),
      );
      return as(
        'owner',
        'POST',
        `/permits/${made.id}/guests/${made.event.guests[0].id}/remove`,
        {},
      );
    },
    'GET /staff/unit-permits': () =>
      as('manager', 'GET', '/staff/unit-permits?status=pending'),
    'GET /staff/unit-permits/{id}': async () =>
      as('manager', 'GET', `/staff/unit-permits/${await aPermit()}`),
    'POST /staff/unit-permits/{id}/approve': async () =>
      as(
        'manager',
        'POST',
        `/staff/unit-permits/${await aPermit()}/approve`,
        {},
      ),
    'POST /staff/unit-permits/{id}/reject': async () =>
      as('manager', 'POST', `/staff/unit-permits/${await aPermit()}/reject`, {
        reasonCode: 'other',
      }),
    'POST /staff/unit-permits/{id}/revoke': async () => {
      const id = await aPermit();
      await as('manager', 'POST', `/staff/unit-permits/${id}/approve`, {});
      return as('manager', 'POST', `/staff/unit-permits/${id}/revoke`, {
        reasonCode: 'other',
      });
    },
    // Stop work (ADR 0053).
    'POST /staff/unit-permits/{id}/stop-work': async () => {
      const id = await aPermit();
      await as('manager', 'POST', `/staff/unit-permits/${id}/approve`, {});
      return as('manager', 'POST', `/staff/unit-permits/${id}/stop-work`, {
        reasonCode: 'other',
      });
    },
    'POST /staff/unit-permits/{id}/resume-work': async () => {
      const id = await aPermit();
      await as('manager', 'POST', `/staff/unit-permits/${id}/approve`, {});
      await as('manager', 'POST', `/staff/unit-permits/${id}/stop-work`, {
        reasonCode: 'other',
      });
      return as('manager', 'POST', `/staff/unit-permits/${id}/resume-work`, {});
    },
    'POST /gate/unit-permits/{id}/stop-work': async () => {
      const id = await aPermit();
      await as('manager', 'POST', `/staff/unit-permits/${id}/approve`, {});
      return asGuard('POST', `/gate/unit-permits/${id}/stop-work`, {
        reasonCode: 'safety_hazard',
      });
    },
    'POST /staff/unit-permits/{id}/workers/{workerId}/remove': async () => {
      const permitId = await aPermit();
      const added = body<{ works: { workers: { id: string }[] } }>(
        await aWorker(permitId),
      );
      return as(
        'manager',
        'POST',
        `/staff/unit-permits/${permitId}/workers/${added.works.workers[0].id}/remove`,
        { reasonCode: 'not_needed' },
      );
    },
    'POST /staff/unit-permits/{id}/workers/{workerId}/unlock': async () => {
      const permitId = await aPermit();
      const added = body<{ works: { workers: { id: string }[] } }>(
        await aWorker(permitId),
      );
      return as(
        'manager',
        'POST',
        `/staff/unit-permits/${permitId}/workers/${added.works.workers[0].id}/unlock`,
        {},
      );
    },
    'POST /staff/unit-permits/{id}/guards/{guardId}/unlock': async () =>
      as(
        'manager',
        'POST',
        `/staff/unit-permits/${await aPermit()}/guards/${w.a.ids.guard}/unlock`,
        {},
      ),
    'GET /gate/unit-permits': () =>
      asGuard('GET', '/gate/unit-permits?reference=W-1'),
    'GET /gate/unit-permits/{id}': async () => {
      await clearPermits();
      const id = body<{ id: string }>(
        await as('owner', 'POST', `/units/${w.a.homeUnitId}/permits/works`, {
          ...aWorksBody,
          startsOn: localDay(0),
          endsOn: localDay(1),
        }),
      ).id;
      await as('manager', 'POST', `/staff/unit-permits/${id}/approve`, {});
      return asGuard('GET', `/gate/unit-permits/${id}`);
    },
    'POST /gate/unit-permits/{id}/use': async () => {
      await clearPermits('material_exit');
      const id = body<{ id: string }>(
        await as(
          'owner',
          'POST',
          `/units/${w.a.homeUnitId}/permits/material-exits`,
          {
            validFrom: localDay(0),
            validUntil: localDay(1),
            items: [{ name: 'Tiles', quantity: 2 }],
          },
        ),
      ).id;
      await as('manager', 'POST', `/staff/unit-permits/${id}/approve`, {});
      return asGuard('POST', `/gate/unit-permits/${id}/use`, {});
    },
    'POST /gate/material-entries': async () => {
      const unit = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: w.a.homeUnitId },
        }),
      );
      return asGuard('POST', '/gate/material-entries', {
        unitCode: unit.code,
        description: 'Cement',
      });
    },
    'GET /staff/material-entries': () =>
      as('manager', 'GET', '/staff/material-entries'),
    'POST /permits/{id}/workers/{workerId}/remove': async () => {
      const permitId = await aPermit();
      const added = body<{ works: { workers: { id: string }[] } }>(
        await aWorker(permitId),
      );
      return as(
        'owner',
        'POST',
        `/permits/${permitId}/workers/${added.works.workers[0].id}/remove`,
        {},
      );
    },
    'GET /community/permit-rules': () =>
      as('owner', 'GET', '/community/permit-rules'),
    'GET /staff/permit-settings': () =>
      as('manager', 'GET', '/staff/permit-settings'),
    'PATCH /staff/permit-settings': () =>
      as('manager', 'PATCH', '/staff/permit-settings', {
        daysOff: ['2026-12-25'],
      }),
  });

  /** Emergencies and gate services (ADR 0047). */
  const SAFETY_CALLS = (): Record<string, () => Promise<Response>> => ({
    'GET /community/places': () => as('owner', 'GET', '/community/places'),
    'GET /places': () => as('manager', 'GET', '/places'),
    'POST /places': () =>
      as('manager', 'POST', '/places', {
        nameEn: `NS ${uniqueSuffix()}`,
        nameAr: `مكان ${uniqueSuffix()}`,
      }),
    'PATCH /places/{id}': () =>
      as('manager', 'PATCH', `/places/${w.aPlaceId}`, { position: 40 }),
    'GET /units/{unitId}/emergency-contacts': () =>
      as('owner', 'GET', `/units/${w.a.homeUnitId}/emergency-contacts`),
    'POST /emergencies': () =>
      as('owner', 'POST', '/emergencies', {
        type: 'medical',
        unitId: w.a.homeUnitId,
      }),
    'GET /me/emergencies': () => as('family', 'GET', '/me/emergencies'),
    'GET /emergencies/{id}': async () =>
      as('owner', 'GET', `/emergencies/${await anEmergency('medical')}`),
    'POST /emergencies/{id}/cancel': async () =>
      as('owner', 'POST', `/emergencies/${await anEmergency('fire')}/cancel`, {
        reasonCode: 'false_alarm',
      }),
    // A guard's SOS (ADR 0053): raised (or the open one answered) and cancelled.
    'POST /gate/emergencies': () =>
      asGuard('POST', '/gate/emergencies', { type: 'security' }),
    'POST /gate/emergencies/{id}/cancel': async () => {
      const raised = await asGuard('POST', '/gate/emergencies', {
        type: 'facilities',
      });
      return asGuard(
        'POST',
        `/gate/emergencies/${(raised.body as { id: string }).id}/cancel`,
        {},
      );
    },
    'GET /gate/emergencies': () =>
      asGuard('GET', '/gate/emergencies?status=open'),
    'GET /gate/emergencies/{id}': async () =>
      asGuard('GET', `/gate/emergencies/${await anEmergency('medical')}`),
    'POST /gate/emergencies/{id}/accept': async () =>
      asGuard(
        'POST',
        `/gate/emergencies/${await anUnansweredEmergency()}/accept`,
        { etaMinutes: 5 },
      ),
    'POST /gate/emergencies/{id}/arrived': async () => {
      const id = await anUnansweredEmergency();
      await asGuard('POST', `/gate/emergencies/${id}/accept`, {
        etaMinutes: 2,
      }).expect(200);
      return asGuard('POST', `/gate/emergencies/${id}/arrived`);
    },
    'POST /gate/emergencies/{id}/resolve': async () =>
      as(
        'manager',
        'POST',
        `/gate/emergencies/${await anUnansweredEmergency()}/resolve`,
        { reasonCode: 'false_alarm' },
      ),
    'POST /accessibility-requests': () =>
      as('owner', 'POST', '/accessibility-requests', {
        unitId: w.a.homeUnitId,
        assistanceKind: 'bags',
        fromPlaceId: w.aPlaceId,
        when: 'now',
      }),
    'POST /security-reports': () =>
      as('owner', 'POST', '/security-reports', {
        unitId: w.a.homeUnitId,
        placeId: w.aPlaceId,
        description: 'NS suspicious',
      }),
    'POST /escort-requests': () => anEscort(),
    'POST /lane-requests': () =>
      as('owner', 'POST', '/lane-requests', {
        unitId: w.a.homeUnitId,
        reason: 'large_delivery',
        gateId: w.a.gateId,
      }),
    'GET /me/gate-services': () => as('owner', 'GET', '/me/gate-services'),
    'GET /gate-services/{id}': async () =>
      as('owner', 'GET', `/gate-services/${await aService()}`),
    'POST /gate-services/{id}/cancel': async () =>
      as('owner', 'POST', `/gate-services/${await aService()}/cancel`),
    'GET /gate/gate-services': () =>
      asGuard('GET', '/gate/gate-services?status=open'),
    'GET /gate/gate-services/{id}': async () =>
      asGuard('GET', `/gate/gate-services/${await aService()}`),
    'POST /gate/gate-services/{id}/accept': async () =>
      asGuard('POST', `/gate/gate-services/${await aService()}/accept`, {
        etaMinutes: 10,
      }),
    'POST /gate/gate-services/{id}/start': async () => {
      const id = await aService();
      await asGuard('POST', `/gate/gate-services/${id}/accept`, {
        etaMinutes: 5,
      }).expect(200);
      return asGuard('POST', `/gate/gate-services/${id}/start`);
    },
    'POST /gate/gate-services/{id}/close': async () =>
      asGuard('POST', `/gate/gate-services/${await aService()}/close`, {
        reasonCode: 'duplicate',
      }),
    'POST /emergencies/{id}/on-my-way': async () =>
      as(
        'family',
        'POST',
        `/emergencies/${await anEmergency('security')}/on-my-way`,
      ),
  });

  /** A fresh invoice of A's home: one dispute per call never collides. */
  const aFreshInvoice = async (): Promise<string> => {
    const batch = await call(w, 'POST', '/staff/invoices', {
      token: w.a.tokens.manager,
      body: {
        target: 'unit',
        unitId: w.a.homeUnitId,
        kind: 'other',
        dueOn: localDay(5),
        lines: [{ descriptionEn: 'Fee', descriptionAr: 'رسم', amount: '10' }],
      },
    }).expect(201);
    const list = await as(
      'manager',
      'GET',
      `/staff/invoices?batchId=${body<{ id: string }>(batch).id}`,
    );
    return body<{ data: { id: string }[] }>(list).data[0].id;
  };
  /** A's owner disputes a fresh invoice (ADR 0048). */
  const aFreshDispute = async (): Promise<{
    id: string;
    invoiceId: string;
  }> => {
    const invoiceId = await aFreshInvoice();
    const res = await call(w, 'POST', `/invoices/${invoiceId}/disputes`, {
      token: w.a.tokens.owner,
      body: { reasonCode: 'wrong_amount', text: 'Not ours' },
    }).expect(201);
    return { id: body<{ id: string }>(res).id, invoiceId };
  };
  let aDisputeOnce: Promise<{ id: string; invoiceId: string }> | null = null;
  const aDispute = () => (aDisputeOnce ??= aFreshDispute());
  const FINANCE_CALLS = (): Record<string, () => Promise<Response>> => ({
    ...Object.fromEntries(
      ['aging', 'outstanding', 'collections', 'daily-cash'].map((name) => [
        `GET /staff/finance/reports/${name}/export`,
        () =>
          call(w, 'GET', `/staff/finance/reports/${name}/export`, {
            token: w.a.tokens.manager,
            query:
              name === 'collections'
                ? { from: localDay(-30), to: localDay(0) }
                : {},
          }),
      ]),
    ),
    'GET /staff/finance/ledger/export': () =>
      call(w, 'GET', '/staff/finance/ledger/export', {
        token: w.a.tokens.manager,
        query: { from: localDay(-30), to: localDay(0) },
      }),
    'GET /staff/invoice-disputes': async () => {
      await aDispute();
      return as('manager', 'GET', '/staff/invoice-disputes');
    },
    'GET /staff/invoice-disputes/{id}': async () =>
      as('manager', 'GET', `/staff/invoice-disputes/${(await aDispute()).id}`),
    'POST /staff/invoice-disputes/{id}/decide': async () =>
      as(
        'manager',
        'POST',
        `/staff/invoice-disputes/${(await aFreshDispute()).id}/decide`,
        { decision: 'reject', reasonCode: 'charge_is_correct' },
      ),
    'POST /invoices/{id}/disputes': async () =>
      as('owner', 'POST', `/invoices/${await aFreshInvoice()}/disputes`, {
        reasonCode: 'already_paid',
      }),
    'GET /invoices/{id}/disputes': async () =>
      as('owner', 'GET', `/invoices/${(await aDispute()).invoiceId}/disputes`),
    'GET /invoice-disputes/{id}': async () =>
      as('owner', 'GET', `/invoice-disputes/${(await aDispute()).id}`),
    'POST /units/{unitId}/payment-sessions': async () => {
      await anOpenCheckout();
      return as(
        'owner',
        'POST',
        `/units/${w.a.homeUnitId}/payment-sessions`,
        {},
      );
    },
    'POST /public/receipts/lookup': async () => {
      await call(w, 'POST', '/staff/invoices', {
        token: w.a.tokens.manager,
        body: {
          target: 'unit',
          unitId: w.a.homeUnitId,
          kind: 'other',
          dueOn: localDay(5),
          lines: [{ descriptionEn: 'Fee', descriptionAr: 'رسم', amount: '10' }],
        },
      }).expect(201);
      const paid = await as(
        'manager',
        'POST',
        `/staff/units/${w.a.homeUnitId}/payments`,
        {
          amount: '10',
          method: 'cash',
          paidOn: localDay(0),
        },
      );
      return call(w, 'POST', '/public/receipts/lookup', {
        body: { code: body<{ receiptCode: string }>(paid).receiptCode },
      });
    },
    'GET /payment-sessions/{id}': async () =>
      as('owner', 'GET', `/payment-sessions/${await anOpenCheckout()}`),
  });
  const FACILITY_CALLS = (): Record<string, () => Promise<Response>> => ({
    'GET /staff/bookings': () => as('manager', 'GET', '/staff/bookings'),
    'GET /staff/bookings/{id}': async () =>
      as('manager', 'GET', `/staff/bookings/${await aBooking()}`),
    'POST /staff/bookings/{id}/approve': async () =>
      as('manager', 'POST', `/staff/bookings/${await aPending()}/approve`),
    'POST /staff/bookings/{id}/reject': async () =>
      as('manager', 'POST', `/staff/bookings/${await aPending()}/reject`, {
        reasonCode: 'other',
      }),
    'POST /staff/bookings/{id}/cancel': async () =>
      as('manager', 'POST', `/staff/bookings/${await aBooking()}/cancel`, {
        reasonCode: 'other',
      }),
    'GET /staff/facilities/{id}/closures': () =>
      as('manager', 'GET', `/staff/facilities/${w.aFacilityId}/closures`),
    'POST /staff/facilities/{id}/closures': () => aClosure(),
    'POST /staff/facility-closures/{id}/lift': async () =>
      as(
        'manager',
        'POST',
        `/staff/facility-closures/${body<{ id: string }>(await aClosure()).id}/lift`,
        { reasonCode: 'other' },
      ),
    'POST /staff/bookings/{id}/no-show': async () =>
      as('manager', 'POST', `/staff/bookings/${await anEnded()}/no-show`),
    'GET /units/{unitId}/booking-standing': () =>
      as('owner', 'GET', `/units/${w.a.homeUnitId}/booking-standing`),
    'GET /staff/booking-suspensions': () =>
      as('manager', 'GET', '/staff/booking-suspensions'),
    'POST /staff/booking-suspensions/{id}/lift': async () =>
      as(
        'manager',
        'POST',
        `/staff/booking-suspensions/${await aSuspension()}/lift`,
        {
          reasonCode: 'other',
        },
      ),
    'GET /staff/facility-settings': () =>
      as('manager', 'GET', '/staff/facility-settings'),
    'PATCH /staff/facility-settings': () =>
      as('manager', 'PATCH', '/staff/facility-settings', {
        suspensionDays: 14,
      }),
    'GET /club/plans': () => as('owner', 'GET', '/club/plans'),
    'GET /units/{unitId}/club-membership': () =>
      as('owner', 'GET', `/units/${w.a.homeUnitId}/club-membership`),
    'GET /staff/club-plans': () => as('manager', 'GET', '/staff/club-plans'),
    'POST /staff/club-plans': () =>
      as('manager', 'POST', '/staff/club-plans', {
        nameEn: 'No-store',
        nameAr: 'شهري',
        durationKind: 'monthly',
        price: '1',
      }),
    'PATCH /staff/club-plans/{id}': () =>
      as('manager', 'PATCH', `/staff/club-plans/${w.aClubPlanId}`, {
        price: '500',
      }),
    'GET /staff/club/units': async () => {
      const unit = await w.helpers.unitRow(w.a, w.a.homeUnitId);
      return call(w, 'GET', '/staff/club/units', {
        token: w.a.tokens.manager,
        query: { code: unit.code },
      });
    },
    'GET /staff/club/units/{unitId}/people': () =>
      as('manager', 'GET', `/staff/club/units/${w.a.homeUnitId}/people`),
    'GET /staff/club-memberships': () =>
      as('manager', 'GET', '/staff/club-memberships'),
    'GET /staff/club-memberships/{id}': async () =>
      as('manager', 'GET', `/staff/club-memberships/${await aMembership()}`),
    'POST /staff/club-memberships': async () => {
      const unit = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.unit.create({
          data: {
            id: newId(),
            tenantId: w.a.tenantId,
            code: `NS-${uniqueSuffix()}`,
          },
        }),
      );
      return as('manager', 'POST', '/staff/club-memberships', {
        unitId: unit.id,
        people: [],
      });
    },
    'PUT /staff/club-memberships/{id}/people': async () =>
      as(
        'manager',
        'PUT',
        `/staff/club-memberships/${await aMembership()}/people`,
        { people: [] },
      ),
    'POST /staff/club-memberships/{id}/payments': async () => aPayment(),
    'POST /staff/club-payments/{id}/reverse': async () =>
      as(
        'manager',
        'POST',
        `/staff/club-payments/${body<{ id: string }>(await aPayment()).id}/reverse`,
        { reasonCode: 'other' },
      ),
    'GET /staff/facilities/{id}/day': () =>
      as('manager', 'GET', `/staff/facilities/${w.aFacilityId}/day`),
    'GET /facilities': () => as('owner', 'GET', '/facilities'),
    'GET /facilities/{id}': () =>
      as('owner', 'GET', `/facilities/${w.aFacilityId}`),
    'GET /staff/facilities': () => as('manager', 'GET', '/staff/facilities'),
    'GET /staff/facilities/{id}': () =>
      as('manager', 'GET', `/staff/facilities/${w.aFacilityId}`),
    'POST /staff/facilities': () =>
      as('manager', 'POST', '/staff/facilities', {
        mode: 'walk_in',
        nameEn: 'No-store pool',
        nameAr: 'مسبح',
      }),
    'PATCH /staff/facilities/{id}': () =>
      as('manager', 'PATCH', `/staff/facilities/${w.aFacilityId}`, {
        position: 1,
      }),
    'PUT /staff/facilities/{id}/hours': () =>
      as('manager', 'PUT', `/staff/facilities/${w.aFacilityId}/hours`, {
        windows: ALL_WEEK,
      }),
    'PUT /staff/facilities/{id}/peak-windows': () =>
      as('manager', 'PUT', `/staff/facilities/${w.aFacilityId}/peak-windows`, {
        windows: [],
      }),
    'GET /facilities/{id}/slots': () =>
      as('owner', 'GET', `/facilities/${w.aFacilityId}/slots`),
    'POST /units/{unitId}/bookings': () =>
      as('owner', 'POST', `/units/${w.a.homeUnitId}/bookings`, {
        facilityId: w.aFacilityId,
        startsAt: freshSlot(),
      }),
    'GET /units/{unitId}/bookings': () =>
      as('owner', 'GET', `/units/${w.a.homeUnitId}/bookings`),
    'GET /bookings/{id}': async () =>
      as('owner', 'GET', `/bookings/${await aBooking()}`),
    'POST /bookings/{id}/cancel': async () =>
      as('owner', 'POST', `/bookings/${await aBooking()}/cancel`, {
        reasonCode: 'no_longer_needed',
      }),
  });

  /** A's home takes many vehicles here (ADR 0045): raised once. */
  let vehiclesRaised: Promise<unknown> | null = null;
  const roomForVehicles = () =>
    (vehiclesRaised ??= as('manager', 'PATCH', '/staff/vehicle-settings', {
      maxVehiclesPerUnit: 20,
      maxActiveVisitorParkingBookings: 20,
    }));
  /** A new pending vehicle of A's home: its id. */
  const aVehicle = async () => {
    await roomForVehicles();
    const res = await as('owner', 'POST', `/units/${w.a.homeUnitId}/vehicles`, {
      plate: `NS ${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
      makeAndModel: 'No-store car',
      color: 'Red',
      type: 'car',
    });
    return body<{ id: string }>(res).id;
  };
  /** An active vehicle of A's home: its id. */
  const anActiveVehicle = async () => {
    const id = await aVehicle();
    await as('manager', 'POST', `/staff/vehicles/${id}/approve`, {
      version: 1,
      stickerNumber: `NS-${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
      permitValidUntil: localDay(100),
    });
    return id;
  };
  /** A visitor booking of A's home, in A's roomy area, an hour from now. */
  const aParking = async () => {
    await roomForVehicles();
    const start = Math.ceil(Date.now() / 60_000) * 60_000 + 3_600_000;
    return as(
      'owner',
      'POST',
      `/units/${w.a.homeUnitId}/visitor-parking-bookings`,
      {
        areaId: w.aAreaId,
        visitorName: 'No-store guest',
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 1_800_000).toISOString(),
      },
    );
  };
  /** A new parking slot of A's home. */
  const aParkingSlot = async () => {
    const unit = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.unit.findUniqueOrThrow({
        where: { id: w.a.homeUnitId },
      }),
    );
    return as('manager', 'POST', '/staff/parking-slots', {
      unitCode: unit.code,
      code: `NS-${uniqueSuffix()}`.slice(0, 20),
      place: 'No-store row',
    });
  };
  /** A parking report of A's tenant (ten at most open: each is handled or not). */
  const aParkingReport = () =>
    as('tenant', 'POST', '/parking-reports', {
      plate: `NS ${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`,
      location: 'No-store ramp',
    });
  /** A new fine to A's home: its id. */
  const aFine = async () => {
    const unit = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.unit.findUniqueOrThrow({
        where: { id: w.a.homeUnitId },
      }),
    );
    const res = await as('manager', 'POST', '/staff/vehicle-fines', {
      unitCode: unit.code,
      plate: 'NS 2',
      reason: 'blocking',
      amount: '100',
      occurredOn: localDay(0),
    });
    return body<{ id: string }>(res).id;
  };
  /** A fine to A's home under appeal: its id. */
  const anAppealedFine = async () => {
    const id = await aFine();
    await as('owner', 'POST', `/vehicle-fines/${id}/appeal`, {
      reason: 'Not ours',
    });
    return id;
  };
  const VEHICLE_CALLS = (): Record<string, () => Promise<Response>> => ({
    'GET /units/{unitId}/vehicle-fines': () =>
      as('owner', 'GET', `/units/${w.a.homeUnitId}/vehicle-fines`),
    'GET /vehicle-fines/{id}': async () =>
      as('owner', 'GET', `/vehicle-fines/${await aFine()}`),
    'POST /vehicle-fines/{id}/appeal': async () =>
      as('owner', 'POST', `/vehicle-fines/${await aFine()}/appeal`, {
        reason: 'Not ours',
      }),
    'POST /staff/vehicle-fines': async () => {
      const unit = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: w.a.homeUnitId },
        }),
      );
      return as('manager', 'POST', '/staff/vehicle-fines', {
        unitCode: unit.code,
        plate: 'NS 3',
        reason: 'blocking',
        amount: '100',
        occurredOn: localDay(0),
      });
    },
    'GET /staff/vehicle-fines': () =>
      as('manager', 'GET', '/staff/vehicle-fines'),
    'GET /staff/vehicle-fines/{id}': async () =>
      as('manager', 'GET', `/staff/vehicle-fines/${await aFine()}`),
    'POST /staff/vehicle-fines/{id}/decide-appeal': async () =>
      as(
        'manager',
        'POST',
        `/staff/vehicle-fines/${await anAppealedFine()}/decide-appeal`,
        { decision: 'upheld' },
      ),
    'POST /staff/vehicle-fines/{id}/payments': async () =>
      as('manager', 'POST', `/staff/vehicle-fines/${await aFine()}/payments`, {
        amount: '100',
        receiptNumber: `NS-${uniqueSuffix()}`,
        paidOn: localDay(0),
      }),
    'POST /staff/vehicle-fine-payments/{id}/reverse': async () => {
      const paid = await as(
        'manager',
        'POST',
        `/staff/vehicle-fines/${await aFine()}/payments`,
        {
          amount: '100',
          receiptNumber: `NS-${uniqueSuffix()}`,
          paidOn: localDay(0),
        },
      );
      return as(
        'manager',
        'POST',
        `/staff/vehicle-fine-payments/${body<{ id: string }>(paid).id}/reverse`,
        { reasonCode: 'entered_in_error' },
      );
    },
    'POST /parking-reports': () => aParkingReport(),
    'GET /parking-reports': () => as('tenant', 'GET', '/parking-reports'),
    'GET /staff/parking-reports': () =>
      as('manager', 'GET', '/staff/parking-reports'),
    'GET /staff/parking-reports/{id}': async () =>
      as(
        'manager',
        'GET',
        `/staff/parking-reports/${body<{ id: string }>(await aParkingReport()).id}`,
      ),
    'POST /staff/parking-reports/{id}/close': async () =>
      as(
        'manager',
        'POST',
        `/staff/parking-reports/${body<{ id: string }>(await aParkingReport()).id}/close`,
        { reasonCode: 'resolved' },
      ),
    'POST /staff/parking-reports/{id}/convert': async () => {
      const unit = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: w.a.homeUnitId },
        }),
      );
      return as(
        'manager',
        'POST',
        `/staff/parking-reports/${body<{ id: string }>(await aParkingReport()).id}/convert`,
        {
          unitCode: unit.code,
          plate: 'NS 4',
          reason: 'blocking',
          amount: '100',
          occurredOn: localDay(0),
        },
      );
    },
    'POST /staff/vehicle-fines/{id}/cancel': async () =>
      as('manager', 'POST', `/staff/vehicle-fines/${await aFine()}/cancel`, {
        reasonCode: 'issued_in_error',
      }),
    'GET /units/{unitId}/vehicles': () =>
      as('owner', 'GET', `/units/${w.a.homeUnitId}/vehicles`),
    'POST /units/{unitId}/vehicles': async () => {
      await roomForVehicles();
      return as('owner', 'POST', `/units/${w.a.homeUnitId}/vehicles`, {
        plate: 'NS 1',
        makeAndModel: 'No-store car',
        color: 'Red',
        type: 'car',
      });
    },
    'GET /vehicles/{id}': async () =>
      as('owner', 'GET', `/vehicles/${await aVehicle()}`),
    'PATCH /vehicles/{id}': async () =>
      as('owner', 'PATCH', `/vehicles/${await aVehicle()}`, { color: 'Blue' }),
    'GET /staff/vehicles': () => as('manager', 'GET', '/staff/vehicles'),
    'GET /staff/vehicles/{id}': async () =>
      as('manager', 'GET', `/staff/vehicles/${await aVehicle()}`),
    'POST /staff/vehicles/{id}/approve': async () =>
      as('manager', 'POST', `/staff/vehicles/${await aVehicle()}/approve`, {
        version: 1,
        stickerNumber: `NS-${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
        permitValidUntil: localDay(100),
      }),
    'POST /staff/vehicles/{id}/reject': async () =>
      as('manager', 'POST', `/staff/vehicles/${await aVehicle()}/reject`, {
        version: 1,
        reasonCode: 'other',
      }),
    'POST /staff/vehicles/{id}/renew': async () =>
      as(
        'manager',
        'POST',
        `/staff/vehicles/${await anActiveVehicle()}/renew`,
        {
          permitValidUntil: localDay(200),
        },
      ),
    'POST /staff/vehicles/{id}/remove': async () =>
      as('manager', 'POST', `/staff/vehicles/${await aVehicle()}/remove`, {
        reasonCode: 'other',
      }),
    'GET /staff/vehicle-settings': () =>
      as('manager', 'GET', '/staff/vehicle-settings'),
    'POST /gate/plate-lookup': () =>
      call(w, 'POST', '/gate/plate-lookup', {
        token: w.a.tokens.guard,
        body: { plate: 'NS 1' },
      }),
    'GET /gate/visitor-parking': () =>
      call(w, 'GET', '/gate/visitor-parking', { token: w.a.tokens.guard }),
    'GET /units/{unitId}/parking': () =>
      as('owner', 'GET', `/units/${w.a.homeUnitId}/parking`),
    'GET /units/{unitId}/visitor-parking-bookings': () =>
      as('owner', 'GET', `/units/${w.a.homeUnitId}/visitor-parking-bookings`),
    'POST /units/{unitId}/visitor-parking-bookings': () => aParking(),
    'GET /staff/parking-slots': () =>
      as('manager', 'GET', '/staff/parking-slots'),
    'POST /staff/parking-slots': () => aParkingSlot(),
    'PATCH /staff/parking-slots/{id}': async () =>
      as(
        'manager',
        'PATCH',
        `/staff/parking-slots/${body<{ id: string }>(await aParkingSlot()).id}`,
        { place: 'Moved' },
      ),
    'GET /staff/visitor-parking-areas': () =>
      as('manager', 'GET', '/staff/visitor-parking-areas'),
    'POST /staff/visitor-parking-areas': () =>
      as('manager', 'POST', '/staff/visitor-parking-areas', {
        name: `No-store area ${uniqueSuffix()}`,
        capacity: 5,
      }),
    'PATCH /staff/visitor-parking-areas/{id}': () =>
      as('manager', 'PATCH', `/staff/visitor-parking-areas/${w.aAreaId}`, {
        capacity: 500,
      }),
    'GET /staff/visitor-parking-bookings': () =>
      as('manager', 'GET', '/staff/visitor-parking-bookings'),
    'POST /staff/visitor-parking-bookings/{id}/cancel': async () =>
      as(
        'manager',
        'POST',
        `/staff/visitor-parking-bookings/${body<{ id: string }>(await aParking()).id}/cancel`,
        { reasonCode: 'other' },
      ),
    'PATCH /staff/vehicle-settings': () =>
      as('manager', 'PATCH', '/staff/vehicle-settings', {
        maxVehiclesPerUnit: 20,
        maxActiveVisitorParkingBookings: 20,
      }),
  });

  const CALLS: Record<string, () => Promise<Response>> = {
    // Community life (ADR 0040): every response is no-store.
    'GET /community/settings': () => asManager('GET', '/community/settings'),
    'PATCH /community/settings': () =>
      asManager('PATCH', '/community/settings', { eventMaxGuests: 3 }),
    'GET /community/suggestion-topics': () =>
      asManager('GET', '/community/suggestion-topics'),
    'POST /community/suggestion-topics': () =>
      asManager('POST', '/community/suggestion-topics', {
        key: `nostore_${uniqueSuffix().toLowerCase()}`.slice(0, 40),
        nameAr: 'بلا تخزين',
        nameEn: 'No-store',
      }),
    'PATCH /community/suggestion-topics/{id}': async () =>
      asManager(
        'PATCH',
        `/community/suggestion-topics/${await suggestionTopic()}`,
        { nameEn: 'General' },
      ),
    'GET /suggestion-topics': () => asOwner('GET', '/suggestion-topics'),
    'GET /community/buildings': () => asManager('GET', '/community/buildings'),
    'POST /community/audience/preview': () =>
      asManager('POST', '/community/audience/preview', {
        audience: { occupancy: 'owners' },
      }),
    'GET /community/announcements': async () => {
      await aDraft();
      return asManager('GET', '/community/announcements');
    },
    'POST /community/announcements': () =>
      asManager('POST', '/community/announcements', {
        kind: 'general',
        titleEn: 'No-store',
        bodyEn: 'No-store',
      }),
    'GET /community/announcements/{id}': async () =>
      asManager('GET', `/community/announcements/${await aDraft()}`),
    'PATCH /community/announcements/{id}': async () =>
      asManager('PATCH', `/community/announcements/${await aDraft()}`, {
        bodyEn: 'No-store, again',
      }),
    'POST /community/announcements/{id}/publish': async () =>
      asManager('POST', `/community/announcements/${await aDraft()}/publish`),
    'POST /community/announcements/{id}/archive': async () =>
      asManager(
        'POST',
        `/community/announcements/${await anAnnouncement()}/archive`,
      ),
    'GET /community/announcements/{id}/versions': async () =>
      asManager('GET', `/community/announcements/${await aDraft()}/versions`),
    'GET /community/announcements/{id}/reads': async () =>
      asManager(
        'GET',
        `/community/announcements/${await anAnnouncement()}/reads`,
      ),
    'GET /announcements': async () => {
      await anAnnouncement();
      return asOwner('GET', '/announcements');
    },
    'GET /announcements/{id}': async () =>
      asOwner('GET', `/announcements/${await anAnnouncement()}`),
    'POST /announcements/{id}/read': async () =>
      asOwner('POST', `/announcements/${await anAnnouncement()}/read`),
    'GET /community/events': async () => {
      await anEvent();
      return asManager('GET', '/community/events');
    },
    'POST /community/events': () =>
      asManager('POST', '/community/events', {
        titleEn: 'No-store',
        descriptionEn: 'No-store',
        place: 'No-store',
        startsAt: day(2),
        endsAt: day(3),
      }),
    'GET /community/events/{id}': async () =>
      asManager('GET', `/community/events/${await anEvent()}`),
    'PATCH /community/events/{id}': async () =>
      asManager('PATCH', `/community/events/${await anEvent()}`, {
        capacity: 50,
      }),
    'POST /community/events/{id}/cancel': async () =>
      asManager('POST', `/community/events/${await anEvent()}/cancel`, {
        reasonCode: 'weather',
      }),
    'GET /community/events/{id}/attendees': async () =>
      asManager('GET', `/community/events/${await anEvent()}/attendees`),
    'GET /events': async () => {
      await anEvent();
      return asOwner('GET', '/events');
    },
    'GET /events/{id}': async () =>
      asOwner('GET', `/events/${await anEvent()}`),
    'PUT /events/{id}/rsvp': async () =>
      asOwner('PUT', `/events/${await anEvent()}/rsvp`, {
        response: 'going',
        guests: 1,
      }),
    'GET /community/polls': async () => {
      await aPoll();
      return asManager('GET', '/community/polls');
    },
    'POST /community/polls': () =>
      asManager('POST', '/community/polls', {
        questionEn: 'No-store?',
        options: [{ labelEn: 'Yes' }, { labelEn: 'No' }],
        closesAt: day(3),
      }),
    'GET /community/polls/{id}': async () =>
      asManager('GET', `/community/polls/${await aPoll()}`),
    'GET /community/polls/{id}/audience': async () =>
      asManager('GET', `/community/polls/${await aPoll()}/audience`),
    'PATCH /community/polls/{id}': async () =>
      asManager('PATCH', `/community/polls/${await aPoll()}`, {
        closesAt: day(5),
      }),
    'POST /community/polls/{id}/close': async () =>
      asManager('POST', `/community/polls/${await aPoll()}/close`),
    'POST /community/polls/{id}/cancel': async () =>
      asManager('POST', `/community/polls/${await aPoll()}/cancel`),
    'GET /polls': async () => {
      await aPoll();
      return asOwner('GET', '/polls');
    },
    'GET /polls/{id}': async () => asOwner('GET', `/polls/${await aPoll()}`),
    'POST /polls/{id}/votes': async () => {
      const id = await aPoll();
      const poll = body<{ options: { id: string }[] }>(
        await asOwner('GET', `/polls/${id}`).expect(200),
      );
      return asOwner('POST', `/polls/${id}/votes`, {
        optionIds: [poll.options[0].id],
      });
    },
    'GET /suggestions': async () => {
      await aSuggestion();
      return asOwner('GET', '/suggestions');
    },
    'POST /suggestions': async () =>
      asOwner('POST', '/suggestions', {
        topicId: await suggestionTopic(),
        body: 'No-store',
      }),
    'GET /suggestions/{id}': async () =>
      asOwner('GET', `/suggestions/${await aSuggestion()}`),
    'GET /suggestion-board': async () => {
      await aPublishedSuggestion();
      return asOwner('GET', '/suggestion-board');
    },
    'GET /suggestion-board/done': () =>
      asOwner('GET', '/suggestion-board/done'),
    'PUT /suggestion-board/{id}/support': async () =>
      asOwner(
        'PUT',
        `/suggestion-board/${await aPublishedSuggestion()}/support`,
      ),
    'DELETE /suggestion-board/{id}/support': async () =>
      asOwner(
        'DELETE',
        `/suggestion-board/${await aPublishedSuggestion()}/support`,
      ),
    'GET /community/suggestions': async () => {
      await aSuggestion();
      return asManager('GET', '/community/suggestions');
    },
    'GET /community/suggestions/{id}': async () =>
      asManager('GET', `/community/suggestions/${await aSuggestion()}`),
    'POST /community/suggestions/{id}/status': async () =>
      asManager(
        'POST',
        `/community/suggestions/${await aSuggestion()}/status`,
        {
          status: 'under_review',
        },
      ),
    'PUT /community/suggestions/{id}/response': async () =>
      asManager(
        'PUT',
        `/community/suggestions/${await aSuggestion()}/response`,
        {
          response: 'No-store',
        },
      ),
    'POST /community/suggestions/{id}/publish': async () =>
      asManager(
        'POST',
        `/community/suggestions/${await aSuggestion()}/publish`,
        {
          titleEn: 'No-store',
          textEn: 'No-store',
        },
      ),
    'POST /community/suggestions/{id}/unpublish': async () =>
      asManager(
        'POST',
        `/community/suggestions/${await aPublishedSuggestion()}/unpublish`,
      ),
    'PUT /community/suggestions/{id}/done-note': async () =>
      asManager(
        'PUT',
        `/community/suggestions/${await aDoneSuggestion()}/done-note`,
        { noteEn: 'No-store' },
      ),
    'GET /me/daily-brief': () => asOwner('GET', '/me/daily-brief'),
    // Requests to the management (ADR 0039): every response is no-store.
    'POST /management-requests': async () =>
      call(w, 'POST', '/management-requests', {
        token: w.a.tokens.owner,
        body: { type: 'general', topicId: await topic(), body: 'No-store' },
      }),
    'GET /management-requests': async () => {
      await aRequest();
      return call(w, 'GET', '/management-requests', {
        token: w.a.tokens.owner,
      });
    },
    'GET /management-requests/{id}': async () =>
      call(w, 'GET', `/management-requests/${await aRequest()}`, {
        token: w.a.tokens.owner,
      }),
    'GET /management-requests/{id}/messages': async () =>
      call(w, 'GET', `/management-requests/${await aRequest()}/messages`, {
        token: w.a.tokens.owner,
      }),
    'POST /management-requests/{id}/messages': async () =>
      call(w, 'POST', `/management-requests/${await aRequest()}/messages`, {
        token: w.a.tokens.owner,
        body: { body: 'More' },
      }),
    'POST /management-requests/{id}/withdraw': async () =>
      call(w, 'POST', `/management-requests/${await aRequest()}/withdraw`, {
        token: w.a.tokens.owner,
      }),
    'POST /management-requests/{id}/reopen': async () =>
      call(w, 'POST', `/management-requests/${await aClosedRequest()}/reopen`, {
        token: w.a.tokens.owner,
        body: { body: 'Again' },
      }),
    'POST /management-requests/{id}/rating': async () =>
      call(w, 'POST', `/management-requests/${await aClosedRequest()}/rating`, {
        token: w.a.tokens.owner,
        body: { rating: 5 },
      }),
    'GET /management-appointment-slots': () =>
      call(w, 'GET', '/management-appointment-slots', {
        token: w.a.tokens.owner,
      }),
    'POST /management-requests/{id}/appointment': async () => {
      const id = await anAppointment();
      return call(w, 'POST', `/management-requests/${id}/appointment`, {
        token: w.a.tokens.owner,
        body: { startsAt: await aSlot(), mode: 'phone' },
      });
    },
    'POST /management-requests/{id}/appointment/accept': async () => {
      const id = await anAppointment();
      await call(w, 'POST', `/management/requests/${id}/appointment/propose`, {
        token: w.a.tokens.manager,
        body: { startsAt: await aSlot(), mode: 'phone' },
      }).expect(201);
      return call(w, 'POST', `/management-requests/${id}/appointment/accept`, {
        token: w.a.tokens.owner,
      });
    },
    'POST /management-requests/{id}/appointment/cancel': async () =>
      call(
        w,
        'POST',
        `/management-requests/${await anAppointment()}/appointment/cancel`,
        { token: w.a.tokens.owner, body: { reasonCode: 'cannot_attend' } },
      ),
    'GET /me/requests': async () => {
      await aRequest();
      return call(w, 'GET', '/me/requests', { token: w.a.tokens.owner });
    },
    'GET /management/requests': async () => {
      await aRequest();
      return call(w, 'GET', '/management/requests', {
        token: w.a.tokens.manager,
      });
    },
    'POST /management/requests': async () =>
      call(w, 'POST', '/management/requests', {
        token: w.a.tokens.manager,
        body: {
          type: 'general',
          topicId: await topic(),
          authorAccountId: w.a.ids.owner,
          reasonCode: 'resident_walk_in',
          body: 'No-store',
        },
      }),
    'GET /management/requests/{id}': async () =>
      call(w, 'GET', `/management/requests/${await aRequest()}`, {
        token: w.a.tokens.manager,
      }),
    'POST /management/requests/{id}/assign': async () =>
      call(w, 'POST', `/management/requests/${await aRequest()}/assign`, {
        token: w.a.tokens.manager,
        body: { assigneeId: w.a.ids.manager },
      }),
    'GET /management/requests/{id}/messages': async () =>
      call(w, 'GET', `/management/requests/${await aRequest()}/messages`, {
        token: w.a.tokens.manager,
      }),
    'POST /management/requests/{id}/messages': async () =>
      call(w, 'POST', `/management/requests/${await aRequest()}/messages`, {
        token: w.a.tokens.manager,
        body: { body: 'The answer', official: true },
      }),
    'POST /management/requests/{id}/start': async () =>
      call(w, 'POST', `/management/requests/${await aRequest()}/start`, {
        token: w.a.tokens.manager,
      }),
    'POST /management/requests/{id}/close': async () =>
      call(w, 'POST', `/management/requests/${await aRequest()}/close`, {
        token: w.a.tokens.manager,
        body: { reasonCode: 'duplicate' },
      }),
    'GET /management/request-assignees': () =>
      call(w, 'GET', '/management/request-assignees', {
        token: w.a.tokens.manager,
      }),
    'GET /management/units/{unitId}/request-authors': () =>
      call(w, 'GET', `/management/units/${w.a.homeUnitId}/request-authors`, {
        token: w.a.tokens.manager,
      }),
    'GET /management/appointments': async () => {
      await anAppointment();
      return call(w, 'GET', '/management/appointments', {
        token: w.a.tokens.manager,
      });
    },
    'GET /management/appointment-slots': () =>
      call(w, 'GET', '/management/appointment-slots', {
        token: w.a.tokens.manager,
      }),
    'POST /management/requests/{id}/appointment/confirm': async () =>
      call(
        w,
        'POST',
        `/management/requests/${await anAppointment()}/appointment/confirm`,
        { token: w.a.tokens.manager },
      ),
    'POST /management/requests/{id}/appointment/propose': async () => {
      const id = await anAppointment();
      return call(w, 'POST', `/management/requests/${id}/appointment/propose`, {
        token: w.a.tokens.manager,
        body: { startsAt: await aSlot(), mode: 'in_person' },
      });
    },
    'POST /management/requests/{id}/appointment/cancel': async () =>
      call(
        w,
        'POST',
        `/management/requests/${await anAppointment()}/appointment/cancel`,
        { token: w.a.tokens.manager, body: { reasonCode: 'office_closed' } },
      ),
    'GET /management/request-ratings': async () => {
      const id = await aClosedRequest();
      await call(w, 'POST', `/management-requests/${id}/rating`, {
        token: w.a.tokens.owner,
        body: { rating: 4 },
      }).expect(201);
      return call(w, 'GET', '/management/request-ratings', {
        token: w.a.tokens.manager,
      });
    },
    'GET /management/requests/{id}/rating': async () =>
      call(w, 'GET', `/management/requests/${await aClosedRequest()}/rating`, {
        token: w.a.tokens.manager,
      }),
    'GET /management/request-topics': () =>
      call(w, 'GET', '/management/request-topics', {
        token: w.a.tokens.manager,
      }),
    'POST /management/request-topics': () =>
      call(w, 'POST', '/management/request-topics', {
        token: w.a.tokens.manager,
        body: {
          key: 'no_store_topic',
          nameAr: 'موضوع',
          nameEn: 'Topic',
          targetResponseHours: 24,
        },
      }),
    'PATCH /management/request-topics/{id}': async () => {
      const topic = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.managementRequestTopic.findFirstOrThrow({
          where: { key: 'documents' },
        }),
      );
      return call(w, 'PATCH', `/management/request-topics/${topic.id}`, {
        token: w.a.tokens.manager,
        body: { targetResponseHours: 72 },
      });
    },
    'GET /management-request-topics': () =>
      call(w, 'GET', '/management-request-topics', {
        token: w.a.tokens.owner,
      }),
    'GET /management/request-settings': () =>
      call(w, 'GET', '/management/request-settings', {
        token: w.a.tokens.manager,
      }),
    'PATCH /management/request-settings': () =>
      call(w, 'PATCH', '/management/request-settings', {
        token: w.a.tokens.manager,
        body: { autoCloseDays: 7 },
      }),
    'GET /management-office-hours': () =>
      call(w, 'GET', '/management-office-hours', {
        token: w.a.tokens.owner,
      }),
    'GET /management/office-hours': () =>
      call(w, 'GET', '/management/office-hours', {
        token: w.a.tokens.manager,
      }),
    'PUT /management/office-hours': () =>
      call(w, 'PUT', '/management/office-hours', {
        token: w.a.tokens.manager,
        body: {
          windows: [0, 1, 2, 3, 4, 6].map((weekday) => ({
            weekday,
            startMinute: 540,
            endMinute: 1020,
          })),
        },
      }),
    // Not a secret, but live: a cached answer would show a closed gate open.
    'GET /gates/status': () =>
      call(w, 'GET', '/gates/status', { token: w.a.tokens.owner }),
    // A resident's parcels carry the label, the photos and the codes (ADR 0035).
    'GET /me/parcels': async () => {
      await aParcel();
      return call(w, 'GET', '/me/parcels', { token: w.a.tokens.owner });
    },
    'GET /me/parcels/{id}': async () =>
      call(w, 'GET', `/me/parcels/${await aParcel()}`, {
        token: w.a.tokens.owner,
      }),
    'POST /me/parcels/{id}/reject': async () =>
      call(w, 'POST', `/me/parcels/${await aParcel()}/reject`, {
        token: w.a.tokens.owner,
        body: { reasonCode: 'other' },
      }),
    'POST /me/parcels/{id}/delegate': async () =>
      call(w, 'POST', `/me/parcels/${await aParcel()}/delegate`, {
        token: w.a.tokens.owner,
        body: { name: 'Karim' },
      }),
    'POST /auth/otp/verify': async () => (await login()).verify,
    'POST /auth/select-account': async () => (await login()).select,
    'POST /auth/refresh': async () => (await login()).refresh,
    'POST /platform/auth/login': () => platform(false),
    'POST /platform/auth/change-password': async () => {
      const restricted = body<{ accessToken: string }>(
        await platform(true),
      ).accessToken;
      return call(w, 'POST', '/platform/auth/change-password', {
        token: restricted,
        body: {
          currentPassword: 'no-store-password-1',
          newPassword: 'no-store-password-2',
        },
      });
    },
    'POST /platform/auth/refresh': async () =>
      call(w, 'POST', '/platform/auth/refresh', {
        body: {
          refreshToken: body<{ refreshToken: string }>(await platform(false))
            .refreshToken,
        },
      }),
    'POST /registration-links': () =>
      call(w, 'POST', '/registration-links', { token: w.a.tokens.manager }),
    'POST /units/{unitId}/household/invites': () =>
      call(w, 'POST', `/units/${w.a.homeUnitId}/household/invites`, {
        token: w.a.tokens.owner,
        body: inviteBody(),
      }),
    'POST /household/members/{id}/majority-invite': async () => {
      const minor = await call(
        w,
        'POST',
        `/units/${w.a.homeUnitId}/household/minors`,
        {
          token: w.a.tokens.owner,
          body: minorBody(),
        },
      ).expect(201);
      const id = body<{ id: string }>(minor).id;
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.householdMember.update({
          where: { id },
          data: { birthDate: bornYearsAgo(18, 1) },
        }),
      );
      return call(w, 'POST', `/household/members/${id}/majority-invite`, {
        token: w.a.tokens.owner,
        body: { email: uniqueEmail('adult'), phone: uniquePhone() },
      });
    },
    'POST /worker-engagements/{id}/review': async () =>
      (await activeEngagement()).review,
    'POST /worker-engagements/{id}/resume': async () => {
      const { id } = await activeEngagement();
      await call(w, 'POST', `/worker-engagements/${id}/suspend`, {
        token: w.a.tokens.owner,
        body: { reasonCode: 'leave', reason: 'Away' },
      }).expect(204);
      return call(w, 'POST', `/worker-engagements/${id}/resume`, {
        token: w.a.tokens.owner,
      });
    },
    'POST /worker-engagements/{id}/reissue-code': async () => {
      const { id } = await activeEngagement();
      return call(w, 'POST', `/worker-engagements/${id}/reissue-code`, {
        token: w.a.tokens.owner,
        body: { reasonCode: 'lost' },
      });
    },
    'POST /worker-engagements/{id}/card-incident': async () => {
      const { id } = await activeEngagement();
      return call(w, 'POST', `/worker-engagements/${id}/card-incident`, {
        token: w.a.tokens.manager,
        body: { type: 'confiscated' },
      });
    },
    'POST /units/{unitId}/visitor-passes': () =>
      call(w, 'POST', `/units/${w.a.homeUnitId}/visitor-passes`, {
        token: w.a.tokens.owner,
        body: passBody(),
      }),
    'POST /public/visitor-passes/lookup': async () =>
      call(w, 'POST', '/public/visitor-passes/lookup', {
        body: { token: await linkToken() },
      }),
    'POST /public/visitor-passes/not-me': async () =>
      call(w, 'POST', '/public/visitor-passes/not-me', {
        body: { token: await linkToken() },
      }),
    'GET /visitor-passes/{id}': async () => {
      const pass = await call(
        w,
        'POST',
        `/units/${w.a.homeUnitId}/visitor-passes`,
        { token: w.a.tokens.owner, body: passBody() },
      ).expect(201);
      return call(
        w,
        'GET',
        `/visitor-passes/${body<{ id: string }>(pass).id}`,
        {
          token: w.a.tokens.owner,
        },
      );
    },
    // The gate's requests carry a presigned photo URL (ADR 0043).
    'POST /gate/approval-requests': async () => {
      const unit = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: w.a.homeUnitId },
        }),
      );
      return call(w, 'POST', '/gate/approval-requests', {
        token: w.a.tokens.guard,
        body: { kind: 'uninvited_visitor', unitCode: unit.code },
      });
    },
    'GET /gate/approval-requests/{id}': async () =>
      call(w, 'GET', `/gate/approval-requests/${await askHome()}`, {
        token: w.a.tokens.guard,
      }),
    'POST /gate/approval-requests/{id}/withdraw': async () =>
      call(w, 'POST', `/gate/approval-requests/${await askHome()}/withdraw`, {
        token: w.a.tokens.guard,
      }),
    'POST /gate/approval-requests/{id}/apply-instruction': async () => {
      const made = await call(
        w,
        'POST',
        `/units/${w.a.homeUnitId}/standing-instructions`,
        {
          token: w.a.tokens.owner,
          body: { description: 'No-store test', action: 'never_allow' },
        },
      ).expect(201);
      return call(
        w,
        'POST',
        `/gate/approval-requests/${await askHome()}/apply-instruction`,
        {
          token: w.a.tokens.guard,
          body: { instructionId: body<{ id: string }>(made).id },
        },
      );
    },
    'GET /me/gate-requests': async () => {
      await askHome();
      return call(w, 'GET', '/me/gate-requests', { token: w.a.tokens.owner });
    },
    'POST /visitor-passes/{id}/reissue-link': async () => {
      const pass = await call(
        w,
        'POST',
        `/units/${w.a.homeUnitId}/visitor-passes`,
        { token: w.a.tokens.owner, body: passBody() },
      ).expect(201);
      return call(
        w,
        'POST',
        `/visitor-passes/${body<{ id: string }>(pass).id}/reissue-link`,
        { token: w.a.tokens.owner },
      );
    },
    'GET /worker-engagements/{id}': () =>
      call(w, 'GET', `/worker-engagements/${w.bEngagementId}`, {
        token: w.b.tokens.manager,
      }),
    'POST /gate/verify': () =>
      call(w, 'POST', '/gate/verify', {
        token: w.a.tokens.guard,
        body: { code: '00000000' },
      }),
    // A parcel's lookup names a delegate; its hand-over answers with the name too
    // (ADR 0035).
    'POST /gate/parcels/lookup': () =>
      call(w, 'POST', '/gate/parcels/lookup', {
        token: w.a.tokens.guard,
        body: { code: '000000' },
      }),
    'POST /gate/parcels/{id}/handover': async () => {
      const id = await aParcel();
      const holder = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.parcelCredential.findFirstOrThrow({
          where: { parcelId: id, kind: 'holder' },
        }),
      );
      const { code } = h.moduleRef
        .get(ParcelTokens)
        .secretOf(w.a.tenantId, holder.id, holder.attempt);
      return call(w, 'POST', `/gate/parcels/${id}/handover`, {
        token: w.a.tokens.guard,
        body: { code },
      });
    },
    // Presigned URLs (ADR 0029): an upload target, a read URL.
    'POST /files/uploads': () =>
      call(w, 'POST', '/files/uploads', {
        token: w.a.tokens.owner,
        body: { purpose: 'worker_photo', contentType: 'image/png', size: 10 },
      }),
    // The entry credential's secret, once (ADR 0031).
    'POST /me/entry-credentials': () =>
      call(w, 'POST', '/me/entry-credentials', {
        token: w.a.tokens.tenant,
        body: {},
      }),
    'GET /me': async () => call(w, 'GET', '/me', { token: w.a.tokens.owner }),
    // A ticket's detail carries its photos' presigned URLs (ADR 0032).
    'GET /tickets/{id}': async () =>
      call(w, 'GET', `/tickets/${await aTicket()}`, {
        token: w.a.tokens.owner,
      }),
    'GET /technician/tickets/{id}': async () => {
      const id = await aTicket();
      await call(w, 'POST', `/maintenance/tickets/${id}/assign`, {
        token: w.a.tokens.manager,
        body: { technicianId: w.a.ids.technician },
      }).expect(204);
      return call(w, 'GET', `/technician/tickets/${id}`, {
        token: w.a.tokens.technician,
      });
    },
    'GET /maintenance/tickets/{id}': async () =>
      call(w, 'GET', `/maintenance/tickets/${await aTicket()}`, {
        token: w.a.tokens.manager,
      }),
    // ADR 0038.
    'GET /preventive-slots': async () =>
      await call(w, 'GET', '/preventive-slots', {
        token: w.a.tokens.owner,
        query: { unitId: w.a.homeUnitId, days: '1' },
      }),
    'GET /tickets/{id}/visit-slots': async () =>
      call(w, 'GET', `/tickets/${(await aVisit()).ticketId}/visit-slots`, {
        token: w.a.tokens.owner,
        query: { days: '1' },
      }),
    'GET /tickets/{id}/visits': async () =>
      call(w, 'GET', `/tickets/${(await aVisit()).ticketId}/visits`, {
        token: w.a.tokens.owner,
      }),
    'GET /technician/tickets/{id}/visits': async () =>
      call(
        w,
        'GET',
        `/technician/tickets/${(await aVisit()).ticketId}/visits`,
        { token: w.a.tokens.technician },
      ),
    'POST /technician/tickets/{id}/visits/{visitId}/arrive': async () => {
      const { ticketId, visitId } = await aVisit(true);
      return call(
        w,
        'POST',
        `/technician/tickets/${ticketId}/visits/${visitId}/arrive`,
        { token: w.a.tokens.technician },
      );
    },
    'GET /maintenance/tickets/{id}/visits': async () =>
      call(
        w,
        'GET',
        `/maintenance/tickets/${(await aVisit()).ticketId}/visits`,
        { token: w.a.tokens.manager },
      ),
    'GET /me/units/{unitId}/visits': async () => {
      await aVisit();
      return call(w, 'GET', `/me/units/${w.a.homeUnitId}/visits`, {
        token: w.a.tokens.owner,
      });
    },
    'GET /files/{id}': async () =>
      call(w, 'GET', `/files/${await fileHelpers(h).ready(w.a.tokens.owner)}`, {
        token: w.a.tokens.owner,
      }), // A parcel's photos, as short-lived URLs (ADR 0035).
    'GET /gate/parcels/{id}': async () =>
      call(w, 'GET', `/gate/parcels/${await aParcel()}`, {
        token: w.a.tokens.guard,
      }),
    // Personal-data export (ADR 0036): the archive's presigned URL.
    'GET /me/data-exports/{id}/download': async () => {
      const id = newId();
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.dataExport.create({
          data: {
            id,
            tenantId: w.a.tenantId,
            accountId: w.a.ids.owner,
            requestedByAccountId: w.a.ids.owner,
            delivery: 'in_app',
          },
        }),
      );
      await buildExports(h);
      return call(w, 'GET', `/me/data-exports/${id}/download`, {
        token: w.a.tokens.owner,
      });
    },
    'POST /public/data-exports/code': async () =>
      call(w, 'POST', '/public/data-exports/code', {
        body: { token: (await assistedLink()).token },
      }),
    'POST /public/data-exports/download': async () => {
      const { token, email } = await assistedLink();
      const since = new Date();
      await call(w, 'POST', '/public/data-exports/code', {
        body: { token },
      }).expect(202);
      return call(w, 'POST', '/public/data-exports/download', {
        body: { token, code: await waitForOtp(email, since) },
      });
    },
    // Neighbours (ADR 0042): every response is no-store.
    'GET /neighbours/settings': () =>
      as('manager', 'GET', '/neighbours/settings'),
    'PATCH /neighbours/settings': () =>
      as('manager', 'PATCH', '/neighbours/settings', { maxOpenComplaints: 50 }),
    'GET /neighbours/complaint-categories': () =>
      as('manager', 'GET', '/neighbours/complaint-categories'),
    'POST /neighbours/complaint-categories': () =>
      as('manager', 'POST', '/neighbours/complaint-categories', {
        key: `nostore_${uniqueSuffix().toLowerCase()}`.slice(0, 40),
        nameAr: 'بلا تخزين',
        nameEn: 'No-store',
      }),
    'PATCH /neighbours/complaint-categories/{id}': async () =>
      as(
        'manager',
        'PATCH',
        `/neighbours/complaint-categories/${await complaintCategory()}`,
        { nameEn: 'Noise' },
      ),
    'GET /neighbour-complaint-categories': () =>
      as('owner', 'GET', '/neighbour-complaint-categories'),
    'GET /neighbours/welcome-template': () =>
      as('manager', 'GET', '/neighbours/welcome-template'),
    'PUT /neighbours/welcome-template': () =>
      as('manager', 'PUT', '/neighbours/welcome-template', { enabled: true }),
    'GET /neighbour-welcome': () => as('family', 'GET', '/neighbour-welcome'),
    'POST /neighbour-complaints': async () => {
      await raised();
      return as(
        'owner',
        'POST',
        '/neighbour-complaints',
        await complaintBody(),
      );
    },
    'GET /neighbour-complaints': async () => {
      await aComplaint();
      return as('owner', 'GET', '/neighbour-complaints');
    },
    'GET /neighbour-complaints/{id}': async () =>
      as('owner', 'GET', `/neighbour-complaints/${await aComplaint()}`),
    'GET /neighbour-complaints/{id}/messages': async () =>
      as(
        'owner',
        'GET',
        `/neighbour-complaints/${await aComplaint()}/messages`,
      ),
    'POST /neighbour-complaints/{id}/messages': async () =>
      as(
        'owner',
        'POST',
        `/neighbour-complaints/${await aComplaint()}/messages`,
        {
          body: 'No-store',
        },
      ),
    'POST /neighbour-complaints/{id}/withdraw': async () =>
      as(
        'owner',
        'POST',
        `/neighbour-complaints/${await aComplaint()}/withdraw`,
      ),
    'GET /neighbour-notices': async () => {
      await aNotice();
      return as('tenant', 'GET', '/neighbour-notices');
    },
    'GET /neighbour-notices/{id}': async () =>
      as('tenant', 'GET', `/neighbour-notices/${(await aNotice()).noticeId}`),
    'GET /neighbour-notices/{id}/messages': async () =>
      as(
        'tenant',
        'GET',
        `/neighbour-notices/${(await aNotice()).noticeId}/messages`,
      ),
    'POST /neighbour-notices/{id}/messages': async () =>
      as(
        'tenant',
        'POST',
        `/neighbour-notices/${(await aNotice()).noticeId}/messages`,
        { body: 'No-store' },
      ),
    'GET /neighbours/complaints': async () => {
      await aComplaint();
      return as('manager', 'GET', '/neighbours/complaints');
    },
    'GET /neighbours/complaints/{id}': async () =>
      as('manager', 'GET', `/neighbours/complaints/${await aComplaint()}`),
    'GET /neighbours/complaints/{id}/messages': async () =>
      as(
        'manager',
        'GET',
        `/neighbours/complaints/${await aComplaint()}/messages`,
      ),
    'POST /neighbours/complaints/{id}/messages': async () =>
      as(
        'manager',
        'POST',
        `/neighbours/complaints/${await aComplaint()}/messages`,
        {
          body: 'No-store',
        },
      ),
    'GET /neighbours/complaints/{id}/unit-messages': async () =>
      as(
        'manager',
        'GET',
        `/neighbours/complaints/${(await aNotice()).complaintId}/unit-messages`,
      ),
    'POST /neighbours/complaints/{id}/unit-messages': async () =>
      as(
        'manager',
        'POST',
        `/neighbours/complaints/${(await aNotice()).complaintId}/unit-messages`,
        { body: 'No-store' },
      ),
    'GET /neighbours/complaints/{id}/notes': async () =>
      as(
        'manager',
        'GET',
        `/neighbours/complaints/${await aComplaint()}/notes`,
      ),
    'POST /neighbours/complaints/{id}/notes': async () =>
      as(
        'manager',
        'POST',
        `/neighbours/complaints/${await aComplaint()}/notes`,
        {
          body: 'No-store',
        },
      ),
    'POST /neighbours/complaints/{id}/notice': async () =>
      as(
        'manager',
        'POST',
        `/neighbours/complaints/${await aReviewedComplaint()}/notice`,
        { body: 'No-store' },
      ),
    'POST /neighbours/complaints/{id}/review': async () =>
      as(
        'manager',
        'POST',
        `/neighbours/complaints/${await aComplaint()}/review`,
      ),
    'POST /neighbours/complaints/{id}/mediation': async () =>
      as(
        'manager',
        'POST',
        `/neighbours/complaints/${await aReviewedComplaint()}/mediation`,
      ),
    'POST /neighbours/complaints/{id}/resolve': async () =>
      as(
        'manager',
        'POST',
        `/neighbours/complaints/${await aReviewedComplaint()}/resolve`,
        { reasonCode: 'complied' },
      ),
    'POST /neighbours/complaints/{id}/dismiss': async () =>
      as(
        'manager',
        'POST',
        `/neighbours/complaints/${await aComplaint()}/dismiss`,
        {
          reasonCode: 'unfounded',
        },
      ),
    'GET /neighbours/units/{unitId}/complaint-history': () =>
      as(
        'manager',
        'GET',
        `/neighbours/units/${w.a.rentedUnitId}/complaint-history`,
      ),
    'POST /neighbour-posts': async () => {
      await raised();
      return as('owner', 'POST', '/neighbour-posts', {
        kind: 'lost',
        body: 'No-store',
      });
    },
    'GET /neighbour-posts': async () => {
      await aPost();
      return as('tenant', 'GET', '/neighbour-posts');
    },
    'GET /neighbour-posts/{id}': async () =>
      as('tenant', 'GET', `/neighbour-posts/${await aPost()}`),
    'POST /neighbour-posts/{id}/close': async () =>
      as('owner', 'POST', `/neighbour-posts/${await aPost()}/close`, {
        reasonCode: 'resolved',
      }),
    'POST /neighbour-posts/{id}/claims': async () =>
      as('tenant', 'POST', `/neighbour-posts/${await aPost()}/claims`, {}),
    'GET /neighbour-claims': async () => {
      await aClaim();
      return as('tenant', 'GET', '/neighbour-claims');
    },
    'POST /neighbour-claims/{id}/withdraw': async () =>
      as(
        'tenant',
        'POST',
        `/neighbour-claims/${(await aClaim()).claimId}/withdraw`,
      ),
    'GET /neighbours/posts': async () => {
      await aPost();
      return as('manager', 'GET', '/neighbours/posts');
    },
    'POST /neighbours/posts': () =>
      as('manager', 'POST', '/neighbours/posts', {
        kind: 'found',
        body: 'No-store',
      }),
    'GET /neighbours/posts/{id}': async () =>
      as('manager', 'GET', `/neighbours/posts/${await aPost()}`),
    'POST /neighbours/posts/{id}/remove': async () =>
      as('manager', 'POST', `/neighbours/posts/${await aPost()}/remove`, {
        reasonCode: 'duplicate',
      }),
    'GET /neighbours/posts/{id}/claims': async () =>
      as(
        'manager',
        'GET',
        `/neighbours/posts/${(await aClaim()).postId}/claims`,
      ),
    'POST /neighbours/posts/{id}/handover': async () => {
      const { postId, claimId } = await aClaim();
      return as('manager', 'POST', `/neighbours/posts/${postId}/handover`, {
        claimId,
      });
    },
    'POST /neighbours/claims/{id}/decline': async () =>
      as(
        'manager',
        'POST',
        `/neighbours/claims/${(await aClaim()).claimId}/decline`,
        { reasonCode: 'not_the_owner' },
      ),
    'POST /neighbour-posts/{id}/conversations': async () =>
      as(
        'tenant',
        'POST',
        `/neighbour-posts/${await aPost('lend')}/conversations`,
        {
          body: 'No-store',
        },
      ),
    'GET /neighbour-conversations': async () => {
      await aConversation();
      return as('tenant', 'GET', '/neighbour-conversations');
    },
    'GET /neighbour-conversations/{id}': async () =>
      as('tenant', 'GET', `/neighbour-conversations/${await aConversation()}`),
    'GET /neighbour-conversations/{id}/messages': async () =>
      as(
        'owner',
        'GET',
        `/neighbour-conversations/${await aConversation()}/messages`,
      ),
    'POST /neighbour-conversations/{id}/messages': async () =>
      as(
        'owner',
        'POST',
        `/neighbour-conversations/${await aConversation()}/messages`,
        { body: 'No-store' },
      ),
    'POST /neighbour-conversations/{id}/reveal': async () =>
      as(
        'tenant',
        'POST',
        `/neighbour-conversations/${await aConversation()}/reveal`,
      ),
    'DELETE /neighbour-conversations/{id}/reveal': async () => {
      const id = await aConversation();
      await as(
        'tenant',
        'POST',
        `/neighbour-conversations/${id}/reveal`,
      ).expect(200);
      return as('tenant', 'DELETE', `/neighbour-conversations/${id}/reveal`);
    },
    'POST /neighbour-conversations/{id}/block': async () =>
      as(
        'landlord',
        'POST',
        `/neighbour-conversations/${await aPairConversation()}/block`,
      ),
    'POST /neighbour-conversations/{id}/report': async () =>
      as(
        'tenant',
        'POST',
        `/neighbour-conversations/${await aConversation()}/report`,
        {
          reasonCode: 'spam',
        },
      ),
    'GET /neighbour-blocks': () => as('landlord', 'GET', '/neighbour-blocks'),
    'DELETE /neighbour-blocks/{id}': async () => {
      const id = await aPairConversation();
      await as(
        'landlord',
        'POST',
        `/neighbour-conversations/${id}/block`,
      ).expect(204);
      const mine = await as('landlord', 'GET', '/neighbour-blocks').expect(200);
      return as(
        'landlord',
        'DELETE',
        `/neighbour-blocks/${body<{ data: { id: string }[] }>(mine).data[0].id}`,
      );
    },
    'GET /neighbours/reports': async () => {
      await aReport();
      return as('manager', 'GET', '/neighbours/reports');
    },
    'GET /neighbours/reports/{id}': async () =>
      as('manager', 'GET', `/neighbours/reports/${await aReport()}`),
    'GET /neighbours/reports/{id}/messages': async () =>
      as('manager', 'GET', `/neighbours/reports/${await aReport()}/messages`),
    'POST /neighbours/reports/{id}/close': async () =>
      as('manager', 'POST', `/neighbours/reports/${await aReport()}/close`, {
        reasonCode: 'no_action',
      }),
    ...FACILITY_CALLS(),
    ...VEHICLE_CALLS(),
    ...FINANCE_CALLS(),
    ...SAFETY_CALLS(),
    ...PERMIT_CALLS(),
    ...guardDutyCalls(() => w),
    ...GOVERNANCE_CALLS(),
    ...patrolCalls(() => w),
    ...securityOpsCalls(() => w),
    ...childrenCalls(() => w),
    ...boardMatterCalls(() => w, aSittingBoard),
    ...budgetCalls(() => w, aSittingBoard),
    ...appealCalls(() => w, aSittingBoard),
    ...gateCompletionCalls(() => w),
    ...offlineCalls(() => w),
    ...residentItemCalls(() => w),
    ...partnerCalls(() => w),
    ...registrationCalls(() => w),
    ...kinshipCalls(() => w),
    ...unitDocumentCalls(() => w),
    ...decisionAppealCalls(() => w),
    ...representativeCalls(() => w, aSittingBoard),
    ...governanceVoiceCalls(() => w, aSittingBoard, aPublication),
  };

  const secretRows = ROUTES.filter((r) => r.noStore).map(
    (r) => `${r.method} ${r.path}`,
  );

  it('has a real call for every no-store row', () => {
    expect(Object.keys(CALLS).sort()).toEqual([...secretRows].sort());
  });

  it.each(secretRows)('%s answers no-store', async (key) => {
    const res = await CALLS[key]();
    expect({
      key,
      status: res.status < 300,
      cache: res.headers['cache-control'],
    }).toEqual({
      key,
      status: true,
      cache: 'no-store',
    });
  });

  it('a response without a secret is not marked', async () => {
    const res = await call(w, 'GET', '/me/units', {
      token: w.a.tokens.owner,
    }).expect(200);
    expect(res.headers['cache-control']).toBeUndefined();
  });
});
