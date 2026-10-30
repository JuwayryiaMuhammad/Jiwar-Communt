import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  ConsumptionBenchmarkQueryDto,
  HouseholdConsumptionQueryDto,
} from './dto/household.dto';
import { HouseholdConsumptionService } from './household-consumption.service';
import {
  ConsumptionBenchmarkView,
  HouseholdConsumptionView,
} from './views/household.views';

/**
 * A household's own consumption (ADR 0069): who lives in the unit, or a
 * member given `finance` (capabilities.consumptionView); a landlord is
 * refused with CONSUMPTION_NOT_ALLOWED.
 */
@ApiArea('maintenance')
@RequirePermissions('units.read')
@Controller('units/:unitId/consumption')
export class HouseholdConsumptionController {
  constructor(private readonly household: HouseholdConsumptionService) {}

  @Get()
  @ApiOperation({
    summary: 'Read my household’s consumption by kind and month',
  })
  @ApiOkResponse({ type: HouseholdConsumptionView })
  async read(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: HouseholdConsumptionQueryDto,
  ): Promise<HouseholdConsumptionView> {
    return HouseholdConsumptionView.from(await this.household.read(unitId, q));
  }

  @Get('benchmark')
  @ApiOperation({
    summary: 'Compare a month of my household with other homes of its building',
  })
  @ApiOkResponse({ type: ConsumptionBenchmarkView })
  async benchmark(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: ConsumptionBenchmarkQueryDto,
  ): Promise<ConsumptionBenchmarkView> {
    return ConsumptionBenchmarkView.from(
      await this.household.benchmark(unitId, q),
    );
  }
}
