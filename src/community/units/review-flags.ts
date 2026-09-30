import { Injectable } from '@nestjs/common';
import type { UnitReviewReason } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * Why a unit is under review (ADR 0021). One open row per reason; a flag
 * is cleared, never deleted. Callers hold the unit lock (lockUnits).
 *
 * - `primary_left`: the primary's occupancy ended. Resolved only by a new
 *   primary (the family stays) or by ending the household (the unit
 *   changed hands).
 * - `primary_frozen`: the primary's account is frozen; reactivation or a
 *   new primary resolves it.
 * - `primary_deceased`: set by the manager. Household permissions are
 *   frozen (no grant, no revocation) and everything financial stops.
 * - `separation`: set by the manager. Revoking an adult's access is a
 *   manager decision; "my activity" stops.
 */
@Injectable()
export class ReviewFlags {
  constructor(
    private readonly audit: AuditService,
    private readonly ctx: RequestContext,
  ) {}

  /** Opens the flag unless one is already open for that reason. */
  async flag(
    tx: TenantTxClient,
    unitId: string,
    reason: UnitReviewReason,
    options: {
      reasonCode?: string;
      note?: string;
      byManager?: boolean;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<{ id: string; created: boolean }> {
    const open = await tx.unitReviewFlag.findFirst({
      where: { unitId, reason, clearedAt: null },
      select: { id: true },
    });
    if (open) return { id: open.id, created: false };
    const tenant = await tx.unit.findUniqueOrThrow({
      where: { id: unitId },
      select: { tenantId: true },
    });
    const id = newId();
    await tx.unitReviewFlag.create({
      data: {
        id,
        tenantId: tenant.tenantId,
        unitId,
        reason,
        reasonCode: options.reasonCode ?? null,
        note: options.note ?? null,
        flaggedById: options.byManager ? this.ctx.accountId : null,
      },
    });
    await this.audit.record(tx, {
      action: 'unit.household_review_flagged',
      targetId: unitId,
      changes: diffChanges(
        { reviewFlag: null },
        { reviewFlag: reason },
        'unit.household_review_flagged',
      ),
      metadata: {
        reason,
        flagId: id,
        ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}),
        ...options.metadata,
      },
    });
    return { id, created: true };
  }

  /** Clears the open flags of these reasons; returns how many. */
  async clear(
    tx: TenantTxClient,
    unitId: string,
    reasons: readonly UnitReviewReason[],
    clearReasonCode: string,
    options: { byAccount?: boolean; metadata?: Record<string, unknown> } = {},
  ): Promise<number> {
    const open = await tx.unitReviewFlag.findMany({
      where: { unitId, reason: { in: [...reasons] }, clearedAt: null },
    });
    for (const f of open) {
      await tx.unitReviewFlag.update({
        where: { id: f.id },
        data: {
          clearedAt: new Date(),
          clearedById: options.byAccount === false ? null : this.ctx.accountId,
          clearReasonCode,
        },
      });
      await this.audit.record(tx, {
        action: 'unit.household_review_cleared',
        targetId: unitId,
        changes: diffChanges(
          { reviewFlag: f.reason },
          { reviewFlag: null },
          'unit.household_review_cleared',
        ),
        metadata: {
          reason: f.reason,
          flagId: f.id,
          clearReasonCode,
          ...options.metadata,
        },
      });
    }
    return open.length;
  }

  async openReasons(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<UnitReviewReason[]> {
    const rows = await tx.unitReviewFlag.findMany({
      where: { unitId, clearedAt: null },
      select: { reason: true },
    });
    return rows.map((r) => r.reason);
  }

  /**
   * Death under review: no grant and no revocation in the household, by
   * anyone, until the manager settles it (set a primary or clear the flag).
   */
  async assertMutable(tx: TenantTxClient, unitId: string): Promise<void> {
    const frozen = await tx.unitReviewFlag.count({
      where: { unitId, reason: 'primary_deceased', clearedAt: null },
    });
    if (frozen) {
      throw appError.conflict(
        ErrorCode.HOUSEHOLD_UNDER_REVIEW,
        "The unit's household is under review with the management",
      );
    }
  }

  /**
   * Separation: revoking an adult's access is a manager decision; anyone
   * else is told to ask the management.
   */
  async assertNotSeparated(tx: TenantTxClient, unitId: string): Promise<void> {
    if (this.ctx.accountType === 'manager') return;
    const tagged = await tx.unitReviewFlag.count({
      where: { unitId, reason: 'separation', clearedAt: null },
    });
    if (tagged) {
      throw appError.forbidden(
        ErrorCode.SEPARATION_MANAGER_DECISION,
        "During a separation only the management revokes an adult's access",
      );
    }
  }
}
