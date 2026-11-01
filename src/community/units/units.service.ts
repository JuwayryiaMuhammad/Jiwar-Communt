import { Injectable } from '@nestjs/common';
import { Prisma, type Unit } from '@prisma/client';
import { PermissionsService } from '../../core/access/permissions.service';
import { ResourceAccess } from '../../core/access/resource-access';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  ExportLimit,
  exportTooLarge,
  toCsv,
  type CsvColumn,
} from '../../core/common/csv';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { newId } from '../../core/common/uuid';
import { PrismaService } from '../../core/database/prisma.service';
import { holdBuilding } from './buildings.service';
import type { CreateUnitDto } from './dto/create-unit.dto';
import type { UnitFiltersDto, UnitState } from './dto/units-query.dto';
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
    private readonly permissions: PermissionsService,
    private readonly exportLimit: ExportLimit,
  ) {}

  /**
   * Only the units this account may list (ResourceAccess, ADR 0012), newest
   * first, a page at a time; narrowed by the register's filters (ADR 0072).
   */
  async list(
    q: UnitFiltersDto & { cursor?: string; limit?: number } = {},
  ): Promise<Page<Unit>> {
    const limit = clampLimit(q.limit);
    const rows = await this.prisma.tenant.unit.findMany({
      where: {
        AND: [
          await this.access.listScope(),
          ...(await this.filters(q)),
          ...(UNIT_PAGE.after(q.cursor) as Prisma.UnitWhereInput[]),
        ],
      },
      orderBy: UNIT_PAGE.orderBy,
      take: limit + 1,
    });
    return UNIT_PAGE.toPage(rows, limit);
  }

  /**
   * The register as CSV (ADR 0072): every unit the filters keep, by code,
   * with its building, floor, type, area, where it stands and how many hold
   * a place in it as owners, as tenants and living there. Counts, never
   * names. At most ExportLimit.maxRows (EXPORT_TOO_LARGE).
   */
  async csv(q: UnitFiltersDto): Promise<Buffer> {
    // Outside the transaction: the permission check reads on its own.
    const where = await this.filters(q);
    return this.tenantTx.withTenantTx(async (tx) => {
      const max = this.exportLimit.maxRows;
      const units = await tx.unit.findMany({
        where: { AND: where },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        take: max + 1,
        include: {
          occupancies: {
            where: { status: 'active' },
            select: { occupancyType: true, resides: true },
          },
        },
      });
      if (units.length > max) throw exportTooLarge(max);
      return toCsv(
        UNIT_COLUMNS,
        units.map((u) => {
          const count = (f: (o: (typeof u.occupancies)[number]) => boolean) =>
            String(u.occupancies.filter(f).length);
          return [
            u.code,
            u.building,
            u.floor === null ? null : String(u.floor),
            u.unitType,
            u.areaSqm?.toFixed(2) ?? null,
            stateOf(u, u.occupancies.length),
            count((o) => o.occupancyType === 'owner'),
            count((o) => o.occupancyType === 'tenant'),
            count((o) => o.resides),
          ];
        }),
      );
    });
  }

  /**
   * The filters as conditions. Where a unit stands and who holds it are
   * the manager's to ask (units.manage): a staff role listing the units
   * (`units.directory`) sees codes, buildings and floors, never people.
   */
  private async filters(q: UnitFiltersDto): Promise<Prisma.UnitWhereInput[]> {
    const out: Prisma.UnitWhereInput[] = [];
    if (q.q) out.push({ code: { contains: q.q.trim(), mode: 'insensitive' } });
    if (q.buildingId) out.push({ buildingId: q.buildingId });
    if (q.status !== undefined || q.occupancyType !== undefined) {
      if (!(await this.permissions.has('units.manage')))
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Filter not allowed',
          {
            fields: [
              ...(q.status !== undefined ? ['status'] : []),
              ...(q.occupancyType !== undefined ? ['occupancyType'] : []),
            ].map((field) => ({
              field,
              code: FieldErrorCode.FIELD_NOT_ALLOWED,
            })),
          },
        );
    }
    const active = { status: 'active' } as const;
    if (q.status === 'closed') out.push({ closedSince: { not: null } });
    if (q.status === 'occupied')
      out.push({ closedSince: null, occupancies: { some: active } });
    if (q.status === 'vacant')
      out.push({ closedSince: null, occupancies: { none: active } });
    if (q.occupancyType)
      out.push({
        occupancies: { some: { ...active, occupancyType: q.occupancyType } },
      });
    return out;
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

const UNIT_COLUMNS: readonly CsvColumn[] = [
  { header: 'code', kind: 'text' },
  { header: 'building', kind: 'text' },
  { header: 'floor', kind: 'number' },
  { header: 'unit_type', kind: 'text' },
  { header: 'area_sqm', kind: 'number' },
  { header: 'status', kind: 'text' },
  { header: 'owners', kind: 'number' },
  { header: 'tenants', kind: 'number' },
  { header: 'residing', kind: 'number' },
];

/** Closed-unit mode first, then anyone's place in it. */
export const stateOf = (
  u: Pick<Unit, 'closedSince'>,
  activeOccupancies: number,
): UnitState =>
  u.closedSince !== null
    ? 'closed'
    : activeOccupancies > 0
      ? 'occupied'
      : 'vacant';
