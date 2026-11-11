import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import { RATE } from '../tax/tax-rules';
import {
  InvoiceMatchService,
  type MatchLineRead,
  type MatchRecord,
  type MatchSettingsRead,
} from './invoice-match.service';
import { MATCH_ISSUE_KINDS } from './match-rules';

const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;

/** The compound's match settings (ADR 0094), in percent and EGP. */
export class PurchaseOrderSettingsView {
  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'An invoice with no contract above this amount needs a purchase order (VENDOR_INVOICE_PO_REQUIRED); null: never, so invoices without one keep working.',
  })
  poRequiredAbove: string | null;
  @ApiProperty({
    type: String,
    example: '2.00',
    description:
      'A unit price may exceed the order’s by this percentage (and by the amount below a line); a lower price never blocks.',
  })
  pricePct: string;
  @ApiProperty({
    type: String,
    example: '0.00',
    description:
      'A quantity may exceed the ordered and the accepted by this percentage of it; also what a receipt may accept over the order.',
  })
  quantityPct: string;
  @ApiProperty({
    type: String,
    example: '100.00',
    description:
      'A line’s price variance may be this much money; an extra line (naming no order line) may be this much.',
  })
  amount: string;

  static from(s: MatchSettingsRead): PurchaseOrderSettingsView {
    return {
      poRequiredAbove: s.poRequiredAbove,
      pricePct: s.pricePct,
      quantityPct: s.quantityPct,
      amount: s.amount,
    };
  }
}

export class PurchaseOrderSettingsDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: AMOUNT.source,
    description: 'EGP, or null for never.',
  })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT)
  poRequiredAbove?: string | null;

  @ApiPropertyOptional({
    type: String,
    pattern: RATE.source,
    description: 'In percent, 0 to 100.',
  })
  @IsOptional()
  @IsString()
  @Matches(RATE)
  pricePct?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: RATE.source,
    description: 'In percent, 0 to 100.',
  })
  @IsOptional()
  @IsString()
  @Matches(RATE)
  quantityPct?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: AMOUNT.source,
    description: 'EGP.',
  })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT)
  amount?: string;
}

export class MatchOverrideDto {
  @ApiProperty({ type: String, description: 'REASON_CODES.matchOverride.' })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500, withParams({ min: 1, max: 500 }))
  note?: string;
}

export class MatchIssueView {
  @ApiProperty({ enum: MATCH_ISSUE_KINDS, enumName: 'MatchIssueKind' })
  kind: string;
  @ApiProperty({ type: Number, description: 'The invoice line’s position.' })
  position: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  orderLineId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The quantity over, for the quantity issues.',
  })
  quantity: string | null;
  @ApiProperty({
    type: String,
    description: 'The money over: the line’s price variance, or an extra line.',
  })
  amount: string;
}

/** An invoice line beside the order’s line it bills. */
export class MatchLineView {
  @ApiProperty({ type: Number }) position: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  orderLineId: string | null;
  @ApiProperty({ type: String }) description: string;
  @ApiProperty({ type: String, nullable: true }) invoiceQuantity: string | null;
  @ApiProperty({ type: String, nullable: true }) invoiceUnitPrice:
    string | null;
  @ApiProperty({ type: String }) amount: string;
  @ApiProperty({ type: String, nullable: true }) orderDescription:
    string | null;
  @ApiProperty({ type: String, nullable: true }) orderedQuantity: string | null;
  @ApiProperty({ type: String, nullable: true }) orderUnitPrice: string | null;
  @ApiProperty({ type: String, nullable: true }) acceptedQuantity:
    string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Billed by the other invoices that count before this one.',
  })
  otherInvoicedQuantity: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Signed: above (positive) or below the order’s price.',
  })
  priceDifference: string | null;
  @ApiProperty({ type: String, description: 'Signed.' }) priceVariance: string;
  @ApiProperty({
    enum: MATCH_ISSUE_KINDS,
    enumName: 'MatchIssueKind',
    isArray: true,
  })
  issues: string[];

  static from(l: MatchLineRead): MatchLineView {
    return {
      position: l.position,
      orderLineId: l.orderLineId,
      description: l.description,
      invoiceQuantity: l.invoiceQuantity,
      invoiceUnitPrice: l.invoiceUnitPrice,
      amount: l.amount,
      orderDescription: l.orderDescription,
      orderedQuantity: l.orderedQuantity,
      orderUnitPrice: l.orderUnitPrice,
      acceptedQuantity: l.acceptedQuantity,
      otherInvoicedQuantity: l.otherInvoicedQuantity,
      priceDifference: l.priceDifference,
      priceVariance: l.priceVariance,
      issues: l.issues,
    };
  }
}

export class MatchOverrideView {
  @ApiProperty({ type: String, description: 'REASON_CODES.matchOverride.' })
  reasonCode: string;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) overriddenAt: Date;
  @ApiProperty({ type: Boolean, description: 'The caller let it through.' })
  overriddenByMe: boolean;
}

/** An invoice’s three-way match (ADR 0094). */
export class InvoiceMatchView {
  @ApiProperty({ type: String, format: 'uuid' }) invoiceId: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Null: the invoice names no purchase order, so there is no match.',
  })
  purchaseOrderId: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'PO-000001' })
  orderReference: string | null;
  @ApiProperty({ type: String, nullable: true }) orderStatus: string | null;
  @ApiProperty({
    enum: ['none', 'matched', 'blocked', 'overridden'],
    enumName: 'InvoiceMatchStatus',
    description:
      '`matched`: within tolerance, it goes on to approval; `blocked`: it cannot be approved until resolved (a receipt, a corrected invoice) or overridden; `overridden`: let through with a reason.',
  })
  status: string;
  @ApiProperty({ type: [MatchIssueView] }) issues: MatchIssueView[];
  @ApiProperty({ type: [MatchLineView] }) lines: MatchLineView[];
  @ApiProperty({
    type: String,
    example: '0.00',
    description:
      'The lines’ price variances, signed, within tolerance or not: what the invoice costs over the order’s prices. It stays in the line’s budget category (ADR 0092).',
  })
  priceVariance: string;
  @ApiProperty({ type: PurchaseOrderSettingsView })
  tolerance: PurchaseOrderSettingsView;
  @ApiProperty({ type: MatchOverrideView, nullable: true })
  override: MatchOverrideView | null;

  static none(
    invoiceId: string,
    settings: MatchSettingsRead,
  ): InvoiceMatchView {
    return {
      invoiceId,
      purchaseOrderId: null,
      orderReference: null,
      orderStatus: null,
      status: 'none',
      issues: [],
      lines: [],
      priceVariance: '0.00',
      tolerance: PurchaseOrderSettingsView.from(settings),
      override: null,
    };
  }

  static from(m: MatchRecord, me: string): InvoiceMatchView {
    return {
      invoiceId: m.invoiceId,
      purchaseOrderId: m.orderId,
      orderReference: `PO-${String(m.orderNumber).padStart(6, '0')}`,
      orderStatus: m.orderStatus,
      status: m.status,
      issues: m.issues.map((i) => ({
        kind: i.kind,
        position: i.position,
        orderLineId: i.orderLineId,
        quantity: i.quantity,
        amount: i.amount,
      })),
      lines: m.lines.map((l) => MatchLineView.from(l)),
      priceVariance: m.priceVariance,
      tolerance: PurchaseOrderSettingsView.from(m.tolerance),
      override: m.override
        ? {
            reasonCode: m.override.reasonCode,
            note: m.override.note,
            overriddenAt: m.override.overriddenAt,
            overriddenByMe: m.override.overriddenById === me,
          }
        : null,
    };
  }
}

/**
 * The three-way match of a vendor’s invoice and the compound’s tolerances
 * (ADR 0094). The match is read live from the order, the receipts and the
 * other invoices; a mismatch is let through with `finance.match_override`,
 * never by who recorded the invoice. The settings are read with either
 * payables permission and kept with `finance.payables_approve`.
 */
@ApiArea('finance')
@Controller('staff/finance')
export class InvoiceMatchController {
  constructor(
    private readonly match: InvoiceMatchService,
    private readonly ctx: RequestContext,
  ) {}

  @Get('vendor-invoices/:id/match')
  @NoStore()
  @RequireAnyPermission('finance.payables', 'finance.payables_approve')
  @ApiOperation({
    summary: 'Read a vendor’s invoice against its purchase order',
    description:
      'Its lines beside the order’s lines, the quantities accepted and billed before, the price variance and the issues that block its approval. `status: none` when the invoice names no order.',
  })
  @ApiOkResponse({ type: InvoiceMatchView })
  async read(@Param('id', parseId()) id: string): Promise<InvoiceMatchView> {
    const m = await this.match.match(id);
    return m
      ? InvoiceMatchView.from(m, this.ctx.accountId)
      : InvoiceMatchView.none(id, await this.match.settings());
  }

  /** `reasonCode` from the closed list `matchOverride`. */
  @Post('vendor-invoices/:id/match/override')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('finance.match_override')
  @ApiOperation({
    summary: 'Let a mismatch through',
    description:
      'While the invoice waits for its approval and does not match: once, with a reason, by someone who did not record it (MATCH_SELF_OVERRIDE). Audited with the issues it let through.',
  })
  @ApiOkResponse({ type: InvoiceMatchView })
  async override(
    @Param('id', parseId()) id: string,
    @Body() dto: MatchOverrideDto,
  ): Promise<InvoiceMatchView> {
    return InvoiceMatchView.from(
      await this.match.override(id, dto),
      this.ctx.accountId,
    );
  }

  @Get('purchase-order-settings')
  @NoStore()
  @RequireAnyPermission('finance.payables', 'finance.payables_approve')
  @ApiOperation({
    summary: 'Read the match tolerances and when an order is required',
  })
  @ApiOkResponse({ type: PurchaseOrderSettingsView })
  async settings(): Promise<PurchaseOrderSettingsView> {
    return PurchaseOrderSettingsView.from(await this.match.settings());
  }

  @Patch('purchase-order-settings')
  @NoStore()
  @RequirePermissions('finance.payables_approve')
  @ApiOperation({
    summary: 'Change the match tolerances and when an order is required',
    description:
      'Applies from the next match; nothing is reposted. Audited with the old and new values.',
  })
  @ApiOkResponse({ type: PurchaseOrderSettingsView })
  async updateSettings(
    @Body() dto: PurchaseOrderSettingsDto,
  ): Promise<PurchaseOrderSettingsView> {
    return PurchaseOrderSettingsView.from(await this.match.updateSettings(dto));
  }
}
