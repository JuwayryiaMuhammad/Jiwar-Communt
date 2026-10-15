import { Injectable } from '@nestjs/common';
import type { VehicleCounterKind, VehicleSettings } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { localDate, type LocalDate } from '../../core/common/slots/day-slots';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type {
  NotificationKind,
  NotificationParams,
} from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';

/** The idempotency resource of a vehicle write that answers with the vehicle. */
export const VEHICLE_RESOURCE = 'vehicle';

export const vehicleNotFound = () =>
  appError.notFound(ErrorCode.VEHICLE_NOT_FOUND, 'Vehicle not found');

export const unitNotFound = () =>
  appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');

/** The database's now and the compound's today, read after the locks. */
export interface Clock {
  now: Date;
  today: LocalDate;
  timeZone: string;
}

/**
 * What the vehicles, parking, fines and reports of ADR 0045 share: the
 * locks every write starts with, the numbers they carry, the compound's
 * settings and clock, and their notifications.
 *
 * **One lock order, everywhere:** the caller's account row (FOR SHARE),
 * the unit's advisory lock (`vehicle-unit` for vehicles, `parking-unit`
 * for visitor bookings), a plate's advisory lock (an approval), a visitor
 * pass's row, an area's row, the vehicle's, fine's or report's row, and
 * last the counter row. No path here locks a unit's row: the community
 * writes that lock it (a member removed, an occupancy ended) then reach
 * for accounts, so a unit row lock here would cycle with them (ADR 0044).
 */
@Injectable()
export class VehicleCore {
  constructor(
    private readonly ctx: RequestContext,
    private readonly community: CommunityGatePort,
    private readonly tenantSettings: TenantSettingsService,
    private readonly notifier: Notifier,
  ) {}

  /**
   * The caller's own account row, shared-locked for the rest of the
   * transaction (ADR 0039): an erasure or a deactivation, which locks it
   * first, either finished before and the caller is refused, or waits
   * until this write has committed and then sees what it made.
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
   * One unit's vehicles, decided by one writer at a time: the count of its
   * pending and active vehicles is read and then written under this lock,
   * so two registrations at once cannot both be the last one allowed.
   */
  async lockUnitVehicles(tx: TenantTxClient, unitId: string): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`vehicle-unit:${this.ctx.txTenantId}:${unitId}`}))`;
  }

  /**
   * One plate's permit, decided by one approval at a time: whether another
   * vehicle holds an active permit for it is read and then written under
   * this lock (the unique index is the backstop).
   */
  async lockPlate(tx: TenantTxClient, plateKey: string): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`vehicle-plate:${this.ctx.txTenantId}:${plateKey}`}))`;
  }

  /** The next number of its kind, under the counter's row lock: take it last. */
  async nextNumber(
    tx: TenantTxClient,
    kind: VehicleCounterKind,
  ): Promise<number> {
    const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
      INSERT INTO vehicle_counters (tenant_id, kind, last_number)
      VALUES (${this.ctx.txTenantId}::uuid, ${kind}::vehicle_counter_kind, 1)
      ON CONFLICT (tenant_id, kind)
        DO UPDATE SET last_number = vehicle_counters.last_number + 1
      RETURNING last_number AS number`;
    return number;
  }

  /** The compound's settings, read FOR SHARE: a change waits for this write. */
  async settings(tx: TenantTxClient): Promise<VehicleSettings> {
    await tx.$queryRaw`
      SELECT tenant_id FROM vehicle_settings
       WHERE tenant_id = ${this.ctx.txTenantId}::uuid FOR SHARE`;
    return tx.vehicleSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.txTenantId },
    });
  }

  /** The database's now and the compound's local today. */
  async clock(tx: TenantTxClient): Promise<Clock> {
    const now = await dbNow(tx);
    const { timezone } = await this.tenantSettings.inTx(
      tx,
      this.ctx.txTenantId,
    );
    return { now, today: localDate(now, timezone), timeZone: timezone };
  }

  /**
   * Tells the active accounts among `to`, never `except` (the one who
   * acted), in the action's transaction. The category is `vehicles`; no
   * kind is critical; params are a reason's code at most.
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
    return this.notifier.notify(
      tx,
      active.map((a) => a.id),
      { kind, params, targetId },
    );
  }

  /** The unit's code per unit id. */
  unitCodes(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<Map<string, string>> {
    return this.community.unitCodes(tx, unitIds);
  }
}
