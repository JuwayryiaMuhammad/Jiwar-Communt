import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ContractMoneyService } from './contract-money.service';
import {
  ApproveVendorInvoiceDto,
  DisbursementDto,
  GuaranteeCloseDto,
  GuaranteeDto,
  InvoicePayoutDto,
  PayoutDto,
  PaymentScheduleQueryDto,
  RecordVendorInvoiceDto,
  VendorInvoicesQueryDto,
} from './dto/payables.dto';
import { PayablesReportsService } from './payables-reports.service';
import { VendorInvoicesService } from './vendor-invoices.service';
import {
  ContractPositionView,
  DisbursementView,
  GuaranteeView,
  PaymentScheduleView,
  VendorInvoiceView,
} from './views/payables.views';

/**
 * Payables (ADR 0089): vendors' invoices, a contract's advances, retention
 * and guarantees, the payouts and the payment schedule. `finance.payables`
 * records and pays; `finance.payables_approve` approves, never what the
 * caller recorded or asked for. Every read is open to both.
 */
@ApiArea('finance')
@Controller('staff/finance')
export class PayablesController {
  constructor(
    private readonly invoices: VendorInvoicesService,
    private readonly money: ContractMoneyService,
    private readonly reports: PayablesReportsService,
  ) {}

  @Post('vendor-invoices')
  @RequirePermissions('finance.payables')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Record a vendor’s invoice',
    description:
      'Against one of its contracts (a line of its schedule, or the contract) or a purchase request it fulfilled, with its scan and lines (each with a tax code, zero by default). Its number once among the vendor’s live invoices (VENDOR_INVOICE_DUPLICATE); VENDOR_INVOICE_SOURCE_INVALID with a reason. The approvers are told.',
  })
  @ApiCreatedResponse({ type: VendorInvoiceView })
  async record(
    @Body() dto: RecordVendorInvoiceDto,
  ): Promise<VendorInvoiceView> {
    return VendorInvoiceView.from(await this.invoices.record(dto));
  }

  @Get('vendor-invoices')
  @RequireAnyPermission('finance.payables', 'finance.payables_approve')
  @NoStore()
  @ApiOperation({
    summary: 'List vendors’ invoices',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(VendorInvoiceView) })
  async list(
    @Query() q: VendorInvoicesQueryDto,
  ): Promise<ListResponse<VendorInvoiceView>> {
    return toList(await this.invoices.list(q), (r) =>
      VendorInvoiceView.from(r),
    );
  }

  @Get('vendor-invoices/:id')
  @RequireAnyPermission('finance.payables', 'finance.payables_approve')
  @NoStore()
  @ApiOperation({ summary: 'Read a vendor’s invoice' })
  @ApiOkResponse({ type: VendorInvoiceView })
  async get(@Param('id', parseId()) id: string): Promise<VendorInvoiceView> {
    return VendorInvoiceView.from(await this.invoices.get(id));
  }

  @Post('vendor-invoices/:id/approve')
  @RequirePermissions('finance.payables_approve')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Approve a vendor’s invoice',
    description:
      'Not by who recorded it (PAYABLE_SELF_APPROVAL). On a line of the active budget: its commitment is given back, and the line must have the rest available (BUDGET_LINE_INSUFFICIENT). Above the manager’s limit, under the board’s approved major contract (EXPENSE_NEEDS_APPROVAL, EXPENSE_AUTHORIZATION_EXCEEDED).',
  })
  @ApiOkResponse({ type: VendorInvoiceView })
  async approve(
    @Param('id', parseId()) id: string,
    @Body() dto: ApproveVendorInvoiceDto,
  ): Promise<VendorInvoiceView> {
    return VendorInvoiceView.from(await this.invoices.approve(id, dto));
  }

  @Post('vendor-invoices/:id/reject')
  @RequirePermissions('finance.payables_approve')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Turn down a vendor’s invoice',
    description: 'A `vendorInvoiceReject` code.',
  })
  @ApiOkResponse({ type: VendorInvoiceView })
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<VendorInvoiceView> {
    return VendorInvoiceView.from(await this.invoices.reject(id, dto));
  }

  @Post('vendor-invoices/:id/cancel')
  @RequireAnyPermission('finance.payables', 'finance.payables_approve')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Call off a vendor’s invoice',
    description:
      'A `vendorInvoiceCancel` code; an approved one only by an approver (VENDOR_INVOICE_STATE).',
  })
  @ApiOkResponse({ type: VendorInvoiceView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<VendorInvoiceView> {
    return VendorInvoiceView.from(await this.invoices.cancel(id, dto));
  }

  @Post('vendor-invoices/:id/pay')
  @RequirePermissions('finance.payables')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Pay out an approved vendor’s invoice',
    description:
      'Once: writes its expense on its line, holds back the contract’s retention, sets off its open advances as asked (ADVANCE_SET_OFF_EXCEEDED), and marks a schedule payment paid.',
  })
  @ApiOkResponse({ type: VendorInvoiceView })
  async pay(
    @Param('id', parseId()) id: string,
    @Body() dto: InvoicePayoutDto,
  ): Promise<VendorInvoiceView> {
    return VendorInvoiceView.from(await this.invoices.pay(id, dto));
  }

  @Get('payment-schedule')
  @RequireAnyPermission('finance.payables', 'finance.payables_approve')
  @NoStore()
  @ApiOperation({
    summary: 'Read the payment schedule',
    description:
      'Approved invoices by their due day and what commitments keep by theirs; by default next month (next month’s commitments). At most 366 days.',
  })
  @ApiOkResponse({ type: PaymentScheduleView })
  schedule(@Query() q: PaymentScheduleQueryDto): Promise<PaymentScheduleView> {
    return this.reports.schedule(q);
  }

  // --------------------------------------------------------------------------
  // A contract's money
  // --------------------------------------------------------------------------

  @Get('contract-payables/:contractId')
  @RequireAnyPermission('finance.payables', 'finance.payables_approve')
  @NoStore()
  @ApiOperation({
    summary: 'Read a contract’s money with its vendor',
    description: 'Its advances, retention, invoices, requests and guarantees.',
  })
  @ApiOkResponse({ type: ContractPositionView })
  async position(
    @Param('contractId', parseId('contractId')) contractId: string,
  ): Promise<ContractPositionView> {
    return ContractPositionView.from(
      await this.money.contractPosition(contractId),
    );
  }

  @Post('contract-payables/:contractId/disbursements')
  @RequirePermissions('finance.payables')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Ask for an advance or a retention’s release',
    description:
      'An advance within what the contract’s value leaves (ADVANCE_EXCEEDED); a release after its end (RETENTION_NOT_DUE), within what is held (RETENTION_EXCEEDED). The approvers are told.',
  })
  @ApiCreatedResponse({ type: DisbursementView })
  async request(
    @Param('contractId', parseId('contractId')) contractId: string,
    @Body() dto: DisbursementDto,
  ): Promise<DisbursementView> {
    return DisbursementView.from(await this.money.request(contractId, dto));
  }

  @Post('contract-payables/:contractId/guarantees')
  @RequirePermissions('finance.payables')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Record a guarantee on a contract',
    description: 'Its expiry is told 30 days ahead, once.',
  })
  @ApiCreatedResponse({ type: GuaranteeView })
  async guarantee(
    @Param('contractId', parseId('contractId')) contractId: string,
    @Body() dto: GuaranteeDto,
  ): Promise<GuaranteeView> {
    return GuaranteeView.from(
      await this.money.recordGuarantee(contractId, dto),
    );
  }

  @Post('vendor-guarantees/:id/close')
  @RequirePermissions('finance.payables_approve')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Return a guarantee, or call it',
    description: 'Once (GUARANTEE_STATE).',
  })
  @ApiOkResponse({ type: GuaranteeView })
  async closeGuarantee(
    @Param('id', parseId()) id: string,
    @Body() dto: GuaranteeCloseDto,
  ): Promise<GuaranteeView> {
    return GuaranteeView.from(await this.money.closeGuarantee(id, dto.outcome));
  }

  @Get('contract-disbursements')
  @RequireAnyPermission('finance.payables', 'finance.payables_approve')
  @NoStore()
  @ApiOperation({
    summary: 'Advances and releases waiting for a decision or a payout',
    description: 'Oldest first.',
  })
  @ApiOkResponse({ type: [DisbursementView] })
  async pending(): Promise<DisbursementView[]> {
    return (await this.money.pending()).map((d) => DisbursementView.from(d));
  }

  @Get('contract-disbursements/:id')
  @RequireAnyPermission('finance.payables', 'finance.payables_approve')
  @NoStore()
  @ApiOperation({ summary: 'Read an advance or a retention’s release' })
  @ApiOkResponse({ type: DisbursementView })
  async disbursement(
    @Param('id', parseId()) id: string,
  ): Promise<DisbursementView> {
    return DisbursementView.from(await this.money.get(id));
  }

  @Post('contract-disbursements/:id/approve')
  @RequirePermissions('finance.payables_approve')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Approve an advance or a retention’s release',
    description:
      'Not by who asked for it (PAYABLE_SELF_APPROVAL); above the manager’s limit only on a contract the board signed (DISBURSEMENT_NEEDS_APPROVAL).',
  })
  @ApiOkResponse({ type: DisbursementView })
  async approveDisbursement(
    @Param('id', parseId()) id: string,
  ): Promise<DisbursementView> {
    return DisbursementView.from(await this.money.approve(id));
  }

  @Post('contract-disbursements/:id/reject')
  @RequirePermissions('finance.payables_approve')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Turn down an advance or a release',
    description: 'A `disbursementReject` code.',
  })
  @ApiOkResponse({ type: DisbursementView })
  async rejectDisbursement(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<DisbursementView> {
    return DisbursementView.from(await this.money.reject(id, dto.reasonCode));
  }

  @Post('contract-disbursements/:id/cancel')
  @RequireAnyPermission('finance.payables', 'finance.payables_approve')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Call off an advance or a release',
    description: 'Before it is paid; a `disbursementCancel` code.',
  })
  @ApiOkResponse({ type: DisbursementView })
  async cancelDisbursement(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<DisbursementView> {
    return DisbursementView.from(await this.money.cancel(id, dto.reasonCode));
  }

  @Post('contract-disbursements/:id/pay')
  @RequirePermissions('finance.payables')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Pay out an approved advance or release',
    description: 'Once, whole.',
  })
  @ApiOkResponse({ type: DisbursementView })
  async payDisbursement(
    @Param('id', parseId()) id: string,
    @Body() dto: PayoutDto,
  ): Promise<DisbursementView> {
    return DisbursementView.from(await this.money.pay(id, dto));
  }
}
