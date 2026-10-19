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
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  EnterServiceVehicleDto,
  ServiceVehicleLogQueryDto,
} from './dto/service-vehicles.dto';
import { ServiceVehiclesService } from './service-vehicles.service';
import { ServiceVehicleResponse } from './views/service-vehicle.views';

/** The guard records service vehicles in and out (ADR 0056). */
@ApiArea('gate')
@RequirePermissions('gate.operate')
@Controller('gate/service-vehicles')
export class GuardServiceVehiclesController {
  constructor(private readonly vehicles: ServiceVehiclesService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Record a service vehicle coming in at my gate',
    description:
      'Inside a shift at a gate. Refused during a lockdown (LOCKDOWN_ACTIVE) and for a banned plate (ENTRY_BLOCKED); a watched one comes in, flagged. A plate is inside once at a time (SERVICE_VEHICLE_INSIDE).',
  })
  @ApiCreatedResponse({ type: ServiceVehicleResponse })
  async enter(
    @Body() dto: EnterServiceVehicleDto,
  ): Promise<ServiceVehicleResponse> {
    return ServiceVehicleResponse.from(await this.vehicles.enter(dto));
  }

  @Post(':id/exit')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({ summary: 'Record a service vehicle leaving, at my gate' })
  @ApiOkResponse({ type: ServiceVehicleResponse })
  async exit(
    @Param('id', parseId()) id: string,
  ): Promise<ServiceVehicleResponse> {
    return ServiceVehicleResponse.from(await this.vehicles.exit(id));
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'The service vehicles inside now, newest first' })
  @ApiOkResponse({ type: ListOf(ServiceVehicleResponse) })
  async inside(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ServiceVehicleResponse>> {
    return toList(await this.vehicles.inside(q), (v) =>
      ServiceVehicleResponse.from(v),
    );
  }
}

/** The management's log of service vehicles (ADR 0056). */
@ApiArea('gate')
@RequirePermissions('gate.read')
@Controller('staff/gate/service-vehicles')
export class StaffServiceVehiclesController {
  constructor(private readonly vehicles: ServiceVehiclesService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary:
      'The service vehicles that came in on the days asked, newest first',
  })
  @ApiOkResponse({ type: ListOf(ServiceVehicleResponse) })
  async log(
    @Query() q: ServiceVehicleLogQueryDto,
  ): Promise<ListResponse<ServiceVehicleResponse>> {
    return toList(await this.vehicles.log(q), (v) =>
      ServiceVehicleResponse.from(v),
    );
  }
}
