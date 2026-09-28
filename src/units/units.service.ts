import { Injectable, NotFoundException } from '@nestjs/common';
import { RequestContext } from '../common/cls/request-context';
import { ErrorCode } from '../common/errors';
import { newId } from '../common/uuid';
import { PrismaService } from '../database/prisma.service';
import type { CreateUnitDto } from './dto/create-unit.dto';
import { UnitView } from './dto/unit.view';

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: RequestContext,
  ) {}

  async list(): Promise<UnitView[]> {
    const units = await this.prisma.tenant.unit.findMany({
      orderBy: { code: 'asc' },
    });
    return units.map((u) => UnitView.from(u));
  }

  async get(id: string): Promise<UnitView> {
    const unit = await this.prisma.tenant.unit.findUnique({ where: { id } });
    if (!unit) {
      throw new NotFoundException({
        message: 'Unit not found',
        code: ErrorCode.NOT_FOUND,
      });
    }
    return UnitView.from(unit);
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
