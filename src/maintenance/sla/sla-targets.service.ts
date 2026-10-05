import { Injectable } from '@nestjs/common';
import type { TicketPriority } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { categoryNotFound } from '../categories/categories.service';
import {
  DEFAULT_SLA_TARGETS,
  PRIORITIES,
  type SlaTargetMinutes,
} from './default-sla-targets';

/** The CHECK ranges of sla_targets. */
export const RESPONSE_MINUTES = { min: 5, max: 10080 } as const;
export const RESOLUTION_MINUTES = { min: 15, max: 43200 } as const;

export type SlaTargets = Record<TicketPriority, SlaTargetMinutes>;

/**
 * A category's SLA targets, per priority (ADR 0034): set by the manager
 * (`maintenance.manage`, audited), read by the clocks when they start or a
 * ticket's priority or category changes. A clock keeps the target it was
 * started (or last retargeted) with: editing a target changes clocks
 * started afterwards, not the running ones.
 */
@Injectable()
export class SlaTargetsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /**
   * One category and priority's target, in the caller's transaction. Every
   * category has its three rows (seeded with it); the defaults are only a
   * guard against a row that is not there.
   */
  async forTicket(
    tx: TenantTxClient,
    ticket: { categoryId: string; priority: TicketPriority },
  ): Promise<SlaTargetMinutes> {
    const row = await tx.slaTarget.findUnique({
      where: {
        tenantId_categoryId_priority: {
          tenantId: this.ctx.txTenantId,
          categoryId: ticket.categoryId,
          priority: ticket.priority,
        },
      },
    });
    return row
      ? {
          responseMinutes: row.responseMinutes,
          resolutionMinutes: row.resolutionMinutes,
        }
      : DEFAULT_SLA_TARGETS[ticket.priority];
  }

  /** Replaces the three targets of a category, under its row lock. */
  replace(categoryId: string, targets: SlaTargets): Promise<void> {
    const fields = PRIORITIES.flatMap((p) => {
      const t = targets[p];
      return t.responseMinutes > t.resolutionMinutes
        ? [
            {
              field: `${p}.responseMinutes`,
              code: FieldErrorCode.SLA_RESPONSE_AFTER_RESOLUTION,
            },
          ]
        : [];
    });
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid SLA targets',
        { fields },
      );
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM ticket_categories WHERE id = ${categoryId}::uuid FOR UPDATE`;
      if (!locked.length) throw categoryNotFound();
      const before = await tx.slaTarget.findMany({ where: { categoryId } });
      const had = new Map(before.map((t) => [t.priority, t]));
      const changes: Record<string, { from: number | null; to: number }> = {};
      for (const priority of PRIORITIES) {
        const next = targets[priority];
        const prev = had.get(priority);
        for (const key of ['responseMinutes', 'resolutionMinutes'] as const)
          if (prev?.[key] !== next[key])
            changes[`${priority}.${key}`] = {
              from: prev?.[key] ?? null,
              to: next[key],
            };
        await tx.slaTarget.upsert({
          where: {
            tenantId_categoryId_priority: { tenantId, categoryId, priority },
          },
          create: { tenantId, categoryId, priority, ...next },
          update: next,
        });
      }
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'ticket_category.sla_targets_changed',
          targetId: categoryId,
          changes,
        });
    });
  }
}
