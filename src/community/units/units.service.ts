import { Injectable } from '@nestjs/common';
import type { Prisma, Unit } from '@prisma/client';
import { ResourceAccess } from '../../core/access/resource-access';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { newId } from '../../core/common/uuid';
import { PrismaService } from '../../core/database/prisma.service';
import type { CreateUnitDto } from './dto/create-unit.dto';

const UNIT_PAGE = keysetCursor('createdAt');

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: RequestContext,
    private readonly access: ResourceAccess,
    private readonly tenantTx: TenantTx,
    private readonly audit: AuditService,
  ) {}

  /**
   * Only the units this account may see (ResourceAccess, ADR 0012), newest
   * first, a page at a time.
   */
  async list(q: { cursor?: string; limit?: number } = {}): Promise<Page<Unit>> {
    const limit = clampLimit(q.limit);
    const rows = await this.prisma.tenant.unit.findMany({
      where: {
        AND: [
          this.access.unitScope(),
          ...(UNIT_PAGE.after(q.cursor) as Prisma.UnitWhereInput[]),
        ],
      },
      orderBy: UNIT_PAGE.orderBy,
      take: limit + 1,
    });
    return UNIT_PAGE.toPage(rows, limit);
  }

  /** The unit and its audit entry commit together (ADR 0014). */
  async create(dto: CreateUnitDto): Promise<Unit> {
    const tenantId = this.ctx.tenantId;
    const unit = await this.tenantTx.withTenantTx(async (tx) => {
      const created = await tx.unit.create({
        data: {
          id: newId(),
          tenantId,
          code: dto.code.trim(),
          building: dto.building?.trim() ?? null,
          floor: dto.floor ?? null,
        },
      });
      await this.audit.record(tx, {
        action: 'unit.created',
        targetId: created.id,
        changes: diffChanges(
          null,
          {
            code: created.code,
            building: created.building,
            floor: created.floor,
          },
          'unit.created',
        ),
      });
      return created;
    });
    return unit;
  }
}
