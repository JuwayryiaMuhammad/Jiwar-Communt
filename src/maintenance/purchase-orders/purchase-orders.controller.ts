import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import {
  AmendPurchaseOrderDto,
  ApprovePurchaseOrderDto,
  CreateGoodsReceiptDto,
  CreatePurchaseOrderDto,
  PurchaseOrdersQueryDto,
  RejectPurchaseOrderDto,
} from './dto/purchase-orders.dto';
import { GoodsReceiptsService } from './goods-receipts';
import { PurchaseOrderDocuments } from './purchase-order-documents';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  GoodsReceiptView,
  PurchaseOrderView,
} from './views/purchase-order.views';

/**
 * Purchase orders and what arrives against them (ADR 0094): raised, amended,
 * sent and cancelled with `purchase_orders.raise`; approved or turned down
 * with `purchases.approve` (never by who raised it); received with
 * `purchase_orders.receive`. Every response is no-store: a receipt carries
 * signed photo links.
 */
@ApiArea('maintenance')
@Controller('staff/purchase-orders')
export class PurchaseOrdersController {
  constructor(
    private readonly orders: PurchaseOrdersService,
    private readonly receipts: GoodsReceiptsService,
    private readonly documents: PurchaseOrderDocuments,
  ) {}

  @Get()
  @NoStore()
  @RequireAnyPermission(
    'purchase_orders.raise',
    'purchase_orders.receive',
    'purchases.approve',
    'finance.payables',
    'finance.payables_approve',
  )
  @ApiOperation({
    summary: 'List purchase orders',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(PurchaseOrderView) })
  async list(
    @Query() q: PurchaseOrdersQueryDto,
  ): Promise<ListResponse<PurchaseOrderView>> {
    return toList(await this.orders.list(q), (o) => PurchaseOrderView.from(o));
  }

  @Post()
  @NoStore()
  @Idempotent()
  @RequirePermissions('purchase_orders.raise')
  @ApiOperation({
    summary: 'Raise a purchase order',
    description:
      'Directly, from an approved purchase request (`purchaseRequestId`: its vendor and budget line, its commitment taken over at the approval) or from an awarded tender (`tenderId`). It waits for an approver other than the caller (PURCHASE_ORDER_SELF_APPROVAL). Audited.',
  })
  @ApiCreatedResponse({ type: PurchaseOrderView })
  async raise(@Body() dto: CreatePurchaseOrderDto): Promise<PurchaseOrderView> {
    return PurchaseOrderView.from(await this.orders.raise(dto));
  }

  @Get(':id')
  @NoStore()
  @RequireAnyPermission(
    'purchase_orders.raise',
    'purchase_orders.receive',
    'purchases.approve',
    'finance.payables',
    'finance.payables_approve',
  )
  @ApiOperation({
    summary: 'Get a purchase order',
    description:
      'With its lines and what happened to each, its revisions, its receipts and the invoices naming it.',
  })
  @ApiOkResponse({ type: PurchaseOrderView })
  async get(@Param('id', parseId()) id: string): Promise<PurchaseOrderView> {
    return PurchaseOrderView.from(await this.orders.get(id));
  }

  @Get(':id/pdf')
  @NoStore()
  @RequireAnyPermission(
    'purchase_orders.raise',
    'purchase_orders.receive',
    'purchases.approve',
  )
  @ApiOperation({
    summary: 'A purchase order as a PDF, for its vendor',
    description: 'The revision in force, drawn on demand and never stored.',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async pdf(@Param('id', parseId()) id: string): Promise<StreamableFile> {
    const { name, body } = await this.documents.pdfOf(id);
    return new StreamableFile(body, {
      type: 'application/pdf',
      disposition: `attachment; filename="${name}"`,
    });
  }

  @Post(':id/approve')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchases.approve')
  @ApiOperation({
    summary: 'Approve a purchase order, or its waiting revision',
    description:
      'Never by who raised it (PURCHASE_ORDER_SELF_APPROVAL, even under the board’s approval). Up to the manager’s limit, above it under the board’s approved major contract (`approvalRequestId`; PURCHASE_ORDER_NEEDS_APPROVAL, PURCHASE_ORDER_APPROVAL_INVALID). Keeps the budget line’s money as the order’s commitment (BUDGET_LINE_INSUFFICIENT); an order raised from a purchase request takes the request’s commitment over.',
  })
  @ApiOkResponse({ type: PurchaseOrderView })
  async approve(
    @Param('id', parseId()) id: string,
    @Body() dto: ApprovePurchaseOrderDto,
  ): Promise<PurchaseOrderView> {
    return PurchaseOrderView.from(await this.orders.approve(id, dto));
  }

  /** `reasonCode` from the closed list `purchaseOrderReject`. */
  @Post(':id/reject')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchases.approve')
  @ApiOperation({ summary: 'Turn down a purchase order, or its revision' })
  @ApiOkResponse({ type: PurchaseOrderView })
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: RejectPurchaseOrderDto,
  ): Promise<PurchaseOrderView> {
    return PurchaseOrderView.from(await this.orders.reject(id, dto));
  }

  /** `reasonCode` from the closed list `purchaseOrderAmend`. */
  @Post(':id/amend')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchase_orders.raise')
  @ApiOperation({
    summary: 'Amend an approved purchase order',
    description:
      'A new revision, approved again; one waits at a time (PURCHASE_ORDER_REVISION_PENDING). No line goes below what was received or invoiced of it (PURCHASE_ORDER_LINE_BELOW_USED). The revision in force stands until it is approved.',
  })
  @ApiOkResponse({ type: PurchaseOrderView })
  async amend(
    @Param('id', parseId()) id: string,
    @Body() dto: AmendPurchaseOrderDto,
  ): Promise<PurchaseOrderView> {
    return PurchaseOrderView.from(await this.orders.amend(id, dto));
  }

  @Post(':id/withdraw-revision')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchase_orders.raise')
  @ApiOperation({ summary: 'Take back the revision that waits' })
  @ApiOkResponse({ type: PurchaseOrderView })
  async withdrawRevision(
    @Param('id', parseId()) id: string,
  ): Promise<PurchaseOrderView> {
    return PurchaseOrderView.from(await this.orders.withdrawRevision(id));
  }

  /** `reasonCode` from the closed list `purchaseOrderCancel`. */
  @Post(':id/cancel')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission('purchase_orders.raise', 'purchases.approve')
  @ApiOperation({
    summary:
      'Call off a waiting order, or cancel what is left of an approved one',
    description:
      'A waiting order is called off. An approved one closes: what was not received is cancelled and its commitment given back, keeping the value of what arrived and is not invoiced yet.',
  })
  @ApiOkResponse({ type: PurchaseOrderView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<PurchaseOrderView> {
    return PurchaseOrderView.from(await this.orders.cancel(id, dto.reasonCode));
  }

  @Post(':id/send')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchase_orders.raise')
  @ApiOperation({
    summary: 'Send an approved order to its vendor',
    description:
      'Records that the revision in force went to the vendor and tells its contractors, who then see it (and its PDF) and acknowledge it. Sent again after a revision.',
  })
  @ApiOkResponse({ type: PurchaseOrderView })
  async send(@Param('id', parseId()) id: string): Promise<PurchaseOrderView> {
    return PurchaseOrderView.from(await this.orders.send(id));
  }

  @Post(':id/receipts')
  @NoStore()
  @Idempotent()
  @RequireAnyPermission(
    'purchase_orders.receive',
    'purchase_orders.raise',
    'purchases.request',
  )
  @ApiOperation({
    summary: 'Record what arrived against a purchase order',
    description:
      'A goods or service receipt, in parts: per line the quantity accepted and rejected (a rejection has a `goodsRejection` code), a note and photos. A stock line accepted goes into a store (`storeId`) at the order’s unit cost. At most the ordered quantity and the compound’s tolerance is accepted in all (GOODS_RECEIPT_EXCEEDS_ORDER). Who holds `purchase_orders.receive` receives anything; the order’s raiser or its request’s requester confirms its service lines only. Audited.',
  })
  @ApiCreatedResponse({ type: GoodsReceiptView })
  async receive(
    @Param('id', parseId()) id: string,
    @Body() dto: CreateGoodsReceiptDto,
  ): Promise<GoodsReceiptView> {
    return GoodsReceiptView.from(await this.receipts.record(id, dto));
  }
}
