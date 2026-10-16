import { Controller, Get, Query, type StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { csvFile } from '../../core/common/csv';
import { LedgerFilterDto, LedgerQueryDto } from './dto/ledger.dto';
import {
  CollectionsQueryDto,
  DailyCashQueryDto,
  UnitReportQueryDto,
} from './dto/reports.dto';
import { LedgerService } from './ledger.service';
import { ReportsService } from './reports.service';
import { LedgerEntryView } from './views/ledger.views';
import {
  AgingView,
  CollectionsView,
  DailyCashView,
  OutstandingView,
} from './views/reports.views';

/**
 * The compound's ledger and its finance reports (ADR 0048), each with a CSV
 * twin. Read by the manager and the accountant (finance.reports).
 */
@ApiArea('finance')
@RequirePermissions('finance.reports')
@Controller('staff/finance')
export class ReportsController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly reports: ReportsService,
  ) {}

  @Get('ledger')
  @ApiOperation({
    summary: 'Read the compound’s ledger for a period, oldest first',
    description:
      'Every invoice, credit note, payment, refund, their reversals, credit applied and released, from the units’ side. Not double-entry.',
  })
  @ApiOkResponse({ type: ListOf(LedgerEntryView) })
  async page(
    @Query() q: LedgerQueryDto,
  ): Promise<ListResponse<LedgerEntryView>> {
    return toList(await this.ledger.page(q), (v) => v);
  }

  @Get('ledger/export')
  @NoStore()
  @ApiOperation({
    summary: 'Export the ledger for a period as CSV',
    description:
      'The same rows as the ledger, every one (EXPORT_TOO_LARGE past the limit).',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(@Query() q: LedgerFilterDto): Promise<StreamableFile> {
    return csvFile(`ledger-${q.from}_${q.to}.csv`, await this.ledger.export(q));
  }

  @Get('reports/aging')
  @ApiOperation({
    summary: 'Read what is owed today by how far past its due date',
    description:
      'Not yet due, 1–30, 31–60, 61–90 and 91 days or more; per unit or per building.',
  })
  @ApiOkResponse({ type: AgingView })
  aging(@Query() q: UnitReportQueryDto): Promise<AgingView> {
    return this.reports.aging(q);
  }

  @Get('reports/aging/export')
  @NoStore()
  @ApiOperation({ summary: 'Export the aging report as CSV' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async agingCsv(@Query() q: UnitReportQueryDto): Promise<StreamableFile> {
    const { name, body } = await this.reports.agingCsv(q);
    return csvFile(name, body);
  }

  @Get('reports/collections')
  @ApiOperation({
    summary: 'Read the money received in a period by channel and method',
    description:
      'A payment counts on the day it was paid, a reversal on the day it was recorded; per day or per month.',
  })
  @ApiOkResponse({ type: CollectionsView })
  collections(@Query() q: CollectionsQueryDto): Promise<CollectionsView> {
    return this.reports.collections(q);
  }

  @Get('reports/collections/export')
  @NoStore()
  @ApiOperation({ summary: 'Export the collections report as CSV' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async collectionsCsv(
    @Query() q: CollectionsQueryDto,
  ): Promise<StreamableFile> {
    const { name, body } = await this.reports.collectionsCsv(q);
    return csvFile(name, body);
  }

  @Get('reports/outstanding')
  @ApiOperation({
    summary: 'Read what each unit or building owes today, and its credit',
  })
  @ApiOkResponse({ type: OutstandingView })
  outstanding(@Query() q: UnitReportQueryDto): Promise<OutstandingView> {
    return this.reports.outstanding(q);
  }

  @Get('reports/outstanding/export')
  @NoStore()
  @ApiOperation({ summary: 'Export the outstanding report as CSV' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async outstandingCsv(
    @Query() q: UnitReportQueryDto,
  ): Promise<StreamableFile> {
    const { name, body } = await this.reports.outstandingCsv(q);
    return csvFile(name, body);
  }

  @Get('reports/daily-cash')
  @ApiOperation({
    summary: 'Read the office’s day per recorder and method, for closing',
    description:
      'Office payments and their reversals recorded that day, and cash refunds recorded that day less those reversed that day.',
  })
  @ApiOkResponse({ type: DailyCashView })
  dailyCash(@Query() q: DailyCashQueryDto): Promise<DailyCashView> {
    return this.reports.dailyCash(q);
  }

  @Get('reports/daily-cash/export')
  @NoStore()
  @ApiOperation({ summary: 'Export the office’s day as CSV' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async dailyCashCsv(@Query() q: DailyCashQueryDto): Promise<StreamableFile> {
    const { name, body } = await this.reports.dailyCashCsv(q);
    return csvFile(name, body);
  }
}
