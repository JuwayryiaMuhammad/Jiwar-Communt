import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { AvailabilityService } from './availability.service';
import {
  SetAvailabilityDto,
  SetTechnicianAvailabilityDto,
} from './dto/availability.dto';
import { AvailabilityView } from './views/availability.views';

/** The technician's own availability (ADR 0033). */
@ApiArea('technician')
@RequirePermissions('tickets.work')
@Controller('technician/availability')
export class TechnicianAvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @ApiOkResponse({ type: AvailabilityView })
  async get(): Promise<AvailabilityView> {
    return AvailabilityView.from(await this.availability.mine());
  }

  /** Setting the state it already has changes nothing. */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AvailabilityView })
  async set(@Body() dto: SetAvailabilityDto): Promise<AvailabilityView> {
    return AvailabilityView.from(await this.availability.setMine(dto.state));
  }
}

/** A dispatcher sets a technician's availability, with a reason (ADR 0033). */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/technicians')
export class DispatchAvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Post(':id/availability')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AvailabilityView })
  async set(
    @Param('id', parseId()) id: string,
    @Body() dto: SetTechnicianAvailabilityDto,
  ): Promise<AvailabilityView> {
    return AvailabilityView.from(
      await this.availability.setFor(id, dto.state, dto.reasonCode),
    );
  }
}
