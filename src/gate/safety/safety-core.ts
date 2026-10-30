import { Injectable } from '@nestjs/common';
import type { SafetyCounterSeries } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import type { Permission } from '../../core/access/permissions';
import { PermissionsService } from '../../core/access/permissions.service';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type {
  NotificationKind,
  NotificationParams,
} from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';

/** Where a unit is: its code and building (ADR 0047: "building and unit"). */
export interface UnitLocation {
  unitId: string;
  unitCode: string;
  building: string | null;
}

/**
 * What emergencies and gate service requests share (ADR 0047): the caller's
 * account lock, the unit's lock, the numbers, who responds, the phone a
 * responder gives, and the notifications.
 *
 * **One lock order, everywhere:** the caller's account row (FOR SHARE), a
 * guard's shift (FOR SHARE, `actingLocked`; ADR 0056), the unit's advisory
 * lock (`emergency-unit` or `gate-service-unit`), the
 * emergency's or request's row (FOR UPDATE), a place's row (FOR SHARE), and
 * last the counter row. No path here locks a unit's row (ADR 0044, 0045).
 */
@Injectable()
export class SafetyCore {
  constructor(
    private readonly ctx: RequestContext,
    private readonly community: CommunityGatePort,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly settings: TenantSettingsService,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * Who is acting on the responders' side, and from where: a guard inside
   * their open shift (the gate of it), or a holder of one of `others` (no
   * gate). A guard without an open shift and nothing else is refused (403
   * NO_OPEN_SHIFT): the route let them in by `gate.operate` alone.
   */
  acting(
    tx: TenantTxClient,
    others: readonly Permission[],
  ): Promise<{ gateId: string | null; permissions: ReadonlySet<string> }> {
    return this.actingAs(tx, others, false);
  }

  /**
   * As `acting`, for a write: the guard's shift is read FOR SHARE, after
   * the caller's account (ADR 0056's lock order). Its end waits for the
   * write, or came first and the guard acts as their other permissions
   * let them, or is refused.
   */
  actingLocked(
    tx: TenantTxClient,
    others: readonly Permission[],
  ): Promise<{ gateId: string | null; permissions: ReadonlySet<string> }> {
    return this.actingAs(tx, others, true);
  }

  private async actingAs(
    tx: TenantTxClient,
    others: readonly Permission[],
    locked: boolean,
  ): Promise<{ gateId: string | null; permissions: ReadonlySet<string> }> {
    const permissions = await this.permissions.current();
    if (permissions.has('gate.operate')) {
      const shift = locked
        ? (
            await tx.$queryRaw<{ gateId: string | null }[]>`
              SELECT gate_id AS "gateId" FROM guard_shifts
               WHERE guard_account_id = ${this.ctx.accountId}::uuid
                 AND ended_at IS NULL
                 FOR SHARE`
          )[0]
        : await tx.guardShift.findFirst({
            where: { guardAccountId: this.ctx.accountId, endedAt: null },
            select: { gateId: true },
          });
      if (shift) return { gateId: shift.gateId, permissions };
    }
    if (others.some((p) => permissions.has(p)))
      return { gateId: null, permissions };
    throw appError.forbidden(
      ErrorCode.NO_OPEN_SHIFT,
      'Start a shift at a gate before acting at the gate',
    );
  }

  /**
   * The caller's own account row, shared-locked for the rest of the
   * transaction: an erasure or a deactivation, which locks it first, either
   * finished before and the caller is refused, or waits for this write.
   */
  async lockSelf(tx: TenantTxClient): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM accounts
       WHERE id = ${this.ctx.accountId}::uuid FOR SHARE`;
    if (rows[0]?.status !== 'active')
      throw appError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required',
      );
  }

  /**
   * One writer at a time for a unit's emergencies or requests of a kind, or
   * for a post's emergencies (`emergency-post`, a gate's or a zone's id: a
   * guard's SOS, ADR 0053), or a ticket's (`emergency-ticket`: a
   * technician's SOS, ADR 0067).
   */
  async lockUnit(
    tx: TenantTxClient,
    scope:
      | 'emergency-unit'
      | 'gate-service-unit'
      | 'emergency-post'
      | 'emergency-ticket',
    unitId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`${scope}:${this.ctx.txTenantId}:${unitId}`}))`;
  }

  /** The next number of the series, under the counter's row lock: take it last. */
  async nextNumber(
    tx: TenantTxClient,
    series: SafetyCounterSeries,
  ): Promise<number> {
    const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
      INSERT INTO safety_counters (tenant_id, series, last_number)
      VALUES (${this.ctx.txTenantId}::uuid, ${series}::safety_counter_series, 1)
      ON CONFLICT (tenant_id, series)
        DO UPDATE SET last_number = safety_counters.last_number + 1
      RETURNING last_number AS number`;
    return number;
  }

  /**
   * The guards on an open shift now — at a gate (`gateId`) or in a zone
   * (`{ placeId }`, ADR 0050) only when given — whose account is active and
   * still holds `gate.operate`.
   */
  async guardsOnShift(
    tx: TenantTxClient,
    at?: string | { placeId: string },
  ): Promise<string[]> {
    const where =
      at === undefined ? {} : typeof at === 'string' ? { gateId: at } : at;
    const shifts = await tx.guardShift.findMany({
      where: { endedAt: null, ...where },
      select: { guardAccountId: true },
    });
    if (!shifts.length) return [];
    const guards = await tx.account.findMany({
      where: {
        id: { in: [...new Set(shifts.map((s) => s.guardAccountId))] },
        status: 'active',
        role: { permissions: { some: { permission: 'gate.operate' } } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return guards.map((g) => g.id);
  }

  /** Active holders of a permission (any role the compound gave it to). */
  async holding(tx: TenantTxClient, permission: Permission): Promise<string[]> {
    return (await this.staff.holding(tx, permission)).map((r) => r.id);
  }

  /**
   * The phone a responder gives (ADR 0047): the phone of the gate where they
   * are on shift; for anyone not at a gate (or a gate without one), the
   * compound's duty phone, then its emergency number. Never their own.
   */
  async responderPhone(
    tx: TenantTxClient,
    gateId: string | null,
  ): Promise<string | null> {
    if (gateId) {
      const gate = await tx.gate.findUnique({
        where: { id: gateId },
        select: { phone: true },
      });
      if (gate?.phone) return gate.phone;
    }
    const s = await this.settings.inTx(tx, this.ctx.txTenantId);
    return s.dutyPhone ?? s.emergencyPhone ?? null;
  }

  /** Household members' first names by member id (accessibility help). */
  async memberNames(
    tx: TenantTxClient,
    memberIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    return this.community.memberFirstNames(tx, memberIds);
  }

  /** Where each unit is. */
  async locations(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<Map<string, UnitLocation>> {
    return this.community.unitLocations(tx, unitIds);
  }

  /**
   * Tells the active accounts among `to`, never `except` (the one who
   * acted), in the action's transaction. Returns how many were told.
   */
  async notify(
    tx: TenantTxClient,
    to: readonly (string | null)[],
    kind: NotificationKind,
    targetId: string,
    params: NotificationParams = {},
    except: string | null = null,
  ): Promise<number> {
    const ids = [...new Set(to)].filter(
      (id): id is string => id !== null && id !== except,
    );
    if (!ids.length) return 0;
    const active = await tx.account.findMany({
      where: { id: { in: ids }, status: 'active' },
      select: { id: true },
    });
    if (!active.length) return 0;
    await this.notifier.notify(
      tx,
      active.map((a) => a.id),
      { kind, params, targetId },
    );
    return active.length;
  }
}
