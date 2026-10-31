import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { ClubMembershipRequest } from '@prisma/client';
import { CommunityFacilitiesPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { Charges, type PaidCharge } from '../../core/charges/charges';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { FacilitiesAccess } from '../access';
import { dbNow } from '../db-clock';
import { BookingNotices } from '../notices/booking-notices';
import { nextStart, periodEnd } from './club-periods';
import { ClubService, periodsOf } from './club.service';

export const CLUB_REQUEST_RESOURCE = 'club_membership_request';
/** A request's invoice falls due a week after it is asked for. */
const DUE_DAYS = 7;
const asDate = (d: LocalDate) => new Date(`${d}T00:00:00.000Z`);

/** A request with its charge's state (ADR 0070). */
export type ClubRequestRead = ClubMembershipRequest & {
  charge: { invoiceId: string; status: 'open' | 'paid' | 'cancelled' } | null;
};

const requestNotFound = () =>
  appError.notFound(
    ErrorCode.CLUB_REQUEST_NOT_FOUND,
    'Club membership request not found',
  );

const PAGE = keysetCursor('createdAt', 'desc');

/**
 * Club membership requests (ADR 0070): a resident who books for a unit asks
 * for one of the club's active plans, and its price is owed through a
 * `club` invoice the charges port raises at once (due in a week). One
 * request open per unit. Once its invoice is paid — online, at the office,
 * or by the unit's credit — the paid handler starts the membership or
 * extends it from where its last paid period ends (from today when it has
 * lapsed): a payment record of the plan that points at the charge, by
 * nobody, in the paying transaction. A unit with no membership gets one,
 * covering its people now. The requester or the unit's primary may call a
 * request off until it is paid: the charge is credited off.
 *
 * Locks, by the charges' rule: the caller's account, the unit's finance
 * lock, the request's row, the membership's row — as the paying
 * transaction takes the finance lock, then the request and the membership.
 */
@Injectable()
export class ClubRequestsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly community: CommunityFacilitiesPort,
    private readonly access: FacilitiesAccess,
    private readonly charges: Charges,
    private readonly club: ClubService,
    private readonly notices: BookingNotices,
  ) {}

  onModuleInit(): void {
    this.charges.registerPaidHandler('club_request', (tx, c) =>
      this.paid(tx, c),
    );
    this.idempotency.renderer(CLUB_REQUEST_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(
        async (tx) =>
          (
            await this.withCharges(tx, [
              await tx.clubMembershipRequest.findUniqueOrThrow({
                where: { id },
              }),
            ])
          )[0],
      ),
    );
  }

  /**
   * Asks for an active plan for the unit: whoever books for it. Its price is
   * owed at once; a second request while one is open is refused.
   */
  request(unitId: string, planId: string): Promise<ClubRequestRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CLUB_REQUEST_RESOURCE, id });
      await this.access.lockSelf(tx);
      const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
      if (!caps)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      if (!caps.bookings)
        throw appError.forbidden(
          ErrorCode.BOOKINGS_NOT_ALLOWED,
          'This person may not book for this unit',
        );
      await this.charges.lockUnit(tx, unitId);
      const open = await tx.clubMembershipRequest.findFirst({
        where: { unitId, status: 'requested' },
        select: { id: true },
      });
      if (open)
        throw appError.conflict(
          ErrorCode.CLUB_REQUEST_OPEN,
          'The unit has a request waiting for payment',
          { params: { requestId: open.id } },
        );
      const plan = await tx.clubPlan.findUnique({ where: { id: planId } });
      if (!plan?.active)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid request',
          {
            fields: [
              { field: 'planId', code: FieldErrorCode.PLAN_NOT_AVAILABLE },
            ],
          },
        );
      const created = await tx.clubMembershipRequest.create({
        data: {
          id,
          tenantId: plan.tenantId,
          unitId,
          planId,
          requestedById: this.ctx.accountId,
          amount: plan.price,
        },
      });
      const charge = await this.charges.raise(tx, {
        unitId,
        source: 'club_request',
        sourceId: id,
        kind: 'club',
        amount: plan.price,
        textEn: `Club membership: ${plan.nameEn}`,
        textAr: `اشتراك النادي: ${plan.nameAr}`,
        dueOn: addDays(await this.club.today(tx), DUE_DAYS),
      });
      await this.audit.record(tx, {
        action: 'club_membership_request.created',
        targetId: id,
        metadata: {
          unitId,
          planId,
          amount: created.amount.toFixed(2),
          chargeId: charge.id,
          invoiceId: charge.invoiceId,
        },
      });
      // The unit's credit may have paid it as it was raised.
      return (
        await this.withCharges(tx, [
          await tx.clubMembershipRequest.findUniqueOrThrow({ where: { id } }),
        ])
      )[0];
    });
  }

  /** Called off by the requester or the unit's primary, until it is paid. */
  cancel(id: string, reasonCode: string | undefined): Promise<ClubRequestRead> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.clubRequestCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await this.visible(tx, id);
      await this.charges.lockUnit(tx, seen.unitId);
      const request = await this.lockRow(tx, id);
      if (request.status !== 'requested')
        throw appError.conflict(
          ErrorCode.CLUB_REQUEST_CLOSED,
          'The request was paid or called off already',
          { params: { status: request.status } },
        );
      const cancelled = await tx.clubMembershipRequest.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: await dbNow(tx),
          cancelledById: this.ctx.accountId,
          cancelReason: reason,
        },
      });
      const charge = await this.charges.cancel(
        tx,
        'club_request',
        id,
        'request_cancelled',
      );
      await this.audit.record(tx, {
        action: 'club_membership_request.cancelled',
        targetId: id,
        metadata: {
          unitId: request.unitId,
          reasonCode: reason,
          chargeStatus: charge?.status ?? null,
        },
      });
      return (await this.withCharges(tx, [cancelled]))[0];
    });
  }

  /** The unit's requests the caller sees: all of them for its primary, else their own. */
  forUnit(
    unitId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<ClubRequestRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
      if (!caps?.unitView)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const primary = await this.community.isPrimary(
        tx,
        this.ctx.accountId,
        unitId,
      );
      const limit = clampLimit(q.limit);
      const rows = await tx.clubMembershipRequest.findMany({
        where: {
          AND: [
            {
              unitId,
              ...(primary ? {} : { requestedById: this.ctx.accountId }),
            },
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return { ...page, items: await this.withCharges(tx, page.items) };
    });
  }

  /** Every request the caller made, oldest first: their personal-data export. */
  everyOwn(): Promise<ClubRequestRead[]> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.withCharges(
        tx,
        await tx.clubMembershipRequest.findMany({
          where: { requestedById: this.ctx.accountId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      ),
    );
  }

  /** Every request of the compound, newest first: the club's staff. */
  list(q: {
    status?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ClubRequestRead & { unitCode: string }>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.clubMembershipRequest.findMany({
        where: {
          AND: [
            ...(q.status ? [{ status: q.status }] : []),
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const codes = await this.community.unitCodes(
        tx,
        page.items.map((r) => r.unitId),
      );
      return {
        ...page,
        items: (await this.withCharges(tx, page.items)).map((r) => ({
          ...r,
          unitCode: codes.get(r.unitId) ?? '',
        })),
      };
    });
  }

  // --------------------------------------------------------------------------
  // Paid (ADR 0070)
  // --------------------------------------------------------------------------

  /**
   * The request's invoice was paid, in the paying transaction under the
   * unit's finance lock: the membership starts or is extended by a period
   * of the plan from today, or from where its last paid period ends. A
   * request called off meanwhile is left alone (its charge was cancelled
   * first, so it is never paid). Never throws for the request's state.
   */
  private async paid(tx: TenantTxClient, c: PaidCharge): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM club_membership_requests WHERE id = ${c.sourceId}::uuid FOR UPDATE`;
    if (!rows.length) return;
    const request = await tx.clubMembershipRequest.findUniqueOrThrow({
      where: { id: c.sourceId },
    });
    if (request.status !== 'requested') return;
    const { membershipId, created } = await this.membershipOf(tx, request);
    const membership = await this.club.lockMembership(
      tx,
      membershipId,
      'update',
    );
    const plan = await tx.clubPlan.findUniqueOrThrow({
      where: { id: request.planId },
    });
    const today = await this.club.today(tx);
    const start = nextStart(
      periodsOf(await this.club.recordsOf(tx, membership.id)),
      today,
    );
    const end = periodEnd(start, plan);
    const payment = await tx.clubPaymentRecord.create({
      data: {
        id: newId(),
        tenantId: membership.tenantId,
        membershipId: membership.id,
        kind: 'payment',
        planId: plan.id,
        amount: request.amount,
        currency: 'EGP',
        receiptNumber: null,
        paidOn: asDate(today),
        periodStartsOn: asDate(start),
        periodEndsOn: asDate(end),
        recordedById: null,
        chargeId: c.chargeId,
      },
    });
    await tx.clubMembershipRequest.update({
      where: { id: request.id },
      data: { status: 'paid', paidAt: c.paidAt, paymentRecordId: payment.id },
    });
    await this.audit.record(tx, {
      action: 'club_membership_request.paid',
      targetId: request.id,
      metadata: {
        unitId: request.unitId,
        planId: plan.id,
        membershipId: membership.id,
        paymentId: payment.id,
        periodStartsOn: start,
        periodEndsOn: end,
        membershipCreated: created,
      },
    });
    await this.notices.send(
      tx,
      [request.requestedById],
      'club_membership_request.paid',
      request.id,
    );
  }

  /**
   * The unit's membership, or a new one covering the unit's people now,
   * started by the request's requester. Created once per unit (its unique
   * key): a staff member creating one meanwhile is found instead.
   */
  private async membershipOf(
    tx: TenantTxClient,
    request: ClubMembershipRequest,
  ): Promise<{ membershipId: string; created: boolean }> {
    const id = newId();
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO club_memberships (id, tenant_id, unit_id, created_by_account_id)
      VALUES (${id}::uuid, ${request.tenantId}::uuid, ${request.unitId}::uuid, ${request.requestedById}::uuid)
      ON CONFLICT DO NOTHING RETURNING id`;
    if (!inserted.length) {
      const existing = await tx.clubMembership.findFirstOrThrow({
        where: { unitId: request.unitId },
        select: { id: true },
      });
      return { membershipId: existing.id, created: false };
    }
    const people = await this.community.clubPeople(tx, request.unitId);
    for (const p of people)
      await tx.clubMembershipPerson.create({
        data: {
          id: newId(),
          tenantId: request.tenantId,
          membershipId: id,
          occupancyId: p.kind === 'occupancy' ? p.id : null,
          householdMemberId: p.kind === 'member' ? p.id : null,
          addedById: request.requestedById,
        },
      });
    await this.audit.record(tx, {
      action: 'club_membership.created',
      targetId: id,
      metadata: { unitId: request.unitId, people: people.length },
    });
    return { membershipId: id, created: true };
  }

  // --------------------------------------------------------------------------
  // Who sees what
  // --------------------------------------------------------------------------

  /** The request, if the caller asked for it or is the unit's primary. */
  private async visible(
    tx: TenantTxClient,
    id: string,
  ): Promise<ClubMembershipRequest> {
    const request = await tx.clubMembershipRequest.findUnique({
      where: { id },
    });
    if (!request) throw requestNotFound();
    if (request.requestedById === this.ctx.accountId) return request;
    if (await this.community.isPrimary(tx, this.ctx.accountId, request.unitId))
      return request;
    throw requestNotFound();
  }

  private async lockRow(
    tx: TenantTxClient,
    id: string,
  ): Promise<ClubMembershipRequest> {
    await tx.$queryRaw`
      SELECT id FROM club_membership_requests WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.clubMembershipRequest.findUniqueOrThrow({ where: { id } });
  }

  private async withCharges(
    tx: TenantTxClient,
    rows: readonly ClubMembershipRequest[],
  ): Promise<ClubRequestRead[]> {
    const charges = await this.charges.of(
      tx,
      'club_request',
      rows.map((r) => r.id),
    );
    return rows.map((r) => {
      const c = charges.get(r.id);
      return {
        ...r,
        charge: c ? { invoiceId: c.invoiceId, status: c.status } : null,
      };
    });
  }
}
