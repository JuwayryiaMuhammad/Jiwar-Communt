import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { PartnerSubcategory } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { PARTNER_CATEGORIES, type PartnerCategory } from '../categories';
import { PartnerSettingsService } from '../settings/partner-settings.service';
import { StaffPartnerSubcategoryView } from './views/subcategory.views';

export const PARTNER_SUBCATEGORY_RESOURCE = 'partner_subcategory';

/** Sub-categories a compound may name, retired ones included. */
export const MAX_SUBCATEGORIES = 200;

export interface NewSubcategory {
  category: PartnerCategory;
  key: string;
  nameEn: string;
  nameAr: string;
  position?: number;
}

export interface SubcategoryChange {
  nameEn?: string;
  nameAr?: string;
  position?: number;
  active?: boolean;
}

/** A category of the closed list with the compound's active sub-categories. */
export interface CategoryWithSubcategories {
  category: PartnerCategory;
  subcategories: PartnerSubcategory[];
}

export const subcategoryNotFound = () =>
  appError.notFound(
    ErrorCode.PARTNER_SUBCATEGORY_NOT_FOUND,
    'Sub-category not found',
  );

/** What the audit trail records: the key, category, state and order by value; names as changed. */
const audited = (s: PartnerSubcategory) => ({
  category: s.category,
  key: s.key,
  active: s.active,
  position: s.position,
  nameEn: s.nameEn,
  nameAr: s.nameAr,
});

function name(field: string, value: string, errors: FieldError[]): string {
  const text = value.trim();
  if (!text) errors.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
  return text;
}

const ORDER = [
  { category: 'asc' },
  { position: 'asc' },
  { key: 'asc' },
] as const;

/**
 * The compound's named sub-categories under the closed categories (ADR
 * 0060): its own data, seeded with the compound. Managed with
 * `partners.manage`; residents read the active ones. A key and its
 * category never change (trigger); a retired one stays on the partners
 * that named it and is offered for nothing new.
 */
@Injectable()
export class SubcategoriesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly settings: PartnerSettingsService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(PARTNER_SUBCATEGORY_RESOURCE, async (id) =>
      StaffPartnerSubcategoryView.from(
        await this.tenantTx.withTenantTx((tx) => this.inTx(tx, id)),
      ),
    );
  }

  async inTx(tx: TenantTxClient, id: string): Promise<PartnerSubcategory> {
    const found = await tx.partnerSubcategory.findUnique({ where: { id } });
    if (!found) throw subcategoryNotFound();
    return found;
  }

  /** Every sub-category, retired ones included: the staff's list. */
  staffList(): Promise<PartnerSubcategory[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.partnerSubcategory.findMany({ orderBy: [...ORDER] }),
    );
  }

  /** The closed list in its order, each with its active sub-categories. */
  categories(): Promise<CategoryWithSubcategories[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.partnerSubcategory.findMany({
        where: { active: true },
        orderBy: [...ORDER],
      });
      return PARTNER_CATEGORIES.map((category) => ({
        category,
        subcategories: rows.filter((r) => r.category === category),
      }));
    });
  }

  /**
   * The active sub-categories among `ids`, by id: what a partner may be
   * given. Unknown, retired and another compound's are absent.
   */
  async active(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<Map<string, PartnerSubcategory>> {
    if (!ids.length) return new Map();
    const rows = await tx.partnerSubcategory.findMany({
      where: { id: { in: [...new Set(ids)] }, active: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * A new sub-category under a category. Its key is unique in the compound
   * (DUPLICATE_RESOURCE on `key`); the count is taken under the settings
   * row's lock, so two creations cannot both pass the cap.
   */
  create(input: NewSubcategory): Promise<PartnerSubcategory> {
    const errors: FieldError[] = [];
    const nameEn = name('nameEn', input.nameEn, errors);
    const nameAr = name('nameAr', input.nameAr, errors);
    if (errors.length) throw invalid(errors);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, {
        type: PARTNER_SUBCATEGORY_RESOURCE,
        id,
      });
      await this.settings.lockForUpdate(tx);
      if ((await tx.partnerSubcategory.count()) >= MAX_SUBCATEGORIES)
        throw appError.conflict(
          ErrorCode.PARTNER_SUBCATEGORY_LIMIT_REACHED,
          'The compound names as many sub-categories as it may',
          { params: { max: MAX_SUBCATEGORIES } },
        );
      const created = await tx.partnerSubcategory.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          category: input.category,
          key: input.key,
          nameEn,
          nameAr,
          position: input.position ?? 0,
        },
      });
      await this.audit.record(tx, {
        action: 'partner_subcategory.created',
        targetId: id,
        changes: diffChanges(
          null,
          audited(created),
          'partner_subcategory.created',
        ),
      });
      return created;
    });
  }

  /** Names, order and state; never the key or the category. */
  update(id: string, input: SubcategoryChange): Promise<PartnerSubcategory> {
    const errors: FieldError[] = [];
    const nameEn =
      input.nameEn === undefined
        ? undefined
        : name('nameEn', input.nameEn, errors);
    const nameAr =
      input.nameAr === undefined
        ? undefined
        : name('nameAr', input.nameAr, errors);
    if (errors.length) throw invalid(errors);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM partner_subcategories WHERE id = ${id}::uuid FOR UPDATE`;
      if (!rows.length) throw subcategoryNotFound();
      const before = await this.inTx(tx, id);
      const after = await tx.partnerSubcategory.update({
        where: { id },
        data: {
          nameEn,
          nameAr,
          position: input.position,
          active: input.active,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(after),
        'partner_subcategory.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'partner_subcategory.updated',
          targetId: id,
          changes,
        });
      return after;
    });
  }
}
