import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { ContractorAccess } from '../contractors/contractor-access';
import { orderNotFound } from './order-progress';
import { PurchaseOrderDocuments } from './purchase-order-documents';
import { PurchaseOrdersService } from './purchase-orders.service';
import { ContractorPurchaseOrderView } from './views/purchase-order.views';

/**
 * A vendor's contractor reads the purchase orders sent to its company and
 * acknowledges them (ADR 0094, 0088): what was ordered, its price and its
 * delivery day; never the budget, the approvals, the receipts or another
 * company's orders (the same 404 as an unknown one).
 */
@ApiArea('contractor')
@RequirePermissions('purchase_orders.acknowledge')
@Controller('contractor/purchase-orders')
export class ContractorPurchaseOrdersController {
  constructor(
    private readonly orders: PurchaseOrdersService,
    private readonly documents: PurchaseOrderDocuments,
    private readonly access: ContractorAccess,
    private readonly tenantTx: TenantTx,
  ) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the purchase orders sent to my company',
    description: 'Newest first; once sent, approved or closed.',
  })
  @ApiOkResponse({ type: ListOf(ContractorPurchaseOrderView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ContractorPurchaseOrderView>> {
    const vendorId = await this.vendorOf();
    return toList(await this.orders.sentTo(vendorId, q), (o) =>
      ContractorPurchaseOrderView.from(o),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a purchase order sent to my company' })
  @ApiOkResponse({ type: ContractorPurchaseOrderView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<ContractorPurchaseOrderView> {
    const vendorId = await this.vendorOf();
    const o = await this.orders.sentOne(vendorId, id);
    if (!o) throw orderNotFound();
    return ContractorPurchaseOrderView.from(o);
  }

  @Get(':id/pdf')
  @NoStore()
  @ApiOperation({ summary: 'A purchase order sent to my company, as a PDF' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async pdf(@Param('id', parseId()) id: string): Promise<StreamableFile> {
    const vendorId = await this.vendorOf();
    const { name, body } = await this.documents.pdfOf(id, { vendorId });
    return new StreamableFile(body, {
      type: 'application/pdf',
      disposition: `attachment; filename="${name}"`,
    });
  }

  @Post(':id/acknowledge')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge the purchase order',
    description:
      'Records that my company has the revision sent; a new revision asks again. Audited.',
  })
  @ApiOkResponse({ type: ContractorPurchaseOrderView })
  async acknowledge(
    @Param('id', parseId()) id: string,
  ): Promise<ContractorPurchaseOrderView> {
    return ContractorPurchaseOrderView.from(await this.orders.acknowledge(id));
  }

  /** The caller's vendor, from its own account row. */
  private vendorOf(): Promise<string> {
    return this.tenantTx.withTenantTx((tx) => this.access.vendorOf(tx));
  }
}
