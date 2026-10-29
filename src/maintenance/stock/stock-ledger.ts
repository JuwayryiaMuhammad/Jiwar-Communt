import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type StockItem,
  type StockLevel,
  type StockMovement,
  type Store,
} from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { dbNow } from '../db-clock';
import {
  averageAfterReceipt,
  free,
  type MovementKind,
  qty,
  reorderState,
} from './stock-rules';

export const storeNotFound = () =>
  appError.notFound(ErrorCode.STORE_NOT_FOUND, 'Store not found');
export const itemNotFound = () =>
  appError.notFound(ErrorCode.STOCK_ITEM_NOT_FOUND, 'Stock item not found');

export interface Move {
  /** The movement's id when the caller claimed it (idempotency). */
  id?: string;
  item: StockItem;
  store: Store;
  kind: MovementKind;
  /** Signed: in is positive, out negative. */
  quantity: Prisma.Decimal;
  /** Also take this much off the level's reservation (an issue). */
  unreserve?: Prisma.Decimal;
  unitCost?: Prisma.Decimal;
  reference?: string | null;
  reasonCode?: string;
  transferId?: string;
  ticketId?: string;
  partRequestId?: string;
  actorId: string | null;
}

/**
 * The one writer of stock levels (ADR 0065). Every change locks the item
 * (`FOR UPDATE`) first, then the levels it touches, in store-id order; the
 * item lock serializes all writes of one item, so an average cost or a
 * reorder decision reads totals nothing else is changing. A level is never
 * below zero nor below what is reserved of it: an out that would make it
 * so is STOCK_INSUFFICIENT with what is free (the CHECK backs it). Each
 * change is a movement row, never edited. Times are the database's.
 */
@Injectable()
export class StockLedger {
  constructor(
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
  ) {}

  /** The item, locked; STOCK_ITEM_NOT_FOUND. */
  async lockItem(tx: TenantTxClient, id: string): Promise<StockItem> {
    await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${id}::uuid FOR UPDATE`;
    const item = await tx.stockItem.findUnique({ where: { id } });
    if (!item) throw itemNotFound();
    return item;
  }

  /** A store, shared-locked: it is not retired under a movement. */
  async shareStore(tx: TenantTxClient, id: string): Promise<Store> {
    await tx.$queryRaw`SELECT id FROM stores WHERE id = ${id}::uuid FOR SHARE`;
    const store = await tx.store.findUnique({ where: { id } });
    if (!store) throw storeNotFound();
    return store;
  }

  /** A store that takes movements: active. */
  async activeStore(tx: TenantTxClient, id: string): Promise<Store> {
    const store = await this.shareStore(tx, id);
    if (!store.active)
      throw appError.conflict(ErrorCode.STORE_RETIRED, 'This store is retired');
    return store;
  }

  /** The item's level in a store, made at zero if missing, locked. */
  async lockLevel(
    tx: TenantTxClient,
    item: Pick<StockItem, 'id' | 'tenantId'>,
    storeId: string,
  ): Promise<StockLevel> {
    await tx.$executeRaw`
      INSERT INTO stock_levels (id, tenant_id, store_id, item_id, updated_at)
      VALUES (${newId()}::uuid, ${item.tenantId}::uuid, ${storeId}::uuid, ${item.id}::uuid, now())
      ON CONFLICT (tenant_id, store_id, item_id) DO NOTHING`;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM stock_levels
       WHERE store_id = ${storeId}::uuid AND item_id = ${item.id}::uuid FOR UPDATE`;
    return tx.stockLevel.findUniqueOrThrow({ where: { id: rows[0].id } });
  }

  /** What the store holds of an item now, every store together. */
  async held(tx: TenantTxClient, itemId: string): Promise<Prisma.Decimal> {
    const sum = await tx.stockLevel.aggregate({
      where: { itemId },
      _sum: { quantity: true },
    });
    return sum._sum.quantity ?? new Prisma.Decimal(0);
  }

  /**
   * One movement, its level changed, under the item's lock the caller
   * holds (from `lockItem`), the level locked here. A receipt moves the
   * average cost first.
   */
  async move(tx: TenantTxClient, m: Move): Promise<StockMovement> {
    if (m.kind === 'receive')
      await tx.stockItem.update({
        where: { id: m.item.id },
        data: {
          averageCost: averageAfterReceipt(
            await this.held(tx, m.item.id),
            m.item.averageCost,
            m.quantity,
            m.unitCost!,
          ),
        },
      });
    const level = await this.lockLevel(tx, m.item, m.store.id);
    const unreserve = m.unreserve ?? new Prisma.Decimal(0);
    const quantity = level.quantity.plus(m.quantity);
    const reserved = level.reserved.minus(unreserve);
    if (quantity.lt(reserved) || quantity.isNegative())
      throw insufficient(free(level).plus(unreserve));
    await tx.stockLevel.update({
      where: { id: level.id },
      data: { quantity, reserved },
    });
    return tx.stockMovement.create({
      data: {
        id: m.id ?? newId(),
        tenantId: m.item.tenantId,
        itemId: m.item.id,
        storeId: m.store.id,
        kind: m.kind,
        quantity: m.quantity,
        unitCost: m.unitCost ?? null,
        reference: m.reference ?? null,
        reasonCode: m.reasonCode ?? null,
        transferId: m.transferId ?? null,
        ticketId: m.ticketId ?? null,
        partRequestId: m.partRequestId ?? null,
        actorId: m.actorId,
        occurredAt: await dbNow(tx),
      },
    });
  }

  /** Holds `amount` of the level for a request; STOCK_INSUFFICIENT. */
  async reserve(
    tx: TenantTxClient,
    item: StockItem,
    storeId: string,
    amount: Prisma.Decimal,
  ): Promise<void> {
    const level = await this.lockLevel(tx, item, storeId);
    if (free(level).lt(amount)) throw insufficient(free(level));
    await tx.stockLevel.update({
      where: { id: level.id },
      data: { reserved: level.reserved.plus(amount) },
    });
  }

  /** Lets go of a reservation (a request declined or called off). */
  async release(
    tx: TenantTxClient,
    item: StockItem,
    storeId: string,
    amount: Prisma.Decimal,
  ): Promise<void> {
    const level = await this.lockLevel(tx, item, storeId);
    await tx.stockLevel.update({
      where: { id: level.id },
      data: { reserved: Prisma.Decimal.max(0, level.reserved.minus(amount)) },
    });
  }

  /**
   * The reorder warning after the item's levels changed, under its lock:
   * sent once to who keeps the store as stock falls to the reorder level,
   * cleared as it rises above.
   */
  async reorder(tx: TenantTxClient, itemId: string): Promise<void> {
    const item = await tx.stockItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    const state = reorderState(
      await this.held(tx, item.id),
      item.reorderLevel,
      item.reorderAlertedAt !== null,
    );
    if (state === 'keep') return;
    await tx.stockItem.update({
      where: { id: item.id },
      data: { reorderAlertedAt: state === 'warn' ? await dbNow(tx) : null },
    });
    if (state === 'clear' || !item.active) return;
    const keepers = await this.staff.holding(tx, 'stock.manage');
    await this.notifier.notify(
      tx,
      keepers.map((k) => k.id),
      {
        kind: 'stock.reorder_level',
        params: { itemRef: item.sku },
        targetId: item.id,
      },
    );
  }
}

export function insufficient(available: Prisma.Decimal) {
  return appError.conflict(
    ErrorCode.STOCK_INSUFFICIENT,
    'Not that much is free in the store',
    { params: { available: qty(Prisma.Decimal.max(0, available)) } },
  );
}
