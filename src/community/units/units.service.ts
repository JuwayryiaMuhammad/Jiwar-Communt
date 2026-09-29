import { Injectable } from '@nestjs/common';
import { ResourceAccess } from '../../core/access/resource-access';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { newId } from '../../core/common/uuid';
import { PrismaService } from '../../core/database/prisma.service';
import type { CreateUnitDto } from './dto/create-unit.dto';
import { UnitView } from './dto/unit.view';

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: RequestContext,
    private readonly access: ResourceAccess,
    private readonly tenantTx: TenantTx,
    private readonly audit: AuditService,
  ) {}

  /** Only the units this account may see (ResourceAccess, ADR 0012). */
  async list(): Promise<UnitView[]> {
    const units = await this.prisma.tenant.unit.findMany({
      where: this.access.unitScope(),
      orderBy: { code: 'asc' },
    });
    return units.map((u) => UnitView.from(u));
  }

  /** Not found for units outside the account's scope, not forbidden. */
  async get(id: string): Promise<UnitView> {
    return UnitView.from(await this.access.assertUnit(id));
  }

  /** The unit and its audit entry commit together (ADR 0014). */
  async create(dto: CreateUnitDto): Promise<UnitView> {
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
    return UnitView.from(unit);
  }
}
