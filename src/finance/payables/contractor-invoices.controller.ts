import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import type { FinanceVendorInvoice } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../core/common/validation/local-date';
import { withParams } from '../../core/common/validation/validation-errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { formatNumber } from '../counters';
import { fromDate } from '../db-clock';
import { show } from '../money';
import { InvoiceLineDto } from './dto/payables.dto';
import { INVOICE_STATUSES, PAYABLE_LIMITS as L } from './payable-rules';
import { VendorInvoicesService } from './vendor-invoices.service';

/** A vendor's invoice its contractor sends in (ADR 0088, into ADR 0089's table). */
export class ContractorInvoiceDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: L.vendorNumber,
    description:
      'My company’s own invoice number: once among its live invoices (VENDOR_INVOICE_DUPLICATE).',
  })
  @IsString()
  @Length(1, L.vendorNumber, withParams({ min: 1, max: L.vendorNumber }))
  vendorNumber: string;

  @ApiProperty({ type: String, pattern: LOCAL_DATE.source })
  @IsString()
  @IsLocalDate()
  issuedOn: string;

  @ApiProperty({ type: String, pattern: LOCAL_DATE.source })
  @IsString()
  @IsLocalDate()
  dueOn: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'One of my company’s contracts; or `purchaseRequestId`.',
  })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A line of that contract’s schedule, unpaid and not invoiced.',
  })
  @IsOptional()
  @IsUUID()
  contractPaymentId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A purchase my company fulfilled.',
  })
  @IsOptional()
  @IsUUID()
  purchaseRequestId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'My upload of purpose `expense_invoice`: the invoice’s scan.',
  })
  @IsUUID()
  invoiceFileId: string;

  @ApiProperty({ type: [InvoiceLineDto], minItems: 1, maxItems: L.lines })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: L.lines }))
  @ArrayMaxSize(L.lines, withParams({ min: 1, max: L.lines }))
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lines: InvoiceLineDto[];

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: L.note })
  @IsOptional()
  @IsString()
  @Length(1, L.note, withParams({ min: 1, max: L.note }))
  note?: string;
}

/**
 * A vendor's invoice as its contractors read it: what was sent and where it
 * stands, never the office's notes, line or approver.
 */
export class ContractorInvoiceView {
  @ApiProperty({ type: String, format: 'uuid' }) id: string;
  @ApiProperty({ type: String, example: 'VI-000001' }) number: string;
  @ApiProperty({ type: String }) vendorNumber: string;
  @ApiProperty({ type: String, example: '2027-06-01' }) issuedOn: string;
  @ApiProperty({ type: String, example: '2027-06-30' }) dueOn: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  contractId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  contractPaymentId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  purchaseRequestId: string | null;
  @ApiProperty({ type: String, example: '1200.00' }) subtotal: string;
  @ApiProperty({ type: String, example: '0.00' }) tax: string;
  @ApiProperty({ type: String, example: '1200.00' }) total: string;
  @ApiProperty({ enum: INVOICE_STATUSES, enumName: 'VendorInvoiceStatus' })
  status: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From the closed list `vendorInvoiceReject`.',
  })
  rejectReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) sentAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt: Date | null;

  static from(i: FinanceVendorInvoice): ContractorInvoiceView {
    return {
      id: i.id,
      number: formatNumber('vendor_invoice', i.number),
      vendorNumber: i.vendorNumber,
      issuedOn: fromDate(i.issuedOn),
      dueOn: fromDate(i.dueOn),
      contractId: i.contractId,
      contractPaymentId: i.contractPaymentId,
      purchaseRequestId: i.purchaseRequestId,
      subtotal: show(i.subtotal),
      tax: show(i.tax),
      total: show(i.total),
      status: i.status,
      rejectReason: i.rejectReason,
      sentAt: i.recordedAt,
      paidAt: i.paidAt,
    };
  }
}

/**
 * A vendor's contractor sends its vendor's invoices in (ADR 0088): into the
 * vendors' invoices (ADR 0089) by the `contractor` channel, against its
 * vendor's own contract or fulfilled purchase; then approved by another and
 * paid out exactly as the office's are.
 */
@ApiArea('contractor')
@RequirePermissions('vendor_invoices.submit')
@Controller('contractor/invoices')
export class ContractorInvoicesController {
  constructor(
    private readonly invoices: VendorInvoicesService,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List the invoices my company’s contractors sent in',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(ContractorInvoiceView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ContractorInvoiceView>> {
    const vendorId = await this.vendorOf();
    return toList(await this.invoices.sentIn(vendorId, q), (i) =>
      ContractorInvoiceView.from(i),
    );
  }

  /**
   * Not idempotent by key: the vendor's number once among its live
   * invoices (VENDOR_INVOICE_DUPLICATE) keeps a retry from sending it twice.
   */
  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Send my company’s invoice in' })
  @ApiCreatedResponse({ type: ContractorInvoiceView })
  async send(
    @Body() dto: ContractorInvoiceDto,
  ): Promise<ContractorInvoiceView> {
    const vendorId = await this.vendorOf();
    const r = await this.invoices.record(dto, { kind: 'contractor', vendorId });
    return ContractorInvoiceView.from(r.invoice);
  }

  /** The caller's vendor; it never changes (a trigger), so a short read. */
  private vendorOf(): Promise<string> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = await tx.account.findUnique({
        where: { id: this.ctx.accountId },
        select: { type: true, vendorId: true },
      });
      if (me?.type !== 'contractor' || !me.vendorId)
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          'Missing permission for this action',
        );
      return me.vendorId;
    });
  }
}
