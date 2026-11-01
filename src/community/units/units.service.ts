import { Injectable } from '@nestjs/common';
import { Prisma, type Unit } from '@prisma/client';
import { ResourceAccess } from '../../core/access/resource-access';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { newId } from '../../core/common/uuid';
import { PrismaService } from '../../core/database/prisma.service';
import { holdBuilding } from './buildings.service';
import type { CreateUnitDto } from './dto/create-unit.dto';
import type { UpdateUnitDto } from './dto/update-unit.dto';
import { lockUnits } from './unit-lock';

const UNIT_PAGE = keysetCursor('createdAt');

/** What the register shows and the audit compares of a unit. */
export const registerFacts = (u: Unit) => ({
  building: u.building,
  floor: u.floor,
  unitType: u.unitType,
  areaSqm: u.areaSqm?.toFixed(2) ?? null,
});

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
   * Only the units this account may list (ResourceAccess, ADR 0012), newest
   * first, a page at a time.
   */
  async list(q: { cursor?: string; limit?: number } = {}): Promise<Page<Unit>> {
    const limit = clampLimit(q.limit);
    const rows = await this.prisma.tenant.unit.findMany({
      where: {
        AND: [
          await this.access.listScope(),
          ...(UNIT_PAGE.after(q.cursor) as Prisma.UnitWhereInput[]),
        ],
      },
      orderBy: UNIT_PAGE.orderBy,
      take: limit + 1,
    });
    return UNIT_PAGE.toPage(rows, limit);
  }

  /**
   * The unit and its audit entry commit together (ADR 0014). A building by
   * id is held FOR KEY SHARE; by name, the trigger finds it or adds it.
   */
  async create(dto: CreateUnitDto): Promise<Unit> {
    if (dto.building !== undefined && dto.buildingId !== undefined)
      throw onlyOne();
    const area = checkedArea(dto.areaSqm);
    const tenantId = this.ctx.tenantId;
    const unit = await this.tenantTx.withTenantTx(async (tx) => {
      if (dto.buildingId) await holdBuilding(tx, dto.buildingId);
      const created = await tx.unit.create({
        data: {
          id: newId(),
          tenantId,
          code: dto.code.trim(),
          building: dto.building?.trim() ?? null,
          buildingId: dto.buildingId ?? null,
          floor: dto.floor ?? null,
          unitType: dto.unitType ?? null,
          areaSqm: area,
        },
      });
      await this.audit.record(tx, {
        action: 'unit.created',
        targetId: created.id,
        changes: diffChanges(
          null,
          { code: created.code, ...registerFacts(created) },
          'unit.created',
        ),
      });
      return created;
    });
    return unit;
  }

  /**
   * The manager's edit (ADR 0072): building, floor, type and area, never
   * the code. Under the unit's lock (as everything that changes a unit),
   * the new building held FOR KEY SHARE; audited with what changed.
   */
  async update(id: string, dto: UpdateUnitDto): Promise<Unit> {
    const area =
      dto.areaSqm === undefined ? undefined : checkedArea(dto.areaSqm);
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [id]);
      const before = await tx.unit.findUniqueOrThrow({ where: { id } });
      if (dto.buildingId) await holdBuilding(tx, dto.buildingId);
      const data: Prisma.UnitUncheckedUpdateInput = {};
      if (dto.buildingId !== undefined) data.buildingId = dto.buildingId;
      if (dto.floor !== undefined) data.floor = dto.floor;
      if (dto.unitType !== undefined) data.unitType = dto.unitType;
      if (area !== undefined) data.areaSqm = area;
      const after = await tx.unit.update({ where: { id }, data });
      const changes = diffChanges(
        registerFacts(before),
        registerFacts(after),
        'unit.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'unit.updated',
          targetId: id,
          changes,
        });
      return after;
    });
  }
}

/** A decimal string above zero, or null; undefined passes through. */
function checkedArea(
  raw: string | null | undefined,
): Prisma.Decimal | null | undefined {
  if (raw === undefined || raw === null) return raw;
  const area = new Prisma.Decimal(raw);
  if (area.lte(0))
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid area', {
      fields: [{ field: 'areaSqm', code: FieldErrorCode.INVALID_NUMBER }],
    });
  return area;
}

const onlyOne = () =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'A building once', {
    fields: [{ field: 'buildingId', code: FieldErrorCode.FIELD_NOT_ALLOWED }],
  });
