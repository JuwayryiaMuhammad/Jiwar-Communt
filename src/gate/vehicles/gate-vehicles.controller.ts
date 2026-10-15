import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { withParams } from '../../core/common/validation/validation-errors';
import { PlateLookupService } from './plate-lookup.service';
import {
  GuardVisitorParkingView,
  PlateLookupView,
} from './views/plate-lookup.views';

export class PlateLookupDto {
  @ApiProperty({
    type: String,
    description:
      'As read off the car: spaces and the digits’ script do not matter (INVALID_FORMAT otherwise).',
  })
  @IsString()
  @Length(1, 40, withParams({ min: 1, max: 40 }))
  plate: string;
}

/**
 * The guard's vehicles and visitor parking (ADR 0045), `gate.operate`,
 * inside an open shift. A plate goes in a body, never in a URL.
 */
@ApiArea('gate')
@RequirePermissions('gate.operate')
@Controller('gate')
export class GateVehiclesController {
  constructor(private readonly lookups: PlateLookupService) {}

  @Post('plate-lookup')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary:
      'Look a plate up: the units’ vehicles and the visitors’ passes carrying it',
    description:
      'The permit’s status, or whether the pass lets its visitor in now and their parking. Never a name. Rate-limited with verify; audited without the plate.',
  })
  @ApiOkResponse({ type: PlateLookupView })
  async lookup(@Body() dto: PlateLookupDto): Promise<PlateLookupView> {
    return PlateLookupView.from(await this.lookups.lookup(dto.plate));
  }

  @Get('visitor-parking')
  @NoStore()
  @ApiOperation({
    summary:
      'List the visitor parking bookings holding now or starting within two hours',
  })
  @ApiOkResponse({ type: ListOf(GuardVisitorParkingView) })
  async visitorParking(): Promise<ListResponse<GuardVisitorParkingView>> {
    return bounded(await this.lookups.visitorParking(), (b) =>
      GuardVisitorParkingView.from(b),
    );
  }
}
