import { Injectable } from '@nestjs/common';
import type { PreventiveService } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';

export interface PreventiveServiceInput {
  key: string;
  nameAr: string;
  nameEn: string;
  categoryId: string;
  position?: number;
}

export type PreventiveServiceUpdate = Partial<
  Pick<
    PreventiveService,
    'nameAr' | 'nameEn' | 'categoryId' | 'position' | 'active'
  >
>;

const ORDER = [{ position: 'asc' }, { key: 'asc' }] as const;

export const preventiveServiceNotFound = () =>
  appError.notFound(
    ErrorCode.PREVENTIVE_SERVICE_NOT_FOUND,
    'Preventive service not found',
  );

/**
 * The compound's preventive services (ADR 0038): what a resident may book
 * a check-up for. Its own data, managed with `maintenance.manage`, like the
 * ticket categories. Never deleted, because preventive tickets point at
 * them; a retired one is `active: false` and no longer offered.
 */
@Injectable()
export class PreventiveServicesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** Every service, retired ones included (a compound has a handful). */
  list(): Promise<PreventiveService[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.preventiveService.findMany({ orderBy: [...ORDER] }),
    );
  }

  /** What a resident may ask for: active, under an active category. */
  options(): Promise<PreventiveService[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.preventiveService.findMany({
        where: { active: true, category: { active: true } },
        orderBy: [...ORDER],
      }),
    );
  }

  /**
   * A duplicate key is DUPLICATE_RESOURCE on `key` (db-constraints). Without
   * a position, it goes after the others.
   */
  create(input: PreventiveServiceInput): Promise<PreventiveService> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const categoryKey = await this.categoryKey(tx, input.categoryId);
      const last = await tx.preventiveService.aggregate({
        _max: { position: true },
      });
      const service = await tx.preventiveService.create({
        data: {
          id: newId(),
          tenantId,
          key: input.key,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
          categoryId: input.categoryId,
          position:
            input.position ?? Math.min((last._max.position ?? 0) + 1, 1000),
        },
      });
      await this.audit.record(tx, {
        action: 'preventive_service.created',
        targetId: service.id,
        changes: diffChanges(
          null,
          audited(service, categoryKey),
          'preventive_service.created',
        ),
      });
      return service;
    });
  }

  /** The key never changes: apps and reports may hold on to it. */
  update(
    id: string,
    input: PreventiveServiceUpdate,
  ): Promise<PreventiveService> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await tx.preventiveService.findUnique({
        where: { id },
        include: { category: { select: { key: true } } },
      });
      if (!before) throw preventiveServiceNotFound();
      // A new category must be active; the one it already has may be retired.
      const categoryKey =
        input.categoryId !== undefined && input.categoryId !== before.categoryId
          ? await this.categoryKey(tx, input.categoryId)
          : before.category.key;
      const service = await tx.preventiveService.update({
        where: { id },
        data: {
          nameAr: input.nameAr?.trim(),
          nameEn: input.nameEn?.trim(),
          categoryId: input.categoryId,
          position: input.position,
          active: input.active,
        },
      });
      const changes = diffChanges(
        audited(before, before.category.key),
        audited(service, categoryKey),
        'preventive_service.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'preventive_service.updated',
          targetId: service.id,
          changes,
        });
      return service;
    });
  }

  /** The key of an active category, or CATEGORY_NOT_AVAILABLE on `categoryId`. */
  private async categoryKey(tx: TenantTxClient, id: string): Promise<string> {
    const category = await tx.ticketCategory.findFirst({
      where: { id, active: true },
      select: { key: true },
    });
    if (!category)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid preventive service',
        {
          fields: [
            {
              field: 'categoryId',
              code: FieldErrorCode.CATEGORY_NOT_AVAILABLE,
            },
          ],
        },
      );
    return category.key;
  }
}

/**
 * What the audit trail records of a service. Its names are free text the
 * manager wrote: the catalog marks them sensitive, so a rename is recorded
 * as `{ changed: true }`, never with the words.
 */
function audited(s: PreventiveService, categoryKey: string) {
  return {
    key: s.key,
    nameAr: s.nameAr,
    nameEn: s.nameEn,
    categoryKey,
    position: s.position,
    active: s.active,
  };
}
