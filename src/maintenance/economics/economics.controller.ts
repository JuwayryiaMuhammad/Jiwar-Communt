import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { EconomicsService } from './economics.service';
import { PeriodQueryDto } from './period';
import {
  AssetEconomicsView,
  CompoundEconomicsView,
  MaintenanceKpisView,
} from './views/economics.views';

/** Asset economics and the maintenance KPIs (ADR 0065), computed on read. */
@ApiArea('maintenance')
@RequirePermissions('assets.manage')
@Controller('maintenance')
export class EconomicsController {
  constructor(private readonly economics: EconomicsService) {}

  @Get('assets/:id/economics')
  @ApiOperation({
    summary: 'Get what an asset cost, its downtime and the advice',
  })
  @ApiOkResponse({ type: AssetEconomicsView })
  async asset(@Param('id', parseId()) id: string): Promise<AssetEconomicsView> {
    return AssetEconomicsView.from(await this.economics.asset(id));
  }

  @Get('economics')
  @ApiOperation({
    summary: 'Get the compound’s maintenance spend and capital plan',
  })
  @ApiOkResponse({ type: CompoundEconomicsView })
  async compound(@Query() q: PeriodQueryDto): Promise<CompoundEconomicsView> {
    return CompoundEconomicsView.from(await this.economics.compound(q));
  }

  @Get('kpis')
  @ApiOperation({ summary: 'Get the maintenance KPIs over a period' })
  @ApiOkResponse({ type: MaintenanceKpisView })
  async kpis(@Query() q: PeriodQueryDto): Promise<MaintenanceKpisView> {
    return MaintenanceKpisView.from(await this.economics.kpis(q));
  }
}
