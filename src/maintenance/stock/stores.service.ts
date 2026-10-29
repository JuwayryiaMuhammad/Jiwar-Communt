import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Store } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { storeNotFound } from './stock-ledger';

export const STORE_RESOURCE = 'store';

export interface StoreInput {
  code: string;
  nameAr: string;
  nameEn: string;
  commonAreaId?: string;
}

export interface StoreUpdate {
  nameAr?: string;
  nameEn?: string;
  active?: boolean;
}

const PAGE = keysetCursor('createdAt', 'asc');

/**
 * The maintenance store's stores (ADR 0065), kept with `stock.manage`.
 * Never deleted: levels and movements point at them; a retired one takes
 * no movement (its levels stay as they were, to read). An unknown common
 * area (or another compound's) is RELATED_RESOURCE_MISSING, by the
 * foreign key; a duplicate code DUPLICATE_RESOURCE on `code`.
 */
@Injectable()
export class StoresService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(STORE_RESOURCE, (id) => this.get(id));
  }

  list(q: { cursor?: string; limit?: number }): Promise<Page<Store>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.store.findMany({
        where: { AND: PAGE.after(q.cursor) },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<Store> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const store = await tx.store.findUnique({ where: { id } });
      if (!store) throw storeNotFound();
      return store;
    });
  }

  create(input: StoreInput): Promise<Store> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: STORE_RESOURCE, id });
      const store = await tx.store.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          code: input.code,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
          commonAreaId: input.commonAreaId ?? null,
        },
      });
      await this.audit.record(tx, {
        action: 'store.created',
        targetId: id,
        changes: diffChanges(null, audited(store), 'store.created'),
      });
      return store;
    });
  }

  /** Names and retirement; a store is retired with its stock in place. */
  update(id: string, input: StoreUpdate): Promise<Store> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stores WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await tx.store.findUnique({ where: { id } });
      if (!before) throw storeNotFound();
      const store = await tx.store.update({
        where: { id },
        data: {
          nameAr: input.nameAr?.trim(),
          nameEn: input.nameEn?.trim(),
          active: input.active,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(store),
        'store.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'store.updated',
          targetId: id,
          changes,
        });
      return store;
    });
  }
}

const audited = (s: Store) => ({
  code: s.code,
  nameAr: s.nameAr,
  nameEn: s.nameEn,
  commonAreaId: s.commonAreaId,
  active: s.active,
});
