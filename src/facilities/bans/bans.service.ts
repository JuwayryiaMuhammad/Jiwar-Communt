import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { FacilityBan } from '@prisma/client';
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
import {
  addDays,
  localDate,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FacilitiesAccess } from '../access';
import { HOLDING } from '../bookings/booking-rules';
import { asDate, banState, type BanState } from './ban-reads';
import { StaffBookingsService } from '../bookings/staff-bookings.service';
import { dbNow } from '../db-clock';
import { BookingNotices } from '../notices/booking-notices';
import { FacilitiesService } from '../setup/facilities.service';
import { FacilityBanView } from './views/bans.views';

export const FACILITY_BAN_RESOURCE = 'facility_ban';
/** A dated ban ends within a year. */
export const MAX_BAN_DAYS = 365;
/** Who books, and so may be banned from booking. */
const BOOKERS = ['resident', 'family'] as const;

export interface NewBan {
  accountId: string;
  facilityId?: string;
  reasonCode?: string;
  endsOn?: LocalDate;
}

export interface BansQuery {
  accountId?: string;
  facilityId?: string;
  inForce?: 'true' | 'false';
  cursor?: string;
  limit?: number;
}

export interface BanRead {
  ban: FacilityBan;
  state: BanState;
  /** The bookings it cancelled when it started, by id. */
  cancelledBookingIds: string[];
}

const PAGE = keysetCursor('createdAt');

export const banNotFound = () =>
  appError.notFound(ErrorCode.FACILITY_BAN_NOT_FOUND, 'Facility ban not found');
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid ban', { fields });

/**
 * Facility bans (ADR 0067), kept with `bookings.handle`: one account kept
 * from booking one facility, or every one, with a reason code, until a day
 * of the compound's (inclusive) or until lifted. Beside a unit's no-show
 * suspension (ADR 0044), not built on it. Starting one cancels, in the same
 * transaction and as the staff cancel one, the account's bookings in its
 * scope that have not started — pending or confirmed — each pointing at
 * the ban and its booker told; the ban's response and its audit list them.
 * A walk-in visit and a club membership are untouched: a ban stops booking
 * only. One ban not lifted per account and scope (a unique key): one that
 * has ended is lifted by the system (`ended`) when the next one starts.
 *
 * Locks: the actor's account (shared), the banned account FOR UPDATE — a
 * booking holds it FOR SHARE while it decides, so a booking either
 * committed before (and is cancelled here) or waits and then meets the ban
 * — the facility (shared), then the bookings in id order. No unit lock: a
 * cancellation only frees places and quota.
 */
@Injectable()
export class FacilityBansService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly access: FacilitiesAccess,
    private readonly facilities: FacilitiesService,
    private readonly staffBookings: StaffBookingsService,
    private readonly notices: BookingNotices,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(FACILITY_BAN_RESOURCE, async (id) =>
      FacilityBanView.from(await this.get(id)),
    );
  }

  /** Every ban, the latest first. */
  list(q: BansQuery): Promise<Page<BanRead>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const today = await this.today(tx, await dbNow(tx));
      const rows = await tx.facilityBan.findMany({
        where: {
          AND: [
            q.accountId ? { accountId: q.accountId } : {},
            q.facilityId ? { facilityId: q.facilityId } : {},
            q.inForce ? { liftedAt: null } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: BanRead[] = [];
      for (const ban of page.items) {
        const state = banState(ban, today);
        if (q.inForce === 'true' && state !== 'in_force') continue;
        if (q.inForce === 'false' && state === 'in_force') continue;
        items.push(await this.read(tx, ban, today));
      }
      return { items, nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<BanRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const ban = await tx.facilityBan.findUnique({ where: { id } });
      if (!ban) throw banNotFound();
      return this.read(tx, ban, await this.today(tx, await dbNow(tx)));
    });
  }

  /** Every ban of the caller's, in any state, for its personal-data export. */
  everyOwn(): Promise<BanRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const today = await this.today(tx, await dbNow(tx));
      const bans = await tx.facilityBan.findMany({
        where: { accountId: this.ctx.accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return bans.map((ban) => ({
        ban,
        state: banState(ban, today),
        cancelledBookingIds: [],
      }));
    });
  }

  /** The caller's own bans in force, as a booker sees them. */
  mine(): Promise<BanRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const today = await this.today(tx, await dbNow(tx));
      const bans = await tx.facilityBan.findMany({
        where: { accountId: this.ctx.accountId, liftedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return bans
        .filter((b) => banState(b, today) === 'in_force')
        .map((ban) => ({ ban, state: 'in_force', cancelledBookingIds: [] }));
    });
  }

  /**
   * Bans the account from `facilityId`, or from every facility, from now
   * until `endsOn` (inclusive; within a year) or until lifted, and cancels
   * its bookings in that scope that have not started.
   */
  create(input: NewBan): Promise<BanRead> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.facilityBan,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: FACILITY_BAN_RESOURCE, id });
      await this.access.lockSelf(tx);
      await this.lockBooker(tx, input.accountId);
      if (input.facilityId)
        await this.facilities.lock(tx, input.facilityId, 'share');
      const now = await dbNow(tx);
      const today = await this.today(tx, now);
      if (
        input.endsOn !== undefined &&
        (input.endsOn < today || input.endsOn > addDays(today, MAX_BAN_DAYS))
      )
        throw invalid([
          {
            field: 'endsOn',
            code: FieldErrorCode.INVALID_VALUE,
            params: { from: today, to: addDays(today, MAX_BAN_DAYS) },
          },
        ]);
      const open = await tx.facilityBan.findFirst({
        where: {
          accountId: input.accountId,
          facilityId: input.facilityId ?? null,
          liftedAt: null,
        },
      });
      if (open && banState(open, today) === 'in_force')
        throw appError.conflict(
          ErrorCode.FACILITY_BAN_EXISTS,
          'A ban in force already covers this',
          { params: { banId: open.id } },
        );
      if (open)
        await tx.facilityBan.update({
          where: { id: open.id },
          data: { liftedAt: now, liftReasonCode: 'ended' },
        });
      const ban = await tx.facilityBan.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          accountId: input.accountId,
          facilityId: input.facilityId ?? null,
          reasonCode: reason,
          endsOn: input.endsOn ? asDate(input.endsOn) : null,
          createdById: this.ctx.accountId,
          createdAt: now,
        },
      });
      const due = input.facilityId
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM bookings
             WHERE booked_by_account_id = ${input.accountId}::uuid
               AND facility_id = ${input.facilityId}::uuid
               AND status::text = ANY(${[...HOLDING]}::text[]) AND starts_at > ${now}
             ORDER BY id FOR UPDATE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM bookings
             WHERE booked_by_account_id = ${input.accountId}::uuid
               AND status::text = ANY(${[...HOLDING]}::text[]) AND starts_at > ${now}
             ORDER BY id FOR UPDATE`;
      const cancelled: string[] = [];
      for (const { id: bookingId } of due) {
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: bookingId },
        });
        await this.staffBookings.cancelByStaffInTx(
          tx,
          booking,
          'facility_ban',
          now,
          ban.id,
        );
        cancelled.push(booking.id);
      }
      await this.audit.record(tx, {
        action: 'facility_ban.started',
        targetId: ban.id,
        metadata: {
          accountId: input.accountId,
          facilityId: input.facilityId ?? null,
          reasonCode: reason,
          endsOn: input.endsOn ?? null,
          cancelledBookingIds: cancelled,
          ...(open ? { endedBanId: open.id } : {}),
        },
      });
      await this.notices.send(
        tx,
        [input.accountId],
        'facility_ban.started',
        ban.id,
        {
          scope: input.facilityId ? 'facility' : 'all',
          ...(input.endsOn ? { until: input.endsOn } : {}),
        },
      );
      return { ban, state: 'in_force', cancelledBookingIds: cancelled };
    });
  }

  /** Lifted once, with a reason code, while in force; the account is told. */
  lift(id: string, reasonCode: string | undefined): Promise<BanRead> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.facilityBanLift,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.facilityBan.findUnique({ where: { id } });
      if (!seen) throw banNotFound();
      await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${seen.accountId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM facility_bans WHERE id = ${id}::uuid FOR UPDATE`;
      const ban = await tx.facilityBan.findUniqueOrThrow({ where: { id } });
      const now = await dbNow(tx);
      const today = await this.today(tx, now);
      const state = banState(ban, today);
      if (state !== 'in_force')
        throw appError.conflict(
          ErrorCode.FACILITY_BAN_OVER,
          'This ban is over',
          { params: { state } },
        );
      const lifted = await tx.facilityBan.update({
        where: { id },
        data: {
          liftedAt: now,
          liftedById: this.ctx.accountId,
          liftReasonCode: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'facility_ban.lifted',
        targetId: id,
        metadata: {
          accountId: ban.accountId,
          facilityId: ban.facilityId,
          reasonCode: reason,
        },
      });
      await this.notices.send(tx, [ban.accountId], 'facility_ban.lifted', id, {
        scope: ban.facilityId ? 'facility' : 'all',
      });
      return this.read(tx, lifted, today);
    });
  }

  // ------------------------------------------------------------ internals

  /** The banned account FOR UPDATE: an active account that books. */
  private async lockBooker(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
    const ok = await tx.account.count({
      where: { id: accountId, status: 'active', type: { in: [...BOOKERS] } },
    });
    if (!ok)
      throw invalid([
        { field: 'accountId', code: FieldErrorCode.BAN_ACCOUNT_NOT_ELIGIBLE },
      ]);
  }

  private async read(
    tx: TenantTxClient,
    ban: FacilityBan,
    today: LocalDate,
  ): Promise<BanRead> {
    const cancelled = await tx.booking.findMany({
      where: { banId: ban.id },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return {
      ban,
      state: banState(ban, today),
      cancelledBookingIds: cancelled.map((b) => b.id),
    };
  }

  private async today(tx: TenantTxClient, now: Date): Promise<LocalDate> {
    const { timezone } = await this.tenantSettings.inTx(tx, this.ctx.tenantId);
    return localDate(now, timezone);
  }
}
