import { Injectable } from '@nestjs/common';
import { ResourceAccess } from '../access/resource-access';
import { RequestContext } from '../common/cls/request-context';
import { newId } from '../common/uuid';
import { PrismaService } from '../database/prisma.service';
import type { CreateUnitDto } from './dto/create-unit.dto';
import { UnitView } from './dto/unit.view';

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: RequestContext,
    private readonly access: ResourceAccess,
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

  async create(dto: CreateUnitDto): Promise<UnitView> {
    const unit = await this.prisma.tenant.unit.create({
      data: {
        id: newId(),
        tenantId: this.ctx.tenantId,
        code: dto.code.trim(),
        building: dto.building?.trim() ?? null,
        floor: dto.floor ?? null,
      },
    });
    return UnitView.from(unit);
  }
}
