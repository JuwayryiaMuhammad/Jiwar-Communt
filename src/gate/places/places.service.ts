import { Injectable } from '@nestjs/common';
import type { Place } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { ShiftsService } from '../shifts/shifts.service';
import { MAX_PLACES } from './default-places';

export const placeNotFound = () =>
  appError.notFound(ErrorCode.PLACE_NOT_FOUND, 'Place not found');

const ORDER = [{ position: 'asc' as const }, { id: 'asc' as const }];

/** What the audit sees of a place: its key, order and state; names as changed. */
function audited(p: Place) {
  return {
    key: p.key,
    nameEn: p.nameEn,
    nameAr: p.nameAr,
    position: p.position,
    active: p.active,
  };
}

/**
 * The compound's places (ADR 0047): where a resident asks security to meet
 * them, walk with them or look. Every compound starts with the seven of
 * the mobile contract (`key`); the manager (`gate.manage`) renames,
 * orders, retires and adds their own. A place is never deleted: requests
 * point at it. Two places in service never share a name (a unique index;
 * 409 DUPLICATE_RESOURCE).
 */
@Injectable()
export class PlacesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly shifts: ShiftsService,
  ) {}

  /** The places in service, in the manager's order: what an app offers. */
  active(): Promise<Place[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.place.findMany({ where: { active: true }, orderBy: ORDER }),
    );
  }

  /** Every place, retired ones too: the manager's list. */
  all(): Promise<Place[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.place.findMany({ orderBy: ORDER, take: MAX_PLACES }),
    );
  }

  create(input: {
    nameEn: string;
    nameAr: string;
    position?: number;
  }): Promise<Place> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const place = await tx.place.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          nameEn: input.nameEn.trim(),
          nameAr: input.nameAr.trim(),
          position: input.position ?? 0,
        },
      });
      await this.audit.record(tx, {
        action: 'place.created',
        targetId: place.id,
        changes: diffChanges(null, audited(place), 'place.created'),
      });
      return place;
    });
  }

  update(
    id: string,
    input: {
      nameEn?: string;
      nameAr?: string;
      position?: number;
      active?: boolean;
    },
  ): Promise<Place> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await tx.place.findUnique({ where: { id } });
      if (!before) throw placeNotFound();
      const place = await tx.place.update({
        where: { id },
        data: {
          nameEn: input.nameEn?.trim(),
          nameAr: input.nameAr?.trim(),
          position: input.position,
          active: input.active,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(place),
        'place.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'place.updated',
          targetId: id,
          changes,
        });
      // A zone retired ends the shifts in it, as a gate deactivated does
      // (ADR 0050). A start reads the place FOR SHARE: it finished before
      // and its shift is ended here, or it waits and finds it retired.
      if (before.active && !place.active)
        await this.shifts.endAllInZone(tx, id, 'place_retired');
      return place;
    });
  }

  /**
   * A place a request may name: in service, read FOR SHARE so a retirement
   * waits for the request that names it. Null when `id` is null.
   */
  async requireActive(
    tx: TenantTxClient,
    id: string | null | undefined,
    field: string,
  ): Promise<string | null> {
    if (!id) return null;
    const rows = await tx.$queryRaw<{ active: boolean }[]>`
      SELECT active FROM places WHERE id = ${id}::uuid FOR SHARE`;
    if (!rows[0]?.active)
      throw appError.notFound(ErrorCode.PLACE_NOT_FOUND, 'Place not found', {
        params: { field },
      });
    return id;
  }
}
