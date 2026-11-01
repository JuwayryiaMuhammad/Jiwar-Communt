import { Injectable } from '@nestjs/common';
import type { Building } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';

export const BUILDING_NAME_LENGTH = { min: 1, max: 64 } as const;

export interface BuildingRead extends Building {
  /** How many units name it now. */
  units: number;
}

export const buildingNotFound = () =>
  appError.notFound(ErrorCode.BUILDING_NOT_FOUND, 'Building not found');

/**
 * The compound's buildings (ADR 0072): a name its units carry, given an id.
 * A unit created with a new name brings its building (a trigger keeps
 * `units.building` and `units.building_id` in step); the manager may add one
 * ahead of its units and delete one no unit names. Never renamed: audiences,
 * partners' service areas and governance keep the name itself.
 */
@Injectable()
export class BuildingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** Every building, by name, with its count of units. */
  list(): Promise<BuildingRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.building.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        include: { _count: { select: { units: true } } },
      });
      return rows.map(({ _count, ...b }) => ({ ...b, units: _count.units }));
    });
  }

  create(rawName: string): Promise<BuildingRead> {
    const name = rawName.trim();
    return this.tenantTx.withTenantTx(async (tx) => {
      if (
        await tx.building.findFirst({ where: { name }, select: { id: true } })
      )
        throw nameTaken();
      const created = await tx.building.create({
        data: { id: newId(), tenantId: this.ctx.tenantId, name },
      });
      await this.audit.record(tx, {
        action: 'building.created',
        targetId: created.id,
        metadata: { name },
      });
      return { ...created, units: 0 };
    });
  }

  /**
   * Under the building's row lock, so no unit is moved into it between the
   * count and the delete (a unit's move takes it FOR KEY SHARE first).
   */
  remove(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM buildings WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked.length) throw buildingNotFound();
      const units = await tx.unit.count({ where: { buildingId: id } });
      if (units)
        throw appError.conflict(
          ErrorCode.BUILDING_IN_USE,
          'Units name this building',
          { params: { units } },
        );
      const gone = await tx.building.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'building.deleted',
        targetId: id,
        metadata: { name: gone.name },
      });
    });
  }
}

/**
 * The building a unit is put in, held FOR KEY SHARE for the rest of the
 * transaction: a delete waits, then finds the unit and refuses.
 */
export async function holdBuilding(
  tx: TenantTxClient,
  id: string,
): Promise<{ id: string; name: string }> {
  const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM buildings WHERE id = ${id}::uuid FOR KEY SHARE`;
  if (!rows.length) throw buildingNotFound();
  return rows[0];
}

const nameTaken = () =>
  appError.conflict(
    ErrorCode.BUILDING_NAME_TAKEN,
    'The compound has a building of this name',
  );
