import { Injectable } from '@nestjs/common';
import type { AssetType } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';

export interface AssetTypeInput {
  key: string;
  nameAr: string;
  nameEn: string;
  categoryId: string;
  expectedLifeYears?: number;
}

export interface AssetTypeUpdate {
  nameAr?: string;
  nameEn?: string;
  categoryId?: string;
  expectedLifeYears?: number | null;
  active?: boolean;
}

export const assetTypeNotFound = () =>
  appError.notFound(ErrorCode.ASSET_TYPE_NOT_FOUND, 'Asset type not found');

/**
 * The compound's kinds of asset (ADR 0064), seeded with defaults, kept
 * like its ticket categories: a key that never changes, the category whose
 * technicians do the work, an expected life. Never deleted (assets point
 * at them); a retired one takes no new asset.
 */
@Injectable()
export class AssetTypesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** Every type, retired ones too (a compound has a few dozen). */
  list(): Promise<AssetType[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.assetType.findMany({ orderBy: [{ key: 'asc' }] }),
    );
  }

  /** A duplicate key is DUPLICATE_RESOURCE on `key` (db-constraints). */
  create(input: AssetTypeInput): Promise<AssetType> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const categoryKey = await this.categoryKey(tx, input.categoryId);
      const type = await tx.assetType.create({
        data: {
          id: newId(),
          tenantId,
          key: input.key,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
          categoryId: input.categoryId,
          expectedLifeYears: input.expectedLifeYears ?? null,
        },
      });
      await this.audit.record(tx, {
        action: 'asset_type.created',
        targetId: type.id,
        changes: diffChanges(
          null,
          audited(type, categoryKey),
          'asset_type.created',
        ),
      });
      return type;
    });
  }

  update(id: string, input: AssetTypeUpdate): Promise<AssetType> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM asset_types WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await tx.assetType.findUnique({ where: { id } });
      if (!before) throw assetTypeNotFound();
      const beforeKey = await this.anyCategoryKey(tx, before.categoryId);
      // A new category must be active; the one it has may be retired.
      const categoryKey =
        input.categoryId !== undefined && input.categoryId !== before.categoryId
          ? await this.categoryKey(tx, input.categoryId)
          : beforeKey;
      const type = await tx.assetType.update({
        where: { id },
        data: {
          nameAr: input.nameAr?.trim(),
          nameEn: input.nameEn?.trim(),
          categoryId: input.categoryId,
          expectedLifeYears: input.expectedLifeYears,
          active: input.active,
        },
      });
      const changes = diffChanges(
        audited(before, beforeKey),
        audited(type, categoryKey),
        'asset_type.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'asset_type.updated',
          targetId: id,
          changes,
        });
      return type;
    });
  }

  /**
   * An active type for a new asset, or a field error on `field`
   * (ASSET_TYPE_NOT_AVAILABLE: unknown, another compound's, retired).
   */
  async requireActive(
    tx: TenantTxClient,
    id: string,
    field = 'typeId',
  ): Promise<AssetType> {
    const type = await tx.assetType.findFirst({ where: { id, active: true } });
    if (!type)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid asset', {
        fields: [{ field, code: FieldErrorCode.ASSET_TYPE_NOT_AVAILABLE }],
      });
    return type;
  }

  private async categoryKey(tx: TenantTxClient, id: string): Promise<string> {
    const category = await tx.ticketCategory.findFirst({
      where: { id, active: true },
      select: { key: true },
    });
    if (!category)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid asset type',
        {
          fields: [
            {
              field: 'categoryId',
              code: FieldErrorCode.CATEGORY_NOT_AVAILABLE,
            },
          ],
        },
      );
    return category.key;
  }

  private async anyCategoryKey(
    tx: TenantTxClient,
    id: string,
  ): Promise<string> {
    return (
      await tx.ticketCategory.findUniqueOrThrow({
        where: { id },
        select: { key: true },
      })
    ).key;
  }
}

/** Keys and numbers; the names as `{ changed: true }` (sensitive). */
function audited(t: AssetType, categoryKey: string) {
  return {
    key: t.key,
    nameAr: t.nameAr,
    nameEn: t.nameEn,
    categoryKey,
    expectedLifeYears: t.expectedLifeYears,
    active: t.active,
  };
}
