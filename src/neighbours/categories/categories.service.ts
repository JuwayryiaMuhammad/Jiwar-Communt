import { Injectable } from '@nestjs/common';
import type { NeighbourComplaintCategory } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';

export interface ComplaintCategoryInput {
  key: string;
  nameAr: string;
  nameEn: string;
}

export type ComplaintCategoryUpdate = Partial<
  Pick<NeighbourComplaintCategory, 'nameAr' | 'nameEn' | 'active'>
>;

export const complaintCategoryNotFound = () =>
  appError.notFound(
    ErrorCode.NEIGHBOUR_COMPLAINT_CATEGORY_NOT_FOUND,
    'Complaint category not found',
  );

/**
 * What the audit trail records of a category: its key and state by value,
 * the names as "changed" only (the action marks them sensitive).
 */
function audited(c: NeighbourComplaintCategory) {
  return { key: c.key, nameAr: c.nameAr, nameEn: c.nameEn, active: c.active };
}

/**
 * The compound's complaint categories (ADR 0042): its own closed list,
 * managed with `neighbours.manage`. Never deleted, because complaints and
 * notices point at them; a retired category is `active: false` and no
 * longer offered.
 */
@Injectable()
export class ComplaintCategoriesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** Every category, retired ones included (a compound has a handful). */
  list(): Promise<NeighbourComplaintCategory[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.neighbourComplaintCategory.findMany({ orderBy: [{ key: 'asc' }] }),
    );
  }

  /** What a complaint may be filed under. */
  options(): Promise<NeighbourComplaintCategory[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.neighbourComplaintCategory.findMany({
        where: { active: true },
        orderBy: [{ key: 'asc' }],
      }),
    );
  }

  /** A duplicate key is DUPLICATE_RESOURCE on `key` (db-constraints). */
  create(input: ComplaintCategoryInput): Promise<NeighbourComplaintCategory> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const category = await tx.neighbourComplaintCategory.create({
        data: {
          id: newId(),
          tenantId,
          key: input.key,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
        },
      });
      await this.audit.record(tx, {
        action: 'neighbour_complaint_category.created',
        targetId: category.id,
        changes: diffChanges(
          null,
          audited(category),
          'neighbour_complaint_category.created',
        ),
      });
      return category;
    });
  }

  /** The key never changes: apps and reports may hold on to it. */
  update(
    id: string,
    input: ComplaintCategoryUpdate,
  ): Promise<NeighbourComplaintCategory> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await tx.neighbourComplaintCategory.findUnique({
        where: { id },
      });
      if (!before) throw complaintCategoryNotFound();
      const category = await tx.neighbourComplaintCategory.update({
        where: { id },
        data: {
          nameAr: input.nameAr?.trim(),
          nameEn: input.nameEn?.trim(),
          active: input.active,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(category),
        'neighbour_complaint_category.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'neighbour_complaint_category.updated',
          targetId: category.id,
          changes,
        });
      return category;
    });
  }
}
