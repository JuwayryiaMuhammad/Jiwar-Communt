import { Injectable } from '@nestjs/common';
import type { TicketCategory, TicketPriority } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';

export interface CategoryInput {
  key: string;
  nameAr: string;
  nameEn: string;
  defaultPriority?: TicketPriority;
  commonAreaAllowed?: boolean;
}

export type CategoryUpdate = Partial<
  Pick<
    TicketCategory,
    'nameAr' | 'nameEn' | 'defaultPriority' | 'commonAreaAllowed' | 'active'
  >
>;

export const categoryNotFound = () =>
  appError.notFound(
    ErrorCode.TICKET_CATEGORY_NOT_FOUND,
    'Ticket category not found',
  );

/** What the audit trail records of a category: its own, non-personal fields. */
function audited(c: TicketCategory) {
  return {
    key: c.key,
    nameAr: c.nameAr,
    nameEn: c.nameEn,
    defaultPriority: c.defaultPriority,
    commonAreaAllowed: c.commonAreaAllowed,
    active: c.active,
  };
}

/**
 * The compound's ticket categories (ADR 0032): its own data, managed with
 * `maintenance.manage`. Never deleted, because tickets point at them; a
 * retired category is `active: false` and no longer offered.
 */
@Injectable()
export class CategoriesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** Every category, retired ones included (a compound has a handful). */
  list(): Promise<TicketCategory[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.ticketCategory.findMany({ orderBy: [{ key: 'asc' }] }),
    );
  }

  /** What a ticket may be opened under. */
  options(): Promise<TicketCategory[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.ticketCategory.findMany({
        where: { active: true },
        orderBy: [{ key: 'asc' }],
      }),
    );
  }

  /** A duplicate key is DUPLICATE_RESOURCE on `key` (db-constraints). */
  create(input: CategoryInput): Promise<TicketCategory> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const category = await tx.ticketCategory.create({
        data: {
          id: newId(),
          tenantId,
          key: input.key,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
          defaultPriority: input.defaultPriority,
          commonAreaAllowed: input.commonAreaAllowed,
        },
      });
      await this.audit.record(tx, {
        action: 'ticket_category.created',
        targetId: category.id,
        changes: diffChanges(
          null,
          audited(category),
          'ticket_category.created',
        ),
      });
      return category;
    });
  }

  /** The key never changes: apps and reports may hold on to it. */
  update(id: string, input: CategoryUpdate): Promise<TicketCategory> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await tx.ticketCategory.findUnique({ where: { id } });
      if (!before) throw categoryNotFound();
      const category = await tx.ticketCategory.update({
        where: { id },
        data: {
          nameAr: input.nameAr?.trim(),
          nameEn: input.nameEn?.trim(),
          defaultPriority: input.defaultPriority,
          commonAreaAllowed: input.commonAreaAllowed,
          active: input.active,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(category),
        'ticket_category.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'ticket_category.updated',
          targetId: category.id,
          changes,
        });
      return category;
    });
  }
}
