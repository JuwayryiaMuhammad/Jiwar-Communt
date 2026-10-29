import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { PeriodQueryDto } from './period';
import { TechnicianStatsService } from './technician-stats.service';
import { TechnicianStatsView } from './views/economics.views';

/** The technician's own work over a period (ADR 0065). */
@ApiArea('maintenance')
@RequirePermissions('tickets.work')
@Controller('technician/stats')
export class MyTechnicianStatsController {
  constructor(private readonly stats: TechnicianStatsService) {}

  @Get()
  @ApiOperation({ summary: 'Get how my work went over a period' })
  @ApiOkResponse({ type: TechnicianStatsView })
  async mine(@Query() q: PeriodQueryDto): Promise<TechnicianStatsView> {
    return TechnicianStatsView.from(await this.stats.mine(q));
  }
}

/** Every technician's work over a period, for dispatch (ADR 0065). */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/technicians')
export class TechnicianStatsController {
  constructor(private readonly stats: TechnicianStatsService) {}

  @Get('stats')
  @ApiOperation({
    summary: 'List how each technician’s work went over a period',
  })
  @ApiOkResponse({ type: ListOf(TechnicianStatsView) })
  async all(
    @Query() q: PeriodQueryDto,
  ): Promise<ListResponse<TechnicianStatsView>> {
    return bounded(await this.stats.all(q), (t) => TechnicianStatsView.from(t));
  }

  @Get(':id/stats')
  @ApiOperation({ summary: 'Get how a technician’s work went over a period' })
  @ApiOkResponse({ type: TechnicianStatsView })
  async one(
    @Param('id', parseId()) id: string,
    @Query() q: PeriodQueryDto,
  ): Promise<TechnicianStatsView> {
    return TechnicianStatsView.from(await this.stats.one(id, q));
  }
}
