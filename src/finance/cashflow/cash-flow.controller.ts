import {
  Body,
  Controller,
  Get,
  Patch,
  Query,
  type StreamableFile,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces } from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { csvFile } from '../../core/common/csv';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { CashFlowQueryDto, CashFlowSettingsDto } from './cash-flow.dto';
import { CashFlowService } from './cash-flow.service';
import { CashFlowSettingsView, CashFlowView } from './cash-flow.views';

/**
 * The cash flow forecast and liquidity (ADR 0091): read with
 * `finance.cashflow`; the compound's minimum cash set by who keeps the
 * treasury (`finance.treasury`). Every response no-store: balances.
 */
@ApiArea('finance')
@Controller('staff/finance/cash-flow')
export class CashFlowController {
  constructor(private readonly cashFlow: CashFlowService) {}

  @Get()
  @NoStore()
  @RequirePermissions('finance.cashflow')
  @ApiOperation({
    summary: 'Forecast the cash flow',
    description:
      'From today, by the compound’s weeks (Saturday to Friday; 13 by default) or months (6): the opening position (the bank and cash accounts’ balances), what payables schedules out (approved invoices by due day, unpaid contract payments, purchases’ open commitments, advances and releases asked for or approved, retentions at the contract’s end), and what the residents’ dues bring in at the collection rate of the 90 days before today, with each period’s closing balance against the compound’s minimum. Overdue payables fall in the first period; overdue and disputed dues are shown, not counted.',
  })
  @ApiOkResponse({ type: CashFlowView })
  async forecast(@Query() q: CashFlowQueryDto): Promise<CashFlowView> {
    return CashFlowView.from(await this.cashFlow.forecast(q));
  }

  @Get('export')
  @NoStore()
  @RequirePermissions('finance.cashflow')
  @ApiOperation({ summary: 'Export the cash flow forecast as CSV' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(@Query() q: CashFlowQueryDto): Promise<StreamableFile> {
    const { name, body } = await this.cashFlow.csv(q);
    return csvFile(name, body);
  }

  @Get('settings')
  @NoStore()
  @RequireAnyPermission('finance.cashflow', 'finance.treasury')
  @ApiOperation({ summary: 'Read the compound’s minimum cash' })
  @ApiOkResponse({ type: CashFlowSettingsView })
  async settings(): Promise<CashFlowSettingsView> {
    return CashFlowSettingsView.from(await this.cashFlow.settingsView());
  }

  @Patch('settings')
  @NoStore()
  @RequirePermissions('finance.treasury')
  @ApiOperation({
    summary: 'Set the compound’s minimum cash',
    description:
      'Null turns the floor and its notice off. The `finance.cashflow` holders are told once a dip below it (`finance.cash_low`), at most once a day.',
  })
  @ApiOkResponse({ type: CashFlowSettingsView })
  async setSettings(
    @Body() dto: CashFlowSettingsDto,
  ): Promise<CashFlowSettingsView> {
    return CashFlowSettingsView.from(
      await this.cashFlow.setMinimum(dto.minimumCash),
    );
  }
}
