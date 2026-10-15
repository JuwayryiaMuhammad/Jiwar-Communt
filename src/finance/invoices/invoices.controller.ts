import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  CreditNoteDto,
  InvoiceStatusQueryDto,
  IssueInvoicesDto,
  StaffInvoicesQueryDto,
} from './dto/invoices.dto';
import { InvoicesService } from './invoices.service';
import {
  CreditNoteView,
  InvoiceBatchView,
  InvoiceDetailView,
  InvoiceView,
} from './views/invoice.views';

/** Invoices and credit notes, for the staff who issue them (ADR 0046). */
@ApiArea('finance')
@RequirePermissions('finance.invoice')
@Controller('staff')
export class StaffInvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post('invoices')
  @ApiOperation({
    summary: 'Issue an invoice to one unit, a building’s units or every unit',
    description:
      'One invoice per unit, each with its own number; announced to the units’ finance holders.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: InvoiceBatchView })
  issue(@Body() dto: IssueInvoicesDto): Promise<InvoiceBatchView> {
    return this.invoices.issue(dto);
  }

  @Get('invoice-batches/:id')
  @ApiOperation({ summary: 'Get one issue: whom it reached and its numbers' })
  @ApiOkResponse({ type: InvoiceBatchView })
  batch(@Param('id', parseId()) id: string): Promise<InvoiceBatchView> {
    return this.invoices.batch(id);
  }

  @Get('invoices')
  @ApiOperation({ summary: 'List invoices, newest first' })
  @ApiOkResponse({ type: ListOf(InvoiceView) })
  async list(
    @Query() q: StaffInvoicesQueryDto,
  ): Promise<ListResponse<InvoiceView>> {
    return toList(await this.invoices.list(q), (v) => v);
  }

  @Get('invoices/:id')
  @ApiOperation({
    summary: 'Get an invoice with its lines, credit notes and payments',
  })
  @ApiOkResponse({ type: InvoiceDetailView })
  detail(@Param('id', parseId()) id: string): Promise<InvoiceDetailView> {
    return this.invoices.detail(id);
  }

  @Post('invoices/:id/credit-notes')
  @ApiOperation({
    summary: 'Credit part or all of an invoice, with a reason code',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: CreditNoteView })
  credit(
    @Param('id', parseId()) id: string,
    @Body() dto: CreditNoteDto,
  ): Promise<CreditNoteView> {
    return this.invoices.credit(id, dto);
  }
}

/**
 * A unit's invoices, for whoever sees its money (capabilities.financeView,
 * ADR 0046): its owners, its tenants, members the primary gave `finance`.
 */
@ApiArea('finance')
@RequirePermissions('units.read')
@Controller()
export class UnitInvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get('units/:unitId/invoices')
  @ApiOperation({ summary: 'List a unit’s invoices, newest first' })
  @ApiOkResponse({ type: ListOf(InvoiceView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: InvoiceStatusQueryDto,
  ): Promise<ListResponse<InvoiceView>> {
    return toList(await this.invoices.forUnit(unitId, q), (v) => v);
  }

  @Get('invoices/:id')
  @ApiOperation({ summary: 'Get one of my units’ invoices' })
  @ApiOkResponse({ type: InvoiceDetailView })
  detail(@Param('id', parseId()) id: string): Promise<InvoiceDetailView> {
    return this.invoices.mine(id);
  }
}
