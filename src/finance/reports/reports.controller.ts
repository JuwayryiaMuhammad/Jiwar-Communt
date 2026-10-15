import { Controller, Get, Query, type StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { csvFile } from './csv';
import { LedgerFilterDto, LedgerQueryDto } from './dto/ledger.dto';
import { LedgerService } from './ledger.service';
import { LedgerEntryView } from './views/ledger.views';

/**
 * The compound's ledger and its finance reports (ADR 0048), each with a CSV
 * twin. Read by the manager and the accountant (finance.reports).
 */
@ApiArea('finance')
@RequirePermissions('finance.reports')
@Controller('staff/finance')
export class ReportsController {
  constructor(private readonly ledger: LedgerService) {}

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
}
