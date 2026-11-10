import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { firstDay } from '../gl/gl-rules';
import { TaxSettingsService } from './tax-settings.service';
import { TaxService } from './tax.service';
import {
  TaxPaymentDto,
  TaxPaymentsQueryDto,
  TaxSettingsDto,
  TaxVendorDto,
  VatDeclareDto,
  WithholdingCertificatesQueryDto,
} from './tax.dto';
import {
  TaxPaymentView,
  TaxSettingsView,
  TaxVendorView,
  VatMonthView,
  WithholdingCertificateView,
  WithholdingQuarterView,
} from './tax.views';

/**
 * Taxes (ADR 0093): the compound's VAT and withholding settings, its
 * vendors' withholding categories, the monthly VAT declaration, the
 * withholding certificates and quarters, and the taxes paid. Read with
 * `finance.ledger`; kept, declared and paid with `finance.ledger_write`.
 * Every response no-store: the compound's books.
 */
@ApiArea('finance')
@Controller('staff/finance/tax')
export class TaxController {
  constructor(
    private readonly settings: TaxSettingsService,
    private readonly tax: TaxService,
  ) {}

  // --------------------------------------------------------------------------
  // Settings
  // --------------------------------------------------------------------------

  @Get('settings')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({ summary: 'The compound’s tax settings' })
  @ApiOkResponse({ type: TaxSettingsView })
  async getSettings(): Promise<TaxSettingsView> {
    return TaxSettingsView.from(await this.settings.get());
  }

  @Patch('settings')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({
    summary: 'Change the compound’s tax settings',
    description:
      'VAT registered or not (off by default; its number required while on), its rate (14 %), the taxable invoice kinds and the categories whose input VAT is recovered (none by default); withholding on or off (off), its rates (supplies 1 %, services 3 %, professional fees 5 %) and its threshold (300 EGP). A change applies from the next event; nothing is reposted. Audited.',
  })
  @ApiOkResponse({ type: TaxSettingsView })
  async setSettings(@Body() dto: TaxSettingsDto): Promise<TaxSettingsView> {
    return TaxSettingsView.from(await this.settings.update(dto));
  }

  @Get('vendors')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'The vendors and what their payouts withhold by, newest first',
  })
  @ApiOkResponse({ type: ListOf(TaxVendorView) })
  async vendors(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<TaxVendorView>> {
    return toList(await this.settings.vendors(q), (v) => TaxVendorView.from(v));
  }

  @Put('vendors/:id')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({
    summary: 'Set a vendor’s withholding category',
    description:
      'Its payouts from now withhold by it, unless an invoice names its own; null: by its trades. Audited.',
  })
  @ApiOkResponse({ type: TaxVendorView })
  async setVendor(
    @Param('id', parseId()) id: string,
    @Body() dto: TaxVendorDto,
  ): Promise<TaxVendorView> {
    return TaxVendorView.from(
      await this.settings.setVendorCategory(id, dto.withholdingCategory),
    );
  }

  // --------------------------------------------------------------------------
  // VAT
  // --------------------------------------------------------------------------

  @Get('vat/months')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'The months’ VAT, newest first',
    description:
      'From the month VAT began to this one (at most 36): from the ledger by its entries’ days, or as declared.',
  })
  @ApiOkResponse({ type: ListOf(VatMonthView) })
  async vatMonths(): Promise<ListResponse<VatMonthView>> {
    return bounded(await this.tax.vatMonths(), (m) => VatMonthView.from(m));
  }

  @Post('vat/declarations')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({
    summary: 'Declare a month’s VAT',
    description:
      'A month the ledger closed (TAX_MONTH_NOT_CLOSED), the next one (TAX_MONTH_OUT_OF_ORDER {next}), once (TAX_MONTH_DECLARED): its figures are locked, the input set off against the output, due or carried forward. The month is not reopened after. Audited.',
  })
  @ApiCreatedResponse({ type: VatMonthView })
  async declare(@Body() dto: VatDeclareDto): Promise<VatMonthView> {
    return VatMonthView.from(await this.tax.declare(firstDay(dto.month)));
  }

  // --------------------------------------------------------------------------
  // Withholding
  // --------------------------------------------------------------------------

  @Get('withholding/quarters')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'The calendar quarters’ tax withheld and paid, newest first',
  })
  @ApiOkResponse({ type: ListOf(WithholdingQuarterView) })
  async quarters(): Promise<ListResponse<WithholdingQuarterView>> {
    return bounded(await this.tax.quarters(), (q) =>
      WithholdingQuarterView.from(q),
    );
  }

  @Get('withholding/certificates')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({ summary: 'The withholding certificates, newest first' })
  @ApiOkResponse({ type: ListOf(WithholdingCertificateView) })
  async certificates(
    @Query() q: WithholdingCertificatesQueryDto,
  ): Promise<ListResponse<WithholdingCertificateView>> {
    return toList(await this.tax.certificates(q), (c) =>
      WithholdingCertificateView.from(c),
    );
  }

  @Get('withholding/certificates/:id')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({ summary: 'A withholding certificate' })
  @ApiOkResponse({ type: WithholdingCertificateView })
  async certificate(
    @Param('id', parseId()) id: string,
  ): Promise<WithholdingCertificateView> {
    return WithholdingCertificateView.from(await this.tax.certificate(id));
  }

  @Get('withholding/certificates/:id/pdf')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'A withholding certificate as a PDF, for its vendor',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async certificatePdf(
    @Param('id', parseId()) id: string,
  ): Promise<StreamableFile> {
    const { name, body } = await this.tax.certificatePdf(id);
    return new StreamableFile(body, {
      type: 'application/pdf',
      disposition: `attachment; filename="${name}"`,
    });
  }

  // --------------------------------------------------------------------------
  // Paid to the tax authority
  // --------------------------------------------------------------------------

  @Get('payments')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({ summary: 'The taxes paid, newest first' })
  @ApiOkResponse({ type: ListOf(TaxPaymentView) })
  async payments(
    @Query() q: TaxPaymentsQueryDto,
  ): Promise<ListResponse<TaxPaymentView>> {
    return toList(await this.tax.payments(q), (p) => TaxPaymentView.from(p));
  }

  @Post('payments')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({
    summary: 'Pay VAT or withholding to the tax authority',
    description:
      'VAT against a declaration, withholding against a calendar quarter, at most what is still due (TAX_PAYMENT_EXCEEDED {open}), from a treasury account of the method’s kind (a `tax_payment` movement); it posts against VAT payable or withholding payable. Audited.',
  })
  @ApiCreatedResponse({ type: TaxPaymentView })
  async pay(@Body() dto: TaxPaymentDto): Promise<TaxPaymentView> {
    return TaxPaymentView.from(await this.tax.pay(dto));
  }
}
