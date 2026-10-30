import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { appError, ErrorCode } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { TicketAccess } from '../tickets/ticket-access';
import { unionOf, type Hazard } from './safety-rules';

/**
 * What needs a work permit (ADR 0067): the hazards of a ticket category's
 * work, set with `maintenance.manage`, and of an asset type's, set with
 * `assets.manage`. A ticket's work needs a permit for both its category's
 * and its asset type's. The whole list is replaced, under the row's lock.
 */
@Injectable()
export class WorkHazardsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly access: TicketAccess,
    private readonly audit: AuditService,
  ) {}

  setForCategory(id: string, hazards: Hazard[]): Promise<Hazard[]> {
    const next = unionOf(hazards);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`SELECT id FROM ticket_categories WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await tx.ticketCategory.findUnique({ where: { id } });
      if (!before)
        throw appError.notFound(
          ErrorCode.TICKET_CATEGORY_NOT_FOUND,
          'Category not found',
        );
      if (sameList(before.requiresPermit, next)) return next;
      await tx.ticketCategory.update({
        where: { id },
        data: { requiresPermit: next },
      });
      await this.audit.record(tx, {
        action: 'ticket_category.permit_hazards_changed',
        targetId: id,
        changes: { requiresPermit: { from: before.requiresPermit, to: next } },
      });
      return next;
    });
  }

  setForAssetType(id: string, hazards: Hazard[]): Promise<Hazard[]> {
    const next = unionOf(hazards);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`SELECT id FROM asset_types WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await tx.assetType.findUnique({ where: { id } });
      if (!before)
        throw appError.notFound(
          ErrorCode.ASSET_TYPE_NOT_FOUND,
          'Asset type not found',
        );
      if (sameList(before.requiresPermit, next)) return next;
      await tx.assetType.update({
        where: { id },
        data: { requiresPermit: next },
      });
      await this.audit.record(tx, {
        action: 'asset_type.permit_hazards_changed',
        targetId: id,
        changes: { requiresPermit: { from: before.requiresPermit, to: next } },
      });
      return next;
    });
  }
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
