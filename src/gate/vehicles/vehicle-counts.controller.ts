import { Body, Controller, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { CountVehicleDto } from './dto/vehicle-counts.dto';
import { VehicleCountsService } from './vehicle-counts.service';
import { VehicleCountedView } from './views/vehicle-counts.views';

/** A resident vehicle through the gate, counted (ADR 0056). */
@ApiArea('vehicles')
@RequirePermissions('gate.operate')
@Controller('gate/vehicle-passages')
export class VehicleCountsController {
  constructor(private readonly counts: VehicleCountsService) {}

  @Post()
  @NoStore()
  // The hash leaves the body out: a compound has few vehicles to try.
  @Idempotent({ bodyless: true })
  @ApiOperation({
    summary: 'Count a resident vehicle in or out at my gate',
    description:
      'Inside a shift at a gate, for a vehicle the plate lookup found. Only the day’s count for the gate and the direction grows: the vehicle is checked, never kept, and nothing logs who came or went.',
  })
  @ApiCreatedResponse({ type: VehicleCountedView })
  async count(@Body() dto: CountVehicleDto): Promise<VehicleCountedView> {
    return this.counts.count(dto.vehicleId, dto.direction);
  }
}
