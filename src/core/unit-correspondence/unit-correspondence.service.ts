import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PermissionsService } from '../access/permissions.service';
import { AuditService } from '../audit/audit.service';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { appError, ErrorCode } from '../common/errors';
import { TenantTx } from '../database/tenant-tx.service';
import {
  newestFirst,
  UnitCorrespondence,
  type CorrespondenceRow,
  type CorrespondenceType,
} from './unit-correspondence';

const PAGE = keysetCursor('at');

/**
 * A unit's one timeline (ADR 0080, `correspondence.read`): every registered
 * source the caller holds the list permission of, merged newest first on
 * one keyset of the time and the row's id. It shows who wrote to whom
 * about the unit, which is personal: each read is logged
 * (`unit.correspondence_read`, the unit and how many rows; never what they
 * are).
 */
@Injectable()
export class UnitCorrespondenceService implements OnApplicationBootstrap {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly registry: UnitCorrespondence,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap(): void {
    const missing = this.registry.missing();
    if (missing.length)
      throw new Error(
        `No correspondence source for ${missing.join(', ')} (ADR 0080)`,
      );
  }

  async list(
    unitId: string,
    q: { type?: CorrespondenceType; cursor?: string; limit?: number },
  ): Promise<Page<CorrespondenceRow>> {
    const limit = clampLimit(q.limit);
    const before = q.cursor ? PAGE.decode(q.cursor) : null;
    const held = await this.permissions.current();
    const sources = this.registry
      .all()
      .filter((s) => (!q.type || s.type === q.type) && held.has(s.permission));
    return this.tenantTx.withTenantTx(async (tx) => {
      const unit = await tx.unit.findUnique({
        where: { id: unitId },
        select: { id: true },
      });
      if (!unit)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const rows: CorrespondenceRow[] = [];
      for (const s of sources)
        rows.push(...(await s.page(tx, unitId, { before, take: limit + 1 })));
      rows.sort(newestFirst);
      const page = PAGE.toPage(rows, limit);
      await this.audit.record(tx, {
        action: 'unit.correspondence_read',
        targetId: unitId,
        metadata: {
          rows: page.items.length,
          ...(q.type ? { type: q.type } : {}),
        },
      });
      return page;
    });
  }
}
