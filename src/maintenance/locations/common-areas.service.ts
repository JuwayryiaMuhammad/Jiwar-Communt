import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { CommonArea } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import type { CommonAreaKind } from './area-rules';
import { issueTag } from './tag-tokens';

export const COMMON_AREA_RESOURCE = 'common_area';

export interface CommonAreaInput {
  kind: CommonAreaKind;
  code: string;
  nameAr: string;
  nameEn: string;
  building?: string;
  facilityId?: string;
  latitude?: number;
  longitude?: number;
}

export interface CommonAreaUpdate {
  nameAr?: string;
  nameEn?: string;
  building?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  active?: boolean;
}

export interface CommonAreaQuery {
  kind?: CommonAreaKind;
  active?: 'true' | 'false';
  cursor?: string;
  limit?: number;
}

const PAGE = keysetCursor('createdAt', 'asc');

export const commonAreaNotFound = () =>
  appError.notFound(ErrorCode.COMMON_AREA_NOT_FOUND, 'Common area not found');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid common area', {
    fields,
  });

/**
 * The compound's common areas (ADR 0064): where an asset is when it is
 * not in a unit, and what an inspection walks. Kept with `assets.manage`,
 * read with `assets.read`. Never deleted: assets and plans point at them;
 * a retired one takes nothing new.
 *
 * Writes lock the row (`FOR UPDATE`) and decide by what they read after
 * the lock; a tag is issued under the same lock, so two issues in a race
 * leave the later one valid and the earlier print dead.
 */
@Injectable()
export class CommonAreasService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly community: CommunityMaintenancePort,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(COMMON_AREA_RESOURCE, (id) => this.get(id));
  }

  list(q: CommonAreaQuery): Promise<Page<CommonArea>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.commonArea.findMany({
        where: {
          AND: [
            q.kind ? { kind: q.kind } : {},
            q.active ? { active: q.active === 'true' } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<CommonArea> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const area = await tx.commonArea.findUnique({ where: { id } });
      if (!area) throw commonAreaNotFound();
      return area;
    });
  }

  /**
   * A duplicate code is DUPLICATE_RESOURCE on `code`, a second row for a
   * building on `building`, for a facility on `facilityId`
   * (db-constraints). An unknown facility (or another compound's) is
   * RELATED_RESOURCE_MISSING, by the foreign key.
   */
  create(input: CommonAreaInput): Promise<CommonArea> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: COMMON_AREA_RESOURCE, id });
      const building = input.building?.trim();
      const fields = shapeProblems(input.kind, {
        building: building !== undefined,
        facility: input.facilityId !== undefined,
      });
      if ((input.latitude === undefined) !== (input.longitude === undefined))
        fields.push({
          field: input.latitude === undefined ? 'latitude' : 'longitude',
          code: FieldErrorCode.FIELD_REQUIRED,
        });
      if (fields.length) throw invalid(fields);
      if (building !== undefined) await this.requireBuilding(tx, building);
      const area = await tx.commonArea.create({
        data: {
          id,
          tenantId,
          kind: input.kind,
          code: input.code,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
          building: building ?? null,
          facilityId: input.facilityId ?? null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
        },
      });
      await this.audit.record(tx, {
        action: 'common_area.created',
        targetId: id,
        changes: diffChanges(null, audited(area), 'common_area.created'),
      });
      return area;
    });
  }

  /** The kind, the code and the facility never change. */
  update(id: string, input: CommonAreaUpdate): Promise<CommonArea> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      const fields: FieldError[] = [];
      if (input.building !== undefined && before.kind !== 'area')
        fields.push({
          field: 'building',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
      if ((input.latitude === undefined) !== (input.longitude === undefined))
        fields.push({
          field: input.latitude === undefined ? 'latitude' : 'longitude',
          code: FieldErrorCode.FIELD_REQUIRED,
        });
      else if ((input.latitude === null) !== (input.longitude === null))
        fields.push({ field: 'longitude', code: FieldErrorCode.INVALID_VALUE });
      if (fields.length) throw invalid(fields);
      const building =
        typeof input.building === 'string'
          ? input.building.trim()
          : input.building;
      if (typeof building === 'string' && building !== before.building)
        await this.requireBuilding(tx, building);
      const area = await tx.commonArea.update({
        where: { id },
        data: {
          nameAr: input.nameAr?.trim(),
          nameEn: input.nameEn?.trim(),
          building,
          latitude: input.latitude,
          longitude: input.longitude,
          active: input.active,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(area),
        'common_area.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'common_area.updated',
          targetId: id,
          changes,
        });
      return area;
    });
  }

  /**
   * A new tag for the area, shown once: the previous one stops working in
   * the same commit. Not replayed by an idempotency key (a replay would
   * have to show the secret again): a retry issues another, which is what
   * the caller wanted anyway, the lost one never printed.
   */
  issueTag(id: string): Promise<{ code: string; issuedAt: Date }> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const area = await this.lock(tx, id);
      if (!area.active)
        throw appError.conflict(
          ErrorCode.COMMON_AREA_RETIRED,
          'A retired area gets no tag',
        );
      const tag = issueTag('area', tenantId, id);
      const issuedAt = await dbNow(tx);
      await tx.commonArea.update({
        where: { id },
        data: { tagHash: tag.tokenHash, tagIssuedAt: issuedAt },
      });
      await this.audit.record(tx, {
        action: 'common_area.tag_issued',
        targetId: id,
        metadata: { replaced: area.tagHash !== null },
      });
      return { code: tag.code, issuedAt };
    });
  }

  /**
   * An active area for something new to be placed in (an asset, a plan,
   * an inspection), shared-locked so a retirement waits for the write:
   * COMMON_AREA_NOT_FOUND, or COMMON_AREA_RETIRED.
   */
  async requireActive(tx: TenantTxClient, id: string): Promise<CommonArea> {
    await tx.$queryRaw`SELECT id FROM common_areas WHERE id = ${id}::uuid FOR SHARE`;
    const area = await tx.commonArea.findUnique({ where: { id } });
    if (!area) throw commonAreaNotFound();
    if (!area.active)
      throw appError.conflict(
        ErrorCode.COMMON_AREA_RETIRED,
        'This common area is retired',
      );
    return area;
  }

  private async lock(tx: TenantTxClient, id: string): Promise<CommonArea> {
    await tx.$queryRaw`SELECT id FROM common_areas WHERE id = ${id}::uuid FOR UPDATE`;
    const area = await tx.commonArea.findUnique({ where: { id } });
    if (!area) throw commonAreaNotFound();
    return area;
  }

  private async requireBuilding(
    tx: TenantTxClient,
    building: string,
  ): Promise<void> {
    if (!(await this.community.hasBuilding(tx, building)))
      throw invalid([
        { field: 'building', code: FieldErrorCode.BUILDING_NOT_FOUND },
      ]);
  }
}

/** What each kind needs: a building names one, a facility row its facility. */
export function shapeProblems(
  kind: CommonAreaKind,
  has: { building: boolean; facility: boolean },
): FieldError[] {
  const fields: FieldError[] = [];
  const need = (field: string, present: boolean, wanted: boolean) => {
    if (present && !wanted)
      fields.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
    if (!present && wanted)
      fields.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
  };
  switch (kind) {
    case 'building':
      need('building', has.building, true);
      need('facilityId', has.facility, false);
      break;
    case 'area':
      need('facilityId', has.facility, false);
      break;
    case 'facility':
      need('building', has.building, false);
      need('facilityId', has.facility, true);
      break;
  }
  return fields;
}

/**
 * What the audit trail keeps of an area: codes, the building and the
 * facility; the names are the compound's words and go as `{ changed: true }`
 * (the catalog marks them sensitive). The position is never recorded.
 */
function audited(a: CommonArea) {
  return {
    kind: a.kind,
    code: a.code,
    nameAr: a.nameAr,
    nameEn: a.nameEn,
    building: a.building,
    facilityId: a.facilityId,
    hasPosition: a.latitude !== null,
    active: a.active,
  };
}
