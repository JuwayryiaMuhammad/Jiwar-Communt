import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { ChecklistTemplate, ChecklistTemplateItem } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import {
  itemProblems,
  type ChecklistPurpose,
  type ItemInput,
} from './checklist-rules';

export const CHECKLIST_RESOURCE = 'checklist_template';

export interface ChecklistInput {
  key: string;
  nameAr: string;
  nameEn: string;
  purpose: ChecklistPurpose;
  requireScan?: boolean;
  items: ItemInput[];
}

export interface ChecklistUpdate {
  nameAr?: string;
  nameEn?: string;
  requireScan?: boolean;
  active?: boolean;
}

export interface ChecklistRead {
  template: ChecklistTemplate;
  /** The current version's items, by position. */
  items: ChecklistTemplateItem[];
}

export const checklistNotFound = () =>
  appError.notFound(ErrorCode.CHECKLIST_NOT_FOUND, 'Checklist not found');

/**
 * The compound's checklists (ADR 0064): a key that never changes, a
 * purpose (a planned job's, an inspection's, either), and items. Items are
 * never edited in place: replacing them is a new version, under the
 * template's row lock, and the runs already open keep the version they
 * took. Never deleted; a retired one is given to no new plan, round or
 * run. Kept by whoever keeps the register or the inspections.
 */
@Injectable()
export class ChecklistsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(CHECKLIST_RESOURCE, (id) => this.get(id));
  }

  /** Every checklist, retired ones too (a few dozen), without items. */
  list(): Promise<ChecklistTemplate[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.checklistTemplate.findMany({ orderBy: [{ key: 'asc' }] }),
    );
  }

  get(id: string): Promise<ChecklistRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const template = await tx.checklistTemplate.findUnique({ where: { id } });
      if (!template) throw checklistNotFound();
      return { template, items: await this.items(tx, template) };
    });
  }

  /** A duplicate key is DUPLICATE_RESOURCE on `key` (db-constraints). */
  create(input: ChecklistInput): Promise<ChecklistRead> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CHECKLIST_RESOURCE, id });
      await this.checkItems(tx, input.items);
      const template = await tx.checklistTemplate.create({
        data: {
          id,
          tenantId,
          key: input.key,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
          purpose: input.purpose,
          requireScan: input.requireScan ?? false,
        },
      });
      const items = await this.writeItems(tx, template, 1, input.items);
      await this.audit.record(tx, {
        action: 'checklist.created',
        targetId: id,
        changes: diffChanges(null, audited(template), 'checklist.created'),
        metadata: { items: items.length },
      });
      return { template, items };
    });
  }

  update(id: string, input: ChecklistUpdate): Promise<ChecklistRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      const template = await tx.checklistTemplate.update({
        where: { id },
        data: {
          nameAr: input.nameAr?.trim(),
          nameEn: input.nameEn?.trim(),
          requireScan: input.requireScan,
          active: input.active,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(template),
        'checklist.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'checklist.updated',
          targetId: id,
          changes,
        });
      return { template, items: await this.items(tx, template) };
    });
  }

  /** New items: a new version, the old one kept for the runs that use it. */
  replaceItems(id: string, items: ItemInput[]): Promise<ChecklistRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      await this.checkItems(tx, items);
      const version = before.currentVersion + 1;
      const template = await tx.checklistTemplate.update({
        where: { id },
        data: { currentVersion: version },
      });
      const written = await this.writeItems(tx, template, version, items);
      await this.audit.record(tx, {
        action: 'checklist.items_replaced',
        targetId: id,
        changes: { version: { from: before.currentVersion, to: version } },
        metadata: { items: written.length },
      });
      return { template, items: written };
    });
  }

  /**
   * An active checklist for `purpose` (a plan's `pm`, a round's
   * `inspection`; `any` serves both), or CHECKLIST_NOT_AVAILABLE on
   * `field`.
   */
  async requireUsable(
    tx: TenantTxClient,
    id: string,
    purpose: Exclude<ChecklistPurpose, 'any'>,
    field = 'checklistId',
  ): Promise<ChecklistTemplate> {
    const template = await tx.checklistTemplate.findFirst({
      where: { id, active: true, purpose: { in: [purpose, 'any'] } },
    });
    if (!template)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid checklist',
        {
          fields: [{ field, code: FieldErrorCode.CHECKLIST_NOT_AVAILABLE }],
        },
      );
    return template;
  }

  private items(
    tx: TenantTxClient,
    t: ChecklistTemplate,
  ): Promise<ChecklistTemplateItem[]> {
    return tx.checklistTemplateItem.findMany({
      where: { templateId: t.id, version: t.currentVersion },
      orderBy: { position: 'asc' },
    });
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<ChecklistTemplate> {
    await tx.$queryRaw`SELECT id FROM checklist_templates WHERE id = ${id}::uuid FOR UPDATE`;
    const template = await tx.checklistTemplate.findUnique({ where: { id } });
    if (!template) throw checklistNotFound();
    return template;
  }

  /** The items' shapes, and each follow-up category active. */
  private async checkItems(
    tx: TenantTxClient,
    items: readonly ItemInput[],
  ): Promise<void> {
    const fields = itemProblems(items);
    for (const [i, it] of items.entries())
      if (
        it.followUpCategoryId !== undefined &&
        !(await tx.ticketCategory.count({
          where: { id: it.followUpCategoryId, active: true },
        }))
      )
        fields.push({
          field: `items.${i}.followUpCategoryId`,
          code: FieldErrorCode.CATEGORY_NOT_AVAILABLE,
        });
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid checklist',
        { fields },
      );
  }

  private async writeItems(
    tx: TenantTxClient,
    t: ChecklistTemplate,
    version: number,
    items: readonly ItemInput[],
  ): Promise<ChecklistTemplateItem[]> {
    await tx.checklistTemplateItem.createMany({
      data: items.map((it, i) => ({
        id: newId(),
        tenantId: t.tenantId,
        templateId: t.id,
        version,
        position: i + 1,
        kind: it.kind,
        labelAr: it.labelAr.trim(),
        labelEn: it.labelEn.trim(),
        required: it.required ?? true,
        metricKey: it.metricKey ?? null,
        unit: it.unit ?? null,
        minValue: it.minValue ?? null,
        maxValue: it.maxValue ?? null,
        failCreatesTicket: it.failCreatesTicket ?? false,
        followUpCategoryId: it.followUpCategoryId ?? null,
        followUpPriority: it.followUpPriority ?? null,
      })),
    });
    return tx.checklistTemplateItem.findMany({
      where: { templateId: t.id, version },
      orderBy: { position: 'asc' },
    });
  }
}

/** Keys and switches; the names as `{ changed: true }`; never the labels. */
function audited(t: ChecklistTemplate) {
  return {
    key: t.key,
    nameAr: t.nameAr,
    nameEn: t.nameEn,
    purpose: t.purpose,
    requireScan: t.requireScan,
    active: t.active,
  };
}
