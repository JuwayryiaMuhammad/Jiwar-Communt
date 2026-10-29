import { ApiProperty } from '@nestjs/swagger';
import type { PartRequest, StockMovement, Store } from '@prisma/client';
import type {
  CatalogueItem,
  ItemCard,
  ItemWithStock,
} from '../stock-items.service';
import type { TicketParts } from '../part-requests.service';
import {
  MOVEMENT_KINDS,
  PART_REQUEST_STATUSES,
  qty,
  STOCK_UNITS,
} from '../stock-rules';

export class StoreView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  commonAreaId: string | null;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(s: Store): StoreView {
    return {
      id: s.id,
      code: s.code,
      nameAr: s.nameAr,
      nameEn: s.nameEn,
      commonAreaId: s.commonAreaId,
      active: s.active,
      createdAt: s.createdAt,
    };
  }
}

/** An item and what the store holds of it, every store together. */
export class StockItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  sku: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ enum: STOCK_UNITS, enumName: 'StockUnit' })
  unit: string;
  @ApiProperty({ type: String, nullable: true, description: 'Three decimals.' })
  reorderLevel: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'EGP for one, over what was received; null before any receipt.',
  })
  averageCost: string | null;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: String, description: 'Held, every store together.' })
  onHand: string;
  @ApiProperty({ type: String, description: 'Of that, reserved for requests.' })
  reserved: string;
  @ApiProperty({
    type: Boolean,
    description: 'At or under its reorder level (the warning stands).',
  })
  belowReorderLevel: boolean;

  static from(r: ItemWithStock): StockItemView {
    const i = r.item;
    return {
      id: i.id,
      sku: i.sku,
      nameAr: i.nameAr,
      nameEn: i.nameEn,
      unit: i.unit,
      reorderLevel: i.reorderLevel === null ? null : qty(i.reorderLevel),
      averageCost: i.averageCost === null ? null : i.averageCost.toFixed(2),
      active: i.active,
      onHand: qty(r.onHand),
      reserved: qty(r.reserved),
      belowReorderLevel: i.reorderAlertedAt !== null,
    };
  }
}

class StockLevelView {
  @ApiProperty({ type: StoreView })
  store: StoreView;
  @ApiProperty({ type: String })
  quantity: string;
  @ApiProperty({ type: String })
  reserved: string;
}

export class StockItemCardView extends StockItemView {
  @ApiProperty({ type: [StockLevelView], description: 'By store code.' })
  levels: StockLevelView[];

  static fromCard(c: ItemCard): StockItemCardView {
    return {
      ...StockItemView.from(c),
      levels: c.levels.map((l) => ({
        store: StoreView.from(l.store),
        quantity: qty(l.quantity),
        reserved: qty(l.reserved),
      })),
    };
  }
}

export class StockMovementView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  itemId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  storeId: string;
  @ApiProperty({ enum: MOVEMENT_KINDS, enumName: 'StockMovementKind' })
  kind: string;
  @ApiProperty({ type: String, description: 'Signed: out is negative.' })
  quantity: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A receipt’s, EGP.',
  })
  unitCost: string | null;
  @ApiProperty({ type: String, nullable: true })
  reference: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'An adjustment’s `stockAdjust` code.',
  })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  transferId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  ticketId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  partRequestId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;

  static from(m: StockMovement): StockMovementView {
    return {
      id: m.id,
      itemId: m.itemId,
      storeId: m.storeId,
      kind: m.kind,
      quantity: qty(m.quantity),
      unitCost: m.unitCost === null ? null : m.unitCost.toFixed(2),
      reference: m.reference,
      reasonCode: m.reasonCode,
      transferId: m.transferId,
      ticketId: m.ticketId,
      partRequestId: m.partRequestId,
      actorId: m.actorId,
      occurredAt: m.occurredAt,
    };
  }
}

/** What a technician sees of an item: whether some is free, never how much. */
export class CatalogueItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  sku: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ enum: STOCK_UNITS, enumName: 'StockUnit' })
  unit: string;
  @ApiProperty({ type: Boolean, description: 'Some is free in a store.' })
  available: boolean;

  static from(c: CatalogueItem): CatalogueItemView {
    return {
      id: c.item.id,
      sku: c.item.sku,
      nameAr: c.item.nameAr,
      nameEn: c.item.nameEn,
      unit: c.item.unit,
      available: c.available,
    };
  }
}

export class PartRequestView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  ticketId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  itemId: string;
  @ApiProperty({ type: String })
  quantity: string;
  @ApiProperty({ enum: PART_REQUEST_STATUSES, enumName: 'PartRequestStatus' })
  status: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  storeId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  requestedById: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reservedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '`partRequestDecline` or `partRequestCancel`.',
  })
  reasonCode: string | null;

  static from(r: PartRequest): PartRequestView {
    return {
      id: r.id,
      ticketId: r.ticketId,
      itemId: r.itemId,
      quantity: qty(r.quantity),
      status: r.status,
      storeId: r.storeId,
      requestedById: r.requestedById,
      requestedAt: r.requestedAt,
      reservedAt: r.reservedAt,
      closedAt: r.closedAt,
      reasonCode: r.reasonCode,
    };
  }
}

class TicketPartView {
  @ApiProperty({ type: String, format: 'uuid' })
  itemId: string;
  @ApiProperty({ type: String })
  sku: string;
  @ApiProperty({ type: String })
  issued: string;
  @ApiProperty({ type: String })
  returned: string;
}

/** A ticket's part requests, oldest first, and what it got of each item. */
export class TicketPartsView {
  @ApiProperty({ type: [PartRequestView] })
  requests: PartRequestView[];
  @ApiProperty({ type: [TicketPartView] })
  parts: TicketPartView[];

  static from(t: TicketParts): TicketPartsView {
    return {
      requests: t.requests.map((r) => PartRequestView.from(r)),
      parts: t.parts.map((p) => ({
        itemId: p.itemId,
        sku: p.sku,
        issued: qty(p.issued),
        returned: qty(p.returned),
      })),
    };
  }
}
