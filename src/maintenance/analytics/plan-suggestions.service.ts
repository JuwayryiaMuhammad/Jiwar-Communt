import { Injectable } from '@nestjs/common';
import type { MaintenancePlanSuggestion } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { PlansService, type PlanInput } from '../plans/plans.service';
import { TicketAccess } from '../tickets/ticket-access';

export const SUGGESTION_STATUSES = ['open', 'accepted', 'dismissed'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export interface SuggestionRead {
  suggestion: MaintenancePlanSuggestion;
  categoryKey: string;
  /** The asset's or the unit's code. */
  placeCode: string | null;
}

const PAGE = keysetCursor('createdAt', 'desc');

export const suggestionNotFound = () =>
  appError.notFound(
    ErrorCode.PLAN_SUGGESTION_NOT_FOUND,
    'Plan suggestion not found',
  );

/**
 * Plan suggestions (ADR 0081): repeat faults the landing of a ticket found
 * (`TicketLanding`), for whoever keeps the plans. Read with `assets.read`;
 * decided once with `assets.manage`, under the suggestion's row lock (the
 * caller's account shared-locked first): accepted into a plan — a new one,
 * made by the plans' own rules in the same transaction (an asset not in a
 * unit; the suggestion's own when it names one), or an active plan that
 * covers it already — or dismissed with a reason code. Nothing changes a
 * plan by itself, and accepting into an existing plan changes nothing of
 * it.
 */
@Injectable()
export class PlanSuggestionsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly plans: PlansService,
    private readonly audit: AuditService,
  ) {}

  list(q: {
    status?: SuggestionStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<SuggestionRead>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.maintenancePlanSuggestion.findMany({
        where: {
          AND: [q.status ? { status: q.status } : {}, ...PAGE.after(q.cursor)],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: await this.reads(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<SuggestionRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.maintenancePlanSuggestion.findUnique({
        where: { id },
      });
      if (!row) throw suggestionNotFound();
      return (await this.reads(tx, [row]))[0];
    });
  }

  /** Exactly one of `planId` (an active plan) and `plan` (a new one). */
  accept(
    id: string,
    input: { planId?: string; plan?: PlanInput },
  ): Promise<SuggestionRead> {
    if (input.planId && input.plan)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid body', {
        fields: [{ field: 'plan', code: FieldErrorCode.FIELD_NOT_ALLOWED }],
      });
    if (!input.planId && !input.plan)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid body', {
        fields: [{ field: 'planId', code: FieldErrorCode.FIELD_REQUIRED }],
      });
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const s = await this.lockOpen(tx, id);
      let planId: string;
      if (input.planId) {
        const plan = await tx.maintenancePlan.findFirst({
          where: { id: input.planId, active: true },
        });
        if (!plan || (s.assetId !== null && plan.assetId !== s.assetId))
          throw planNotOfAsset();
        planId = plan.id;
      } else {
        const plan = input.plan!;
        if (s.assetId !== null && plan.assetId !== s.assetId)
          throw planNotOfAsset();
        planId = (
          await this.plans.createIn(tx, newId(), {
            ...plan,
            categoryId: plan.categoryId ?? s.categoryId,
          })
        ).plan.id;
      }
      const after = await tx.maintenancePlanSuggestion.update({
        where: { id },
        data: {
          status: 'accepted',
          decidedAt: await dbNow(tx),
          decidedById: this.ctx.accountId,
          planId,
          planCreated: !input.planId,
        },
      });
      await this.audit.record(tx, {
        action: 'plan_suggestion.accepted',
        targetId: id,
        metadata: {
          planId,
          planCreated: !input.planId,
          ticketCount: s.ticketCount,
        },
      });
      return (await this.reads(tx, [after]))[0];
    });
  }

  dismiss(id: string, reasonCode?: string): Promise<SuggestionRead> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.planSuggestionDismiss,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.lockOpen(tx, id);
      const after = await tx.maintenancePlanSuggestion.update({
        where: { id },
        data: {
          status: 'dismissed',
          decidedAt: await dbNow(tx),
          decidedById: this.ctx.accountId,
          reasonCode: code,
        },
      });
      await this.audit.record(tx, {
        action: 'plan_suggestion.dismissed',
        targetId: id,
        metadata: { reasonCode: code },
      });
      return (await this.reads(tx, [after]))[0];
    });
  }

  /** The suggestion under its row lock, open, or the matching refusal. */
  private async lockOpen(
    tx: TenantTxClient,
    id: string,
  ): Promise<MaintenancePlanSuggestion> {
    await tx.$queryRaw`SELECT id FROM maintenance_plan_suggestions WHERE id = ${id}::uuid FOR UPDATE`;
    const s = await tx.maintenancePlanSuggestion.findUnique({ where: { id } });
    if (!s) throw suggestionNotFound();
    if (s.status !== 'open')
      throw appError.conflict(
        ErrorCode.PLAN_SUGGESTION_DECIDED,
        'This suggestion is decided already',
        { params: { status: s.status } },
      );
    return s;
  }

  private async reads(
    tx: TenantTxClient,
    rows: MaintenancePlanSuggestion[],
  ): Promise<SuggestionRead[]> {
    const categories = new Map(
      (
        await tx.ticketCategory.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.categoryId))] } },
          select: { id: true, key: true },
        })
      ).map((c) => [c.id, c.key]),
    );
    const assets = new Map(
      (
        await tx.asset.findMany({
          where: {
            id: { in: rows.flatMap((r) => (r.assetId ? [r.assetId] : [])) },
          },
          select: { id: true, code: true },
        })
      ).map((a) => [a.id, a.code]),
    );
    const units = new Map(
      (
        await tx.unit.findMany({
          where: {
            id: { in: rows.flatMap((r) => (r.unitId ? [r.unitId] : [])) },
          },
          select: { id: true, code: true },
        })
      ).map((u) => [u.id, u.code]),
    );
    return rows.map((suggestion) => ({
      suggestion,
      categoryKey: categories.get(suggestion.categoryId)!,
      placeCode: suggestion.assetId
        ? (assets.get(suggestion.assetId) ?? null)
        : (units.get(suggestion.unitId!) ?? null),
    }));
  }
}

const planNotOfAsset = () =>
  appError.conflict(
    ErrorCode.PLAN_NOT_OF_ASSET,
    'That plan is not an active plan of this asset',
  );
