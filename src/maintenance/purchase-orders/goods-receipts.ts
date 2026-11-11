import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type GoodsReceipt,
  type GoodsReceiptLine,
  type PurchaseOrderLine,
} from '@prisma/client';
import { PermissionsService } from '../../core/access/permissions.service';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { dateColumn, type LocalDate } from '../schedules/local-dates';
import { StockLedger } from '../stock/stock-ledger';
import { nextProcurementNumber } from '../vendors/vendors.service';
import { lockOrder, OrderProgress } from './order-progress';
import { receivable, receiptReference } from './purchase-order-rules';

export const GOODS_RECEIPT_RESOURCE = 'goods_receipt';

export interface ReceiptLineInput {
  purchaseOrderLineId: string;
  accepted: string;
  rejected?: string;
  rejectReason?: string;
  note?: string;
}

export interface NewReceipt {
  receivedOn: LocalDate;
  /** The store the stock lines go into (required when one is accepted). */
  storeId?: string;
  deliveryNote?: string;
  note?: string;
  lines: ReceiptLineInput[];
  /** `goods_receipt_photo` uploads of the caller. */
  photoFileIds?: string[];
}

export interface ReceiptRecord {
  receipt: GoodsReceipt;
  lines: {
    line: GoodsReceiptLine;
    position: number;
    kind: string;
    description: string;
    unit: string;
  }[];
  photos: { fileId: string; url: string | null }[];
  receivedByMe: boolean;
}

const notFound = () =>
  appError.notFound(
    ErrorCode.GOODS_RECEIPT_NOT_FOUND,
    'Goods receipt not found',
  );
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid receipt', {
    fields,
  });

/**
 * Goods and service receipts (ADR 0094): what arrived against an approved
 * order, line by line, in parts: the quantity accepted and the quantity
 * rejected (with a reason code), a note, photos. A stock line accepted into
 * a store writes ADR 0065's stock receipt at the order's unit cost,
 * linked to the receipt; a goods line or a service is confirmed received.
 * Held by `purchase_orders.receive`; the order's raiser (or its purchase
 * request's requester) may confirm the order's service lines. At most the
 * ordered quantity and the compound's quantity tolerance is accepted in all.
 * Append-only.
 *
 * Locks: the order (update) → the stock items (update, in id order) → the
 * procurement counter → the stores' levels.
 */
@Injectable()
export class GoodsReceiptsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly calendar: CompoundCalendar,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly permissions: PermissionsService,
    private readonly ledger: StockLedger,
    private readonly files: FilesService,
    private readonly progressOf: OrderProgress,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(GOODS_RECEIPT_RESOURCE, (id) => this.get(id));
  }

  get(id: string): Promise<ReceiptRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const r = await tx.goodsReceipt.findUnique({ where: { id } });
      if (!r) throw notFound();
      return (await this.records(tx, [r]))[0];
    });
  }

  /** An order's receipts, newest first. */
  async forOrder(
    tx: TenantTxClient,
    orderId: string,
  ): Promise<ReceiptRecord[]> {
    const rows = await tx.goodsReceipt.findMany({
      where: { purchaseOrderId: orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return this.records(tx, rows);
  }

  record(orderId: string, input: NewReceipt): Promise<ReceiptRecord> {
    const fields: FieldError[] = [];
    const wanted = new Set<string>();
    input.lines.forEach((l, i) => {
      if (wanted.has(l.purchaseOrderLineId))
        fields.push({
          field: `lines.${i}.purchaseOrderLineId`,
          code: FieldErrorCode.DUPLICATE_VALUE,
        });
      wanted.add(l.purchaseOrderLineId);
      const rejected = new Prisma.Decimal(l.rejected ?? 0);
      const accepted = new Prisma.Decimal(l.accepted);
      if (accepted.add(rejected).lte(0))
        fields.push({
          field: `lines.${i}.accepted`,
          code: FieldErrorCode.INVALID_VALUE,
        });
      if (rejected.gt(0) !== (l.rejectReason !== undefined))
        fields.push({
          field: `lines.${i}.rejectReason`,
          code: rejected.gt(0)
            ? FieldErrorCode.FIELD_REQUIRED
            : FieldErrorCode.FIELD_NOT_ALLOWED,
        });
      else if (
        l.rejectReason !== undefined &&
        !(REASON_CODES.goodsRejection as readonly string[]).includes(
          l.rejectReason,
        )
      )
        fields.push({
          field: `lines.${i}.rejectReason`,
          code: FieldErrorCode.INVALID_VALUE,
          params: { allowed: [...REASON_CODES.goodsRejection] },
        });
    });
    const photos = [...new Set(input.photoFileIds ?? [])];
    if (photos.length !== (input.photoFileIds ?? []).length)
      fields.push({
        field: 'photoFileIds',
        code: FieldErrorCode.DUPLICATE_VALUE,
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const id = newId();
        await this.idempotency.claim(tx, { type: GOODS_RECEIPT_RESOURCE, id });
        const { today } = await this.calendar.now(tx);
        if (input.receivedOn > today)
          throw invalid([
            {
              field: 'receivedOn',
              code: FieldErrorCode.DAY_OUT_OF_RANGE,
              params: { max: today },
            },
          ]);
        const order = await lockOrder(tx, orderId);
        if (order.status !== 'approved')
          throw appError.conflict(
            ErrorCode.PURCHASE_ORDER_STATE,
            'The purchase order is not in a state that allows this',
            { params: { status: order.status } },
          );
        const lines = await tx.purchaseOrderLine.findMany({
          where: { purchaseOrderId: orderId },
        });
        const byId = new Map(lines.map((l) => [l.id, l]));
        const missing = input.lines.flatMap((l, i) =>
          byId.has(l.purchaseOrderLineId)
            ? []
            : [
                {
                  field: `lines.${i}.purchaseOrderLineId`,
                  code: FieldErrorCode.INVALID_VALUE,
                },
              ],
        );
        if (missing.length) throw invalid(missing);
        await this.mayReceive(tx, order, lines, input);
        // What the order and its tolerance still take of each line.
        const tolerance = new Prisma.Decimal(
          (
            await tx.financeSettings.findFirst({
              select: { matchQuantityPct: true },
            })
          )?.matchQuantityPct ?? 0,
        );
        const progress = await this.progressOf.progress(tx, orderId);
        for (const l of input.lines) {
          const line = byId.get(l.purchaseOrderLineId)!;
          const max = receivable(line.quantity, tolerance).sub(
            progress.get(line.id)?.accepted ?? 0,
          );
          if (new Prisma.Decimal(l.accepted).gt(Prisma.Decimal.max(max, 0)))
            throw appError.conflict(
              ErrorCode.GOODS_RECEIPT_EXCEEDS_ORDER,
              'More than the order, with its tolerance, takes',
              {
                params: {
                  lineId: line.id,
                  max: Prisma.Decimal.max(max, 0).toFixed(3),
                },
              },
            );
        }
        // Stock lines go into a store: the items locked in id order.
        const stockLines = input.lines
          .filter(
            (l) =>
              byId.get(l.purchaseOrderLineId)!.kind === 'stock' &&
              new Prisma.Decimal(l.accepted).gt(0),
          )
          .sort((a, b) =>
            byId
              .get(a.purchaseOrderLineId)!
              .stockItemId!.localeCompare(
                byId.get(b.purchaseOrderLineId)!.stockItemId!,
              ),
          );
        if (stockLines.length && !input.storeId)
          throw invalid([
            { field: 'storeId', code: FieldErrorCode.FIELD_REQUIRED },
          ]);
        if (!stockLines.length && input.storeId)
          throw invalid([
            { field: 'storeId', code: FieldErrorCode.FIELD_NOT_ALLOWED },
          ]);
        const items = new Map<
          string,
          Awaited<ReturnType<StockLedger['lockItem']>>
        >();
        for (const l of stockLines) {
          const stockItemId = byId.get(l.purchaseOrderLineId)!.stockItemId!;
          if (!items.has(stockItemId))
            items.set(stockItemId, await this.ledger.lockItem(tx, stockItemId));
        }
        const store = input.storeId
          ? await this.ledger.activeStore(tx, input.storeId)
          : null;
        const files = [];
        for (const fileId of photos) {
          const file = await this.files.claim(
            tx,
            fileId,
            'goods_receipt_photo',
          );
          if (!file)
            throw invalid([
              {
                field: 'photoFileIds',
                code: FieldErrorCode.FILE_NOT_AVAILABLE,
              },
            ]);
          files.push(file);
        }
        const number = await nextProcurementNumber(
          tx,
          this.ctx.tenantId,
          'goods_receipt',
        );
        const reference = receiptReference(number);
        const now = await dbNow(tx);
        const note = input.note?.trim() || null;
        const deliveryNote = input.deliveryNote?.trim() || null;
        await tx.goodsReceipt.create({
          data: {
            id,
            tenantId: this.ctx.tenantId,
            number,
            purchaseOrderId: orderId,
            receivedOn: dateColumn(input.receivedOn),
            storeId: store?.id ?? null,
            deliveryNote,
            note,
            receivedById: this.ctx.accountId,
            createdAt: now,
          },
        });
        const movementIds: string[] = [];
        for (const l of input.lines) {
          const line = byId.get(l.purchaseOrderLineId)!;
          const accepted = new Prisma.Decimal(l.accepted);
          let stockMovementId: string | null = null;
          if (line.kind === 'stock' && accepted.gt(0)) {
            const movement = await this.ledger.move(tx, {
              item: items.get(line.stockItemId!)!,
              store: store!,
              kind: 'receive',
              quantity: accepted,
              unitCost: line.unitPrice,
              reference,
              goodsReceiptId: id,
              actorId: this.ctx.accountId,
            });
            stockMovementId = movement.id;
            movementIds.push(movement.id);
          }
          await tx.goodsReceiptLine.create({
            data: {
              tenantId: this.ctx.tenantId,
              receiptId: id,
              purchaseOrderLineId: line.id,
              accepted: accepted.toFixed(3),
              rejected: new Prisma.Decimal(l.rejected ?? 0).toFixed(3),
              rejectReason: l.rejectReason ?? null,
              note: l.note?.trim() || null,
              stockMovementId,
            },
          });
        }
        for (const file of files) {
          await this.files.attach(tx, file);
          await tx.goodsReceiptPhoto.create({
            data: {
              tenantId: this.ctx.tenantId,
              receiptId: id,
              fileId: file.id,
            },
          });
        }
        for (const itemId of items.keys())
          await this.ledger.reorder(tx, itemId);
        await this.audit.record(tx, {
          action: 'goods_receipt.recorded',
          targetId: id,
          metadata: {
            number,
            orderId,
            storeId: store?.id ?? null,
            receivedOn: input.receivedOn,
            lines: input.lines.map((l) => ({
              lineId: l.purchaseOrderLineId,
              accepted: new Prisma.Decimal(l.accepted).toFixed(3),
              rejected: new Prisma.Decimal(l.rejected ?? 0).toFixed(3),
              reasonCode: l.rejectReason ?? null,
            })),
            movements: movementIds,
            photos: files.length,
          },
          ...(note || deliveryNote
            ? {
                changes: {
                  ...(note ? { note: { changed: true as const } } : {}),
                  ...(deliveryNote
                    ? { deliveryNote: { changed: true as const } }
                    : {}),
                },
              }
            : {}),
        });
        // Fully received and invoiced closes the order.
        await this.progressOf.afterChange(tx, orderId);
        return id;
      })
      .then((id) => this.get(id));
  }

  /**
   * Who holds `purchase_orders.receive` receives anything; the order's
   * raiser, or its purchase request's requester, may confirm its service
   * lines (a service is received by whoever asked for it).
   */
  private async mayReceive(
    tx: TenantTxClient,
    order: { raisedById: string; purchaseRequestId: string | null },
    lines: PurchaseOrderLine[],
    input: NewReceipt,
  ): Promise<void> {
    if (await this.permissions.has('purchase_orders.receive')) return;
    const requester = order.purchaseRequestId
      ? (
          await tx.purchaseRequest.findUnique({
            where: { id: order.purchaseRequestId },
            select: { requestedById: true },
          })
        )?.requestedById
      : null;
    const mine =
      order.raisedById === this.ctx.accountId ||
      requester === this.ctx.accountId;
    const onlyServices = input.lines.every(
      (l) =>
        lines.find((x) => x.id === l.purchaseOrderLineId)?.kind === 'service',
    );
    if (!mine || !onlyServices || input.storeId || input.photoFileIds?.length)
      throw appError.forbidden(
        ErrorCode.FORBIDDEN,
        'Missing permission for this action',
      );
  }

  private async records(
    tx: TenantTxClient,
    rows: GoodsReceipt[],
  ): Promise<ReceiptRecord[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const lines = await tx.goodsReceiptLine.findMany({
      where: { receiptId: { in: ids } },
    });
    const orderLines = await tx.purchaseOrderLine.findMany({
      where: {
        id: { in: [...new Set(lines.map((l) => l.purchaseOrderLineId))] },
      },
    });
    const info = new Map(orderLines.map((l) => [l.id, l]));
    const photos = await tx.goodsReceiptPhoto.findMany({
      where: { receiptId: { in: ids } },
      orderBy: { fileId: 'asc' },
    });
    const urls = new Map<string, string | null>();
    for (const p of photos)
      urls.set(p.fileId, (await this.files.readUrl(tx, p.fileId))?.url ?? null);
    return rows.map((receipt) => ({
      receipt,
      lines: lines
        .filter((l) => l.receiptId === receipt.id)
        .map((line) => {
          const o = info.get(line.purchaseOrderLineId)!;
          return {
            line,
            position: o.position,
            kind: o.kind,
            description: o.description,
            unit: o.unit,
          };
        })
        .sort((a, b) => a.position - b.position),
      photos: photos
        .filter((p) => p.receiptId === receipt.id)
        .map((p) => ({ fileId: p.fileId, url: urls.get(p.fileId) ?? null })),
      receivedByMe: receipt.receivedById === this.ctx.accountId,
    }));
  }
}
