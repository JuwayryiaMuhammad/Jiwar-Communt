import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type StockItem,
  type StockLevel,
  type StockMovement,
  type Store,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { itemNotFound, StockLedger } from './stock-ledger';
import { qty, type StockUnit } from './stock-rules';

export const STOCK_ITEM_RESOURCE = 'stock_item';
export const STOCK_MOVEMENT_RESOURCE = 'stock_movement';

export interface StockItemInput {
  sku: string;
  nameAr: string;
  nameEn: string;
  unit: StockUnit;
  reorderLevel?: string;
}

export interface StockItemUpdate {
  nameAr?: string;
  nameEn?: string;
  reorderLevel?: string | null;
  active?: boolean;
}

/** An item with what the store holds of it. */
export interface ItemWithStock {
  item: StockItem;
  onHand: Prisma.Decimal;
  reserved: Prisma.Decimal;
}

export interface ItemCard extends ItemWithStock {
  levels: (StockLevel & { store: Store })[];
}

export interface CatalogueItem {
  item: StockItem;
  available: boolean;
}

export interface MovementQuery {
  itemId?: string;
  storeId?: string;
  ticketId?: string;
  cursor?: string;
  limit?: number;
}

const ITEMS = keysetCursor('createdAt', 'asc');
const MOVEMENTS = keysetCursor('occurredAt', 'desc');
const ZERO = new Prisma.Decimal(0);

/**
 * The store's items and their stock (ADR 0065), kept with `stock.manage`:
 * receipts (which move the average cost), adjustments with a reason, and
 * transfers between stores, each a movement through the ledger. A
 * technician reads the catalogue — whether something is free to ask for,
 * never how much — to request parts on their ticket.
 */
@Injectable()
export class StockItemsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly ledger: StockLedger,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(STOCK_ITEM_RESOURCE, (id) => this.card(id));
    this.idempotency.renderer(STOCK_MOVEMENT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) =>
        tx.stockMovement.findUniqueOrThrow({ where: { id } }),
      ),
    );
  }

  /** Items, oldest first, with their totals; `below` keeps those at or under their level. */
  list(q: {
    active?: 'true' | 'false';
    below?: 'true' | 'false';
    cursor?: string;
    limit?: number;
  }): Promise<Page<ItemWithStock>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.stockItem.findMany({
        where: {
          AND: [
            q.active ? { active: q.active === 'true' } : {},
            q.below === 'true' ? { reorderAlertedAt: { not: null } } : {},
            ...ITEMS.after(q.cursor),
          ],
        },
        orderBy: ITEMS.orderBy,
        take: limit + 1,
      });
      const page = ITEMS.toPage(rows, limit);
      const totals = await this.totals(
        tx,
        page.items.map((i) => i.id),
      );
      return {
        ...page,
        items: page.items.map((item) => ({
          item,
          ...(totals.get(item.id) ?? { onHand: ZERO, reserved: ZERO }),
        })),
      };
    });
  }

  /** An item with each store's level. */
  card(id: string): Promise<ItemCard> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const item = await tx.stockItem.findUnique({ where: { id } });
      if (!item) throw itemNotFound();
      const levels = await tx.stockLevel.findMany({
        where: { itemId: id },
        include: { store: true },
        orderBy: [{ store: { code: 'asc' } }],
      });
      return {
        item,
        levels,
        onHand: levels.reduce((a, l) => a.plus(l.quantity), ZERO),
        reserved: levels.reduce((a, l) => a.plus(l.reserved), ZERO),
      };
    });
  }

  create(input: StockItemInput): Promise<ItemCard> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const id = newId();
        await this.idempotency.claim(tx, { type: STOCK_ITEM_RESOURCE, id });
        const item = await tx.stockItem.create({
          data: {
            id,
            tenantId: this.ctx.tenantId,
            sku: input.sku,
            nameAr: input.nameAr.trim(),
            nameEn: input.nameEn.trim(),
            unit: input.unit,
            reorderLevel: input.reorderLevel ?? null,
          },
        });
        await this.audit.record(tx, {
          action: 'stock_item.created',
          targetId: id,
          changes: diffChanges(null, audited(item), 'stock_item.created'),
        });
        return id;
      })
      .then((id) => this.card(id));
  }

  /** Names, the reorder level, retirement; the warning follows a new level. */
  update(id: string, input: StockItemUpdate): Promise<ItemCard> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.ledger.lockItem(tx, id);
        const item = await tx.stockItem.update({
          where: { id },
          data: {
            nameAr: input.nameAr?.trim(),
            nameEn: input.nameEn?.trim(),
            reorderLevel: input.reorderLevel,
            active: input.active,
            // No level, no warning to stand (the CHECK).
            ...(input.reorderLevel === null ? { reorderAlertedAt: null } : {}),
          },
        });
        const changes = diffChanges(
          audited(before),
          audited(item),
          'stock_item.updated',
        );
        if (Object.keys(changes).length)
          await this.audit.record(tx, {
            action: 'stock_item.updated',
            targetId: id,
            changes,
          });
        if (input.reorderLevel !== undefined) await this.ledger.reorder(tx, id);
      })
      .then(() => this.card(id));
  }

  /** Parts in: at their cost of one, which moves the item's average cost. */
  receive(
    id: string,
    input: {
      storeId: string;
      quantity: string;
      unitCost: string;
      reference?: string;
    },
  ): Promise<StockMovement> {
    return this.write(id, async (tx, item, movementId) => {
      requireActive(item);
      const store = await this.ledger.activeStore(tx, input.storeId);
      const movement = await this.ledger.move(tx, {
        id: movementId,
        item,
        store,
        kind: 'receive',
        quantity: new Prisma.Decimal(input.quantity),
        unitCost: new Prisma.Decimal(input.unitCost),
        reference: input.reference?.trim() || null,
        actorId: this.ctx.accountId,
      });
      const after = await tx.stockItem.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, {
        action: 'stock.received',
        targetId: id,
        metadata: {
          storeId: store.id,
          quantity: qty(movement.quantity),
          unitCost: movement.unitCost!.toFixed(2),
          averageCost: after.averageCost!.toFixed(2),
          hasReference: movement.reference !== null,
        },
      });
      return movement;
    });
  }

  /** A level set right by hand, up or down, with a reason. */
  adjust(
    id: string,
    input: { storeId: string; delta: string; reasonCode?: string },
  ): Promise<StockMovement> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.stockAdjust,
    );
    return this.write(id, async (tx, item, movementId) => {
      const store = await this.ledger.activeStore(tx, input.storeId);
      const movement = await this.ledger.move(tx, {
        id: movementId,
        item,
        store,
        kind: 'adjust',
        quantity: new Prisma.Decimal(input.delta),
        reasonCode: reason,
        actorId: this.ctx.accountId,
      });
      await this.audit.record(tx, {
        action: 'stock.adjusted',
        targetId: id,
        metadata: {
          storeId: store.id,
          quantity: qty(movement.quantity),
          reasonCode: reason,
        },
      });
      return movement;
    });
  }

  /**
   * From one store to another: two movements under one transfer id, the
   * two levels locked in store-id order after the item.
   */
  transfer(
    id: string,
    input: { fromStoreId: string; toStoreId: string; quantity: string },
  ): Promise<StockMovement> {
    if (input.fromStoreId === input.toStoreId)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'A transfer goes to another store',
        {
          fields: [{ field: 'toStoreId', code: FieldErrorCode.INVALID_VALUE }],
        },
      );
    return this.write(id, async (tx, item, movementId) => {
      const [from, to] = [
        await this.ledger.activeStore(tx, input.fromStoreId),
        await this.ledger.activeStore(tx, input.toStoreId),
      ];
      for (const storeId of [from.id, to.id].sort())
        await this.ledger.lockLevel(tx, item, storeId);
      const amount = new Prisma.Decimal(input.quantity);
      const transferId = newId();
      const out = await this.ledger.move(tx, {
        id: movementId,
        item,
        store: from,
        kind: 'transfer',
        quantity: amount.negated(),
        transferId,
        actorId: this.ctx.accountId,
      });
      await this.ledger.move(tx, {
        item,
        store: to,
        kind: 'transfer',
        quantity: amount,
        transferId,
        actorId: this.ctx.accountId,
      });
      await this.audit.record(tx, {
        action: 'stock.transferred',
        targetId: id,
        metadata: {
          fromStoreId: from.id,
          toStoreId: to.id,
          quantity: qty(amount),
        },
      });
      return out;
    });
  }

  /** Movements, newest first, by item, store or ticket. */
  movements(q: MovementQuery): Promise<Page<StockMovement>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.stockMovement.findMany({
        where: {
          AND: [
            q.itemId ? { itemId: q.itemId } : {},
            q.storeId ? { storeId: q.storeId } : {},
            q.ticketId ? { ticketId: q.ticketId } : {},
            ...MOVEMENTS.after(q.cursor),
          ],
        },
        orderBy: MOVEMENTS.orderBy,
        take: limit + 1,
      });
      return MOVEMENTS.toPage(rows, limit);
    });
  }

  /**
   * The technicians' catalogue: active items, by SKU or name, and whether
   * any store has some free — never how much, nor where.
   */
  catalogue(q: {
    q?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<CatalogueItem>> {
    const limit = clampLimit(q.limit);
    const term = q.q?.trim();
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.stockItem.findMany({
        where: {
          AND: [
            { active: true },
            term
              ? {
                  OR: [
                    { sku: { contains: term, mode: 'insensitive' } },
                    { nameEn: { contains: term, mode: 'insensitive' } },
                    { nameAr: { contains: term } },
                  ],
                }
              : {},
            ...ITEMS.after(q.cursor),
          ],
        },
        orderBy: ITEMS.orderBy,
        take: limit + 1,
      });
      const page = ITEMS.toPage(rows, limit);
      const totals = await this.totals(
        tx,
        page.items.map((i) => i.id),
      );
      return {
        ...page,
        items: page.items.map((item) => {
          const t = totals.get(item.id);
          return { item, available: !!t && t.onHand.gt(t.reserved) };
        }),
      };
    });
  }

  private async totals(
    tx: TenantTxClient,
    itemIds: string[],
  ): Promise<
    Map<string, { onHand: Prisma.Decimal; reserved: Prisma.Decimal }>
  > {
    if (!itemIds.length) return new Map();
    const sums = await tx.stockLevel.groupBy({
      by: ['itemId'],
      where: { itemId: { in: itemIds } },
      _sum: { quantity: true, reserved: true },
    });
    return new Map(
      sums.map((s) => [
        s.itemId,
        {
          onHand: s._sum.quantity ?? ZERO,
          reserved: s._sum.reserved ?? ZERO,
        },
      ]),
    );
  }

  /** Account (shared), the item (`FOR UPDATE`), the change, the warning. */
  private write<T extends StockMovement>(
    id: string,
    fn: (tx: TenantTxClient, item: StockItem, movementId: string) => Promise<T>,
  ): Promise<T> {
    return this.tenantTx.withTenantTx(async (tx) => {
      // Claimed with the movement's own id: a replay renders that movement.
      const movementId = newId();
      await this.idempotency.claim(tx, {
        type: STOCK_MOVEMENT_RESOURCE,
        id: movementId,
      });
      await this.lockSelf(tx);
      const item = await this.ledger.lockItem(tx, id);
      const result = await fn(tx, item, movementId);
      await this.ledger.reorder(tx, id);
      return result;
    });
  }

  private async lockSelf(tx: TenantTxClient): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM accounts
       WHERE id = ${this.ctx.accountId}::uuid FOR SHARE`;
    if (rows[0]?.status !== 'active')
      throw appError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required',
      );
  }
}

function requireActive(item: StockItem): void {
  if (!item.active)
    throw appError.conflict(
      ErrorCode.STOCK_ITEM_RETIRED,
      'This item is retired',
    );
}

const audited = (i: StockItem) => ({
  sku: i.sku,
  nameAr: i.nameAr,
  nameEn: i.nameEn,
  unit: i.unit,
  reorderLevel: i.reorderLevel === null ? null : qty(i.reorderLevel),
  active: i.active,
});
