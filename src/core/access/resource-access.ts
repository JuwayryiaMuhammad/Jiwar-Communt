import { Injectable } from '@nestjs/common';
import type { Prisma, Unit } from '@prisma/client';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { PermissionsService } from './permissions.service';

/**
 * Resource layer of authorization (ADR 0001, 0012): which units the current
 * account may see, on top of RLS (tenant) and permissions (role).
 *
 * - manager: every unit of the compound;
 * - resident: only units with an ACTIVE occupancy — ending one removes
 *   access on the next request;
 * - family: only units with an ACTIVE household membership (ADR 0016) —
 *   pending and removed members see nothing;
 * - anyone else: none.
 *
 * Failing the check is "not found", never "forbidden", so unit ids are not
 * confirmed to people who cannot see them.
 *
 * The units' list alone (`listScope`) also gives a staff role holding
 * `units.directory` every unit; nothing else widens with it.
 */
@Injectable()
export class ResourceAccess {
  constructor(
    private readonly ctx: RequestContext,
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /** A `where` filter to AND into every unit query. */
  unitScope(): Prisma.UnitWhereInput {
    switch (this.ctx.accountType) {
      case 'manager':
        return {};
      case 'resident':
        return {
          occupancies: {
            some: { accountId: this.ctx.accountId, status: 'active' },
          },
        };
      case 'family':
        return {
          householdMembers: {
            some: { accountId: this.ctx.accountId, status: 'active' },
          },
        };
      default:
        return { id: { in: [] } };
    }
  }

  /**
   * The units' list (`GET /units`): `unitScope()`, or every unit for a staff
   * role holding `units.directory`. Never for `assertUnit`: a unit's own
   * routes stay its people's and the management's.
   */
  async listScope(): Promise<Prisma.UnitWhereInput> {
    if (
      this.ctx.accountType === 'staff' &&
      (await this.permissions.has('units.directory'))
    )
      return {};
    return this.unitScope();
  }

  async assertUnit(unitId: string): Promise<Unit> {
    const unit = await this.prisma.tenant.unit.findFirst({
      where: { AND: [{ id: unitId }, this.unitScope()] },
    });
    if (!unit)
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    return unit;
  }
}
