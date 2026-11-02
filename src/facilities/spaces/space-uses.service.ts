import { Injectable } from '@nestjs/common';
import { Prisma, type SpaceUseRequest } from '@prisma/client';
import { CommunityFacilitiesPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FacilitiesAccess } from '../access';
import { HOLDING } from '../bookings/booking-rules';
import { dbNow } from '../db-clock';
import { BookingNotices } from '../notices/booking-notices';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The product's rules for a use request (ADR 0084). */
export const SPACE_USE_RULES = {
  /** Asked at least this many hours before it starts. */
  minHoursAhead: 24,
  /** Starting within this many days. */
  maxDaysAhead: 90,
  /** Lasting at most this many hours (CHECK space_use_requests_window). */
  maxHours: 12,
  /** Pending or approved and not over, per unit. */
  livePerUnit: 3,
  guestsMax: 500,
} as const;

export const SPACE_USE_STATUSES = [
  'pending',
  'approved',
  'refused',
  'cancelled',
  'expired',
] as const;
export type SpaceUseStatus = (typeof SPACE_USE_STATUSES)[number];

/** A request, with what its views show of its area and unit. */
export interface SpaceUseRead {
  request: SpaceUseRequest;
  areaCode: string;
  areaNameEn: string;
  areaNameAr: string;
  facilityId: string | null;
  unitCode: string;
}

export interface SpaceUseAreaRead {
  commonAreaId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  facilityId: string | null;
  openedAt: Date;
}

export interface NewSpaceUse {
  commonAreaId: string;
  startsAt: Date;
  endsAt: Date;
  purpose: string;
  guests?: number;
}

const PAGE = keysetCursor('createdAt');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export const spaceUseNotFound = () =>
  appError.notFound(ErrorCode.SPACE_USE_NOT_FOUND, 'Request not found');

const unitNotFound = () =>
  appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');

const decided = (status: string) =>
  appError.conflict(ErrorCode.SPACE_USE_DECIDED, 'This request is decided', {
    params: { status },
  });

/**
 * Common-area use requests (ADR 0084). The management opens common areas
 * (ADR 0064) to requests (`spaces.manage`); a resident who books for a
 * unit (`facilities.book`, its `bookings` capability) asks to use one for
 * a time — at least 24 hours ahead, within 90 days, at most 12 hours, three
 * live per unit — with a purpose; the staff (`bookings.handle`) approve it
 * or refuse it with a code, and may cancel an approved one with a code. Its
 * requester, or the unit's primary (not during a separation), withdraws it
 * before it starts. A request nobody decided expires at its start (the
 * sweep).
 *
 * The approval is the race: approved uses of one area never overlap
 * (SPACE_USE_OVERLAP), and an area that is a facility's never holds an
 * approved use and a booking at once (SPACE_USE_BOOKED; FACILITY_CLOSED
 * for a closure in force). Locks, in order: the caller's account; the
 * facility's row FOR UPDATE when the area is a facility's (a booking holds
 * it FOR SHARE, and then sees the use as the facility closed); the area's
 * row FOR UPDATE (two approvals in one area go one at a time); the
 * request's row. A resident's request takes the unit's lock first (its
 * live count).
 */
@Injectable()
export class SpaceUsesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly access: FacilitiesAccess,
    private readonly community: CommunityFacilitiesPort,
    private readonly notices: BookingNotices,
  ) {}

  // --------------------------------------------------------------------------
  // The areas open to requests
  // --------------------------------------------------------------------------

  /** Every open area; for the apps, the active ones only. */
  areas(audience: 'staff' | 'residents'): Promise<SpaceUseAreaRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          common_area_id: string;
          code: string;
          name_en: string;
          name_ar: string;
          facility_id: string | null;
          opened_at: Date;
        }[]
      >`
        SELECT o.common_area_id, a.code, a.name_en, a.name_ar, a.facility_id,
               o.opened_at
          FROM space_use_areas o
          JOIN common_areas a ON a.id = o.common_area_id
         WHERE ${audience === 'staff'}::boolean OR a.active
         ORDER BY a.code`;
      return rows.map((r) => ({
        commonAreaId: r.common_area_id,
        code: r.code,
        nameEn: r.name_en,
        nameAr: r.name_ar,
        facilityId: r.facility_id,
        openedAt: r.opened_at,
      }));
    });
  }

  /** Opens an active area (not a building as a whole) to requests; once. */
  openArea(commonAreaId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.lockArea(tx, commonAreaId);
      const area = await tx.commonArea.findUniqueOrThrow({
        where: { id: commonAreaId },
      });
      if (!area.active || area.kind === 'building')
        throw appError.notFound(
          ErrorCode.COMMON_AREA_NOT_FOUND,
          'Common area not found',
        );
      const open = await tx.spaceUseArea.findUnique({
        where: {
          tenantId_commonAreaId: { tenantId: area.tenantId, commonAreaId },
        },
      });
      if (open) return;
      await tx.spaceUseArea.create({
        data: {
          tenantId: area.tenantId,
          commonAreaId,
          openedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'space_use_area.opened',
        targetId: commonAreaId,
      });
    });
  }

  /** Takes no new requests for it; what was asked or approved stands. */
  closeArea(commonAreaId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.lockArea(tx, commonAreaId);
      const { count } = await tx.spaceUseArea.deleteMany({
        where: { commonAreaId },
      });
      if (count)
        await this.audit.record(tx, {
          action: 'space_use_area.closed',
          targetId: commonAreaId,
        });
    });
  }

  // --------------------------------------------------------------------------
  // The residents' side
  // --------------------------------------------------------------------------

  request(unitId: string, input: NewSpaceUse): Promise<SpaceUseRead> {
    const fields: FieldError[] = [];
    const length = input.endsAt.getTime() - input.startsAt.getTime();
    if (length <= 0)
      fields.push({ field: 'endsAt', code: FieldErrorCode.ENDS_BEFORE_START });
    else if (length > SPACE_USE_RULES.maxHours * HOUR)
      fields.push({
        field: 'endsAt',
        code: FieldErrorCode.SPACE_USE_TOO_LONG,
        params: { hours: SPACE_USE_RULES.maxHours },
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.lockUnit(tx, unitId);
      const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
      if (!caps) throw unitNotFound();
      if (!caps.bookings)
        throw appError.forbidden(
          ErrorCode.BOOKINGS_NOT_ALLOWED,
          'This person may not book for this unit',
        );
      const now = await dbNow(tx);
      if (
        input.startsAt.getTime() <
        now.getTime() + SPACE_USE_RULES.minHoursAhead * HOUR
      )
        throw invalid([
          {
            field: 'startsAt',
            code: FieldErrorCode.SPACE_USE_TOO_SOON,
            params: { hours: SPACE_USE_RULES.minHoursAhead },
          },
        ]);
      if (
        input.startsAt.getTime() >
        now.getTime() + SPACE_USE_RULES.maxDaysAhead * DAY
      )
        throw invalid([
          {
            field: 'startsAt',
            code: FieldErrorCode.SPACE_USE_TOO_FAR,
            params: { days: SPACE_USE_RULES.maxDaysAhead },
          },
        ]);
      const area = await this.openAreaOf(tx, input.commonAreaId);
      if (!area)
        throw appError.conflict(
          ErrorCode.SPACE_USE_AREA_CLOSED,
          'This area does not take use requests',
        );
      const live = await tx.spaceUseRequest.count({
        where: {
          unitId,
          status: { in: ['pending', 'approved'] },
          endsAt: { gt: now },
        },
      });
      if (live >= SPACE_USE_RULES.livePerUnit)
        throw appError.conflict(
          ErrorCode.SPACE_USE_LIMIT,
          'The unit has as many open requests as it may',
          { params: { max: SPACE_USE_RULES.livePerUnit } },
        );
      // Told early when an approved use holds the time already; the
      // approval decides under its locks.
      if (await this.approvedOverlap(tx, input.commonAreaId, input, null))
        throw appError.conflict(
          ErrorCode.SPACE_USE_OVERLAP,
          'An approved use of this area overlaps this time',
        );
      const row = await tx.spaceUseRequest.create({
        data: {
          id: newId(),
          tenantId: area.tenantId,
          commonAreaId: input.commonAreaId,
          unitId,
          requestedById: this.ctx.accountId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          purpose: input.purpose,
          guests: input.guests ?? 0,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'space_use.requested',
        targetId: row.id,
        metadata: {
          commonAreaId: row.commonAreaId,
          unitId,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          guests: row.guests,
        },
      });
      return (await this.reads(tx, [row]))[0];
    });
  }

  /**
   * The unit's requests the caller sees, newest first: their own; the
   * unit's primary sees all of them, except during a separation.
   */
  forUnit(
    unitId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<SpaceUseRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
      if (!caps?.unitView) throw unitNotFound();
      const whose = (await this.seesUnit(tx, unitId))
        ? {}
        : { requestedById: this.ctx.accountId };
      const limit = clampLimit(q.limit);
      const rows = await tx.spaceUseRequest.findMany({
        where: { AND: [{ unitId, ...whose }, ...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return { ...page, items: await this.reads(tx, page.items) };
    });
  }

  /** Its requester or the unit's primary, before it starts: with a code. */
  withdraw(id: string, reasonCode: string | undefined): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.spaceUseWithdraw,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const r = await this.lockRow(tx, id);
      if (
        r.requestedById !== this.ctx.accountId &&
        !(await this.seesUnit(tx, r.unitId))
      )
        throw spaceUseNotFound();
      if (r.status !== 'pending' && r.status !== 'approved')
        throw decided(r.status);
      const now = await dbNow(tx);
      if (r.startsAt.getTime() <= now.getTime())
        throw appError.conflict(
          ErrorCode.SPACE_USE_STARTED,
          'This request’s time has started',
        );
      await this.end(tx, r, {
        reason,
        side: 'resident',
        by: this.ctx.accountId,
        now,
      });
    });
  }

  // --------------------------------------------------------------------------
  // The staff's side
  // --------------------------------------------------------------------------

  list(q: {
    status?: SpaceUseStatus;
    commonAreaId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<SpaceUseRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.spaceUseRequest.findMany({
        where: {
          AND: [
            {
              ...(q.status ? { status: q.status } : {}),
              ...(q.commonAreaId ? { commonAreaId: q.commonAreaId } : {}),
            },
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return { ...page, items: await this.reads(tx, page.items) };
    });
  }

  get(id: string): Promise<SpaceUseRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.spaceUseRequest.findUnique({ where: { id } });
      if (!row) throw spaceUseNotFound();
      return (await this.reads(tx, [row]))[0];
    });
  }

  approve(id: string): Promise<SpaceUseRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.spaceUseRequest.findUnique({
        where: { id },
        select: { commonAreaId: true },
      });
      if (!seen) throw spaceUseNotFound();
      const area = await tx.commonArea.findUniqueOrThrow({
        where: { id: seen.commonAreaId },
        select: { facilityId: true, code: true },
      });
      if (area.facilityId)
        await tx.$queryRaw`
          SELECT id FROM facilities WHERE id = ${area.facilityId}::uuid FOR UPDATE`;
      await this.lockArea(tx, seen.commonAreaId);
      const r = await this.lockRow(tx, id);
      if (r.status !== 'pending') throw decided(r.status);
      const now = await dbNow(tx);
      if (r.startsAt.getTime() <= now.getTime())
        throw appError.conflict(
          ErrorCode.SPACE_USE_STARTED,
          'This request’s time has started',
        );
      if (await this.approvedOverlap(tx, r.commonAreaId, r, r.id))
        throw appError.conflict(
          ErrorCode.SPACE_USE_OVERLAP,
          'An approved use of this area overlaps this time',
        );
      if (area.facilityId) {
        const bookings = await tx.booking.count({
          where: {
            facilityId: area.facilityId,
            status: { in: [...HOLDING] },
            startsAt: { lt: r.endsAt },
            endsAt: { gt: r.startsAt },
          },
        });
        if (bookings)
          throw appError.conflict(
            ErrorCode.SPACE_USE_BOOKED,
            'The facility is booked at that time',
            { params: { bookings } },
          );
        if (
          await tx.facilityClosure.findFirst({
            where: {
              facilityId: area.facilityId,
              liftedAt: null,
              startsAt: { lt: r.endsAt },
              endsAt: { gt: r.startsAt },
            },
            select: { id: true },
          })
        )
          throw appError.conflict(
            ErrorCode.FACILITY_CLOSED,
            'The facility is closed at that time',
          );
      }
      const row = await tx.spaceUseRequest.update({
        where: { id },
        data: {
          status: 'approved',
          decidedAt: now,
          decidedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'space_use.approved',
        targetId: id,
        metadata: { commonAreaId: r.commonAreaId, unitId: r.unitId },
      });
      await this.notices.send(tx, [r.requestedById], 'space_use.approved', id, {
        area: area.code,
      });
      return (await this.reads(tx, [row]))[0];
    });
  }

  refuse(id: string, reasonCode: string | undefined): Promise<SpaceUseRead> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.spaceUseRefuse,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const r = await this.lockRow(tx, id);
      if (r.status !== 'pending') throw decided(r.status);
      const now = await dbNow(tx);
      const row = await tx.spaceUseRequest.update({
        where: { id },
        data: {
          status: 'refused',
          decidedAt: now,
          decidedById: this.ctx.accountId,
          reasonCode: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'space_use.refused',
        targetId: id,
        metadata: { commonAreaId: r.commonAreaId, reasonCode: reason },
      });
      await this.notices.send(tx, [r.requestedById], 'space_use.refused', id, {
        area: await this.codeOf(tx, r.commonAreaId),
        reason,
      });
      return (await this.reads(tx, [row]))[0];
    });
  }

  /** An approved use, cancelled by the staff before it ends: with a code. */
  cancel(id: string, reasonCode: string | undefined): Promise<SpaceUseRead> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.spaceUseCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const r = await this.lockRow(tx, id);
      if (r.status !== 'approved') throw decided(r.status);
      const now = await dbNow(tx);
      if (r.endsAt.getTime() <= now.getTime())
        throw appError.conflict(
          ErrorCode.SPACE_USE_DECIDED,
          'This use is over',
          { params: { status: r.status, over: true } },
        );
      const row = await this.end(tx, r, {
        reason,
        side: 'staff',
        by: this.ctx.accountId,
        now,
      });
      await this.notices.send(
        tx,
        [r.requestedById],
        'space_use.cancelled',
        id,
        { area: await this.codeOf(tx, r.commonAreaId), reason },
      );
      return (await this.reads(tx, [row]))[0];
    });
  }

  // --------------------------------------------------------------------------
  // The system's side
  // --------------------------------------------------------------------------

  /**
   * The sweep's one item: a request still pending at its start expires,
   * once (a conditional update: of two sweeps, one changes it), and its
   * requester is told.
   */
  async expireIn(tx: TenantTxClient, id: string, now: Date): Promise<number> {
    const { count } = await tx.spaceUseRequest.updateMany({
      where: { id, status: 'pending', startsAt: { lte: now } },
      data: { status: 'expired', endedAt: now },
    });
    if (!count) return 0;
    const r = await tx.spaceUseRequest.findUniqueOrThrow({ where: { id } });
    await this.audit.record(tx, {
      action: 'space_use.expired',
      targetId: id,
      metadata: { commonAreaId: r.commonAreaId },
    });
    await this.notices.send(tx, [r.requestedById], 'space_use.expired', id, {
      area: await this.codeOf(tx, r.commonAreaId),
    });
    return 1;
  }

  /**
   * The account left (deactivated, erased, or no longer books for the
   * unit): its live requests that have not started are cancelled by the
   * system (`requester_left`), nobody told. On erasure its purposes go.
   */
  async requesterLeft(
    tx: TenantTxClient,
    accountId: string,
    opts: { unitId?: string; erase?: boolean },
  ): Promise<void> {
    const now = await dbNow(tx);
    const ids = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM space_use_requests
       WHERE requested_by_account_id = ${accountId}::uuid
         AND status IN ('pending', 'approved') AND starts_at > ${now}
         ${opts.unitId ? Prisma.sql`AND unit_id = ${opts.unitId}::uuid` : Prisma.empty}
       ORDER BY id FOR UPDATE`;
    for (const { id } of ids) {
      const r = await tx.spaceUseRequest.findUniqueOrThrow({ where: { id } });
      await this.end(tx, r, {
        reason: 'requester_left',
        side: 'system',
        by: null,
        now,
      });
    }
    if (opts.erase)
      await tx.spaceUseRequest.updateMany({
        where: { requestedById: accountId, purpose: { not: null } },
        data: { purpose: null },
      });
  }

  /** Every request the account made, for its export. */
  mine(): Promise<SpaceUseRead[]> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.reads(
        tx,
        await tx.spaceUseRequest.findMany({
          where: { requestedById: this.ctx.accountId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      ),
    );
  }

  // --------------------------------------------------------------------------

  private async end(
    tx: TenantTxClient,
    r: SpaceUseRequest,
    how: {
      reason: string;
      side: 'resident' | 'staff' | 'system';
      by: string | null;
      now: Date;
    },
  ): Promise<SpaceUseRequest> {
    const row = await tx.spaceUseRequest.update({
      where: { id: r.id },
      data: {
        status: 'cancelled',
        reasonCode: how.reason,
        endedAt: how.now,
        endedById: how.by,
      },
    });
    await this.audit.record(tx, {
      action: 'space_use.cancelled',
      targetId: r.id,
      metadata: {
        commonAreaId: r.commonAreaId,
        from: r.status,
        side: how.side,
        reasonCode: how.reason,
      },
    });
    return row;
  }

  private async approvedOverlap(
    tx: TenantTxClient,
    commonAreaId: string,
    window: { startsAt: Date; endsAt: Date },
    except: string | null,
  ): Promise<boolean> {
    return (
      (await tx.spaceUseRequest.findFirst({
        where: {
          commonAreaId,
          status: 'approved',
          startsAt: { lt: window.endsAt },
          endsAt: { gt: window.startsAt },
          ...(except ? { id: { not: except } } : {}),
        },
        select: { id: true },
      })) !== null
    );
  }

  private async openAreaOf(tx: TenantTxClient, commonAreaId: string) {
    const rows = await tx.$queryRaw<{ tenant_id: string }[]>`
      SELECT a.tenant_id FROM space_use_areas o
        JOIN common_areas a ON a.id = o.common_area_id
       WHERE o.common_area_id = ${commonAreaId}::uuid AND a.active`;
    return rows.length ? { tenantId: rows[0].tenant_id } : null;
  }

  private async lockArea(tx: TenantTxClient, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM common_areas WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length)
      throw appError.notFound(
        ErrorCode.COMMON_AREA_NOT_FOUND,
        'Common area not found',
      );
  }

  private async lockRow(
    tx: TenantTxClient,
    id: string,
  ): Promise<SpaceUseRequest> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM space_use_requests WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw spaceUseNotFound();
    return tx.spaceUseRequest.findUniqueOrThrow({ where: { id } });
  }

  private async codeOf(tx: TenantTxClient, id: string): Promise<string> {
    return (
      await tx.commonArea.findUniqueOrThrow({
        where: { id },
        select: { code: true },
      })
    ).code;
  }

  private async seesUnit(tx: TenantTxClient, unitId: string): Promise<boolean> {
    return (
      (await this.community.isPrimary(tx, this.ctx.accountId, unitId)) &&
      !(await this.community.separated(tx, unitId))
    );
  }

  private async reads(
    tx: TenantTxClient,
    rows: readonly SpaceUseRequest[],
  ): Promise<SpaceUseRead[]> {
    if (!rows.length) return [];
    const areas = new Map(
      (
        await tx.commonArea.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.commonAreaId))] } },
          select: {
            id: true,
            code: true,
            nameEn: true,
            nameAr: true,
            facilityId: true,
          },
        })
      ).map((a) => [a.id, a]),
    );
    const unitCodes = new Map(
      (
        await tx.unit.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.unitId))] } },
          select: { id: true, code: true },
        })
      ).map((u) => [u.id, u.code]),
    );
    return rows.map((r) => {
      const a = areas.get(r.commonAreaId)!;
      return {
        request: r,
        areaCode: a.code,
        areaNameEn: a.nameEn,
        areaNameAr: a.nameAr,
        facilityId: a.facilityId,
        unitCode: unitCodes.get(r.unitId)!,
      };
    });
  }
}
