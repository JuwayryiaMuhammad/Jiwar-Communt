import { Injectable } from '@nestjs/common';
import type { UnitPermitKind } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import type { Permission } from '../../core/access/permissions';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type {
  NotificationKind,
  NotificationParams,
} from '../../core/notifications/kinds';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { SafetyCore } from '../safety/safety-core';

/** What each kind's numbers start with. */
export const PERMIT_PREFIX: Record<UnitPermitKind, string> = {
  works: 'W',
  move: 'M',
  material_exit: 'X',
  event: 'E',
};

/** `W-0042`: the compound's own numbers, as everywhere (ADR 0008). */
export function permitReference(kind: UnitPermitKind, n: number): string {
  return `${PERMIT_PREFIX[kind]}-${String(n).padStart(4, '0')}`;
}

/**
 * What the permits share (ADR 0049): the caller's account lock, the unit's
 * lock, the numbers, who may ask, and the notifications.
 *
 * **One lock order, everywhere:** the caller's account row (FOR SHARE), the
 * unit's advisory lock (`permit-unit`), the compound's permit rules (FOR
 * SHARE), the permit's row (FOR UPDATE, or FOR SHARE at the gate), a
 * worker's or a guest's row (FOR UPDATE), a file's row, and last the counter
 * row. No path here locks a unit's row (ADR 0044, 0045).
 */
@Injectable()
export class PermitCore {
  constructor(
    private readonly ctx: RequestContext,
    private readonly community: CommunityGatePort,
    private readonly safety: SafetyCore,
    private readonly settings: TenantSettingsService,
  ) {}

  /** The caller's account row, shared-locked (see SafetyCore.lockSelf). */
  lockSelf(tx: TenantTxClient): Promise<void> {
    return this.safety.lockSelf(tx);
  }

  /** One writer at a time for a unit's permits. */
  async lockUnit(tx: TenantTxClient, unitId: string): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`permit-unit:${this.ctx.txTenantId}:${unitId}`}))`;
  }

  /** The next number of the kind, under the counter's row lock: take it last. */
  async nextNumber(tx: TenantTxClient, kind: UnitPermitKind): Promise<number> {
    const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
      INSERT INTO permit_counters (tenant_id, kind, last_number)
      VALUES (${this.ctx.txTenantId}::uuid, ${kind}::unit_permit_kind, 1)
      ON CONFLICT (tenant_id, kind)
        DO UPDATE SET last_number = permit_counters.last_number + 1
      RETURNING last_number AS number`;
    return number;
  }

  /** The compound's time zone. */
  async timeZone(tx: TenantTxClient): Promise<string> {
    return (await this.settings.inTx(tx, this.ctx.txTenantId)).timezone;
  }

  /**
   * The caller asks for a permit of the unit: works, a move or a material
   * exit are its primary's; an event, anyone the unit lets invite visitors.
   * A unit the caller has no place in is not found.
   */
  async requireRequester(
    tx: TenantTxClient,
    unitId: string,
    kind: UnitPermitKind,
  ): Promise<void> {
    const me = this.ctx.accountId;
    const caps = await this.community.placeIn(tx, me, unitId);
    if (!caps?.unitView)
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    // Works, a move, a material exit: the primary, or their `permits`
    // delegate (ADR 0062), who then sees the permits they asked for.
    const allowed =
      kind === 'event'
        ? caps.visitorsInvite
        : (await this.community.permitAuthority(tx, unitId)) !== null;
    if (!allowed)
      throw appError.forbidden(
        ErrorCode.PERMIT_NOT_ALLOWED,
        kind === 'event'
          ? 'Only someone the unit lets invite visitors holds an event'
          : 'Only the unit’s primary resident, or their permits delegate, asks for this permit',
      );
  }

  /** Whether the caller is the unit's primary now. */
  isPrimary(tx: TenantTxClient, unitId: string): Promise<boolean> {
    return this.community.isPrimary(tx, unitId, this.ctx.accountId);
  }

  /** The unit's primary now, or null. */
  primaryOf(tx: TenantTxClient, unitId: string): Promise<string | null> {
    return this.community.primaryOf(tx, unitId);
  }

  /** The unit's move planned that way, which a move permit serves (ADR 0063). */
  plannedMove(
    tx: TenantTxClient,
    unitId: string,
    direction: 'in' | 'out',
  ): Promise<string | null> {
    return this.community.plannedMove(tx, unitId, direction);
  }

  /** Active holders of a permission. */
  holding(tx: TenantTxClient, permission: Permission): Promise<string[]> {
    return this.safety.holding(tx, permission);
  }

  /** The guards on an open shift now (see SafetyCore.guardsOnShift). */
  guardsOnShift(tx: TenantTxClient): Promise<string[]> {
    return this.safety.guardsOnShift(tx);
  }

  /** Tells the active accounts among `to`, never `except` (see SafetyCore). */
  notify(
    tx: TenantTxClient,
    to: readonly (string | null)[],
    kind: NotificationKind,
    targetId: string,
    params: NotificationParams = {},
    except: string | null = null,
  ): Promise<number> {
    return this.safety.notify(tx, to, kind, targetId, params, except);
  }
}
