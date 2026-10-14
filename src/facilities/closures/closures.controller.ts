import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ClosuresService } from './closures.service';
import {
  ClosuresQueryDto,
  CreateClosureDto,
  LiftClosureDto,
} from './dto/closures.dto';
import {
  FacilityClosureCreatedView,
  FacilityClosureView,
} from './views/closure.views';

/** A facility's closures, for the staff (ADR 0044). */
@ApiArea('facilities')
@Controller('staff/facilities')
export class FacilityClosuresController {
  constructor(private readonly closures: ClosuresService) {}

  @Get(':id/closures')
  @NoStore()
  @RequireAnyPermission('facilities.manage', 'bookings.handle')
  @ApiOperation({ summary: 'List a facility’s closures, latest first' })
  @ApiOkResponse({ type: ListOf(FacilityClosureView) })
  async list(
    @Param('id', parseId()) id: string,
    @Query() q: ClosuresQueryDto,
  ): Promise<ListResponse<FacilityClosureView>> {
    return toList(await this.closures.list(id, q), (c) =>
      FacilityClosureView.from(c),
    );
  }

  @Post(':id/closures')
  @NoStore()
  @RequirePermissions('facilities.manage')
  @ApiOperation({
    summary: 'Close a facility for a time',
    description:
      'Cancels every booking of the facility that holds a place in the window and has not started, and tells each booker.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: FacilityClosureCreatedView })
  async create(
    @Param('id', parseId()) id: string,
    @Body() dto: CreateClosureDto,
  ): Promise<FacilityClosureCreatedView> {
    const { closure, cancelled } = await this.closures.create(id, dto);
    return {
      ...FacilityClosureView.from(closure),
      cancelledBookings: cancelled,
    };
  }
}

/** Lifting a closure (ADR 0044). */
@ApiArea('facilities')
@RequirePermissions('facilities.manage')
@Controller('staff/facility-closures')
export class ClosuresController {
  constructor(private readonly closures: ClosuresService) {}

  @Post(':id/lift')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({
    summary: 'Lift a closure, with a reason code',
    description:
      'Once (FACILITY_CLOSURE_LIFTED). What it cancelled stays cancelled.',
  })
  @ApiNoContentResponse()
  async lift(
    @Param('id', parseId()) id: string,
    @Body() dto: LiftClosureDto,
  ): Promise<void> {
    await this.closures.lift(id, dto.reasonCode);
  }
}
