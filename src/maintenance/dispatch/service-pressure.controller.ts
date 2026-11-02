import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { UpdateServicePressureDto } from './dto/service-pressure.dto';
import { ServicePressure } from './service-pressure';
import { ServicePressureView } from './views/service-pressure.views';

/** Service pressure (ADR 0079): read by the dispatch, set by the managers. */
@ApiArea('maintenance')
@Controller('maintenance/service-pressure')
export class ServicePressureController {
  constructor(private readonly pressure: ServicePressure) {}

  @Get()
  @RequirePermissions('tickets.dispatch')
  @ApiOperation({
    summary: 'Read the open tickets against the technicians available',
  })
  @ApiOkResponse({ type: ServicePressureView })
  async get(): Promise<ServicePressureView> {
    return ServicePressureView.from(await this.pressure.get());
  }

  @Patch()
  @RequirePermissions('maintenance.manage')
  @ApiOperation({
    summary: 'Set the service-pressure threshold',
    description:
      'The dispatch and the managers are told once a rise, at most once an hour; null turns the alert off and ends a rise in course.',
  })
  @ApiOkResponse({ type: ServicePressureView })
  async update(
    @Body() dto: UpdateServicePressureDto,
  ): Promise<ServicePressureView> {
    return ServicePressureView.from(
      await this.pressure.update(dto.openPerTechnician),
    );
  }
}
